// Shared artifact helpers for the desktop's own update tracks (UI hot update
// packages): zip extraction with zip-slip guards, payload signature checks and
// Ed25519 verification, plus small path/version utilities.

use std::fs;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

const BAKED_PUBLIC_KEY_PEM: Option<&str> =
    option_env!("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM_DEFAULT");

const FALLBACK_PUBLIC_KEY_PEM: &str = concat!(
    "-----BEGIN PUBLIC KEY-----\n",
    "MCowBQYDK2VwAyEAqPkLQ4o67G2GMTgkQQQZXWwDBZM/4hqq5thSZSNhoC0=\n",
    "-----END PUBLIC KEY-----\n"
);


pub(crate) fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub(crate) fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

pub(crate) fn configured_public_key() -> Option<String> {
    // 0. User-editable `update-config.json` layer: `runtimePublicKeyPem`
    //    overrides the baked/fallback key. Only active when the file exists
    //    and parses, so the legacy cascade below is untouched otherwise.
    {
        if let Some(cfg) = crate::update_config::load_optional() {
            let pem = cfg.runtime_public_key_pem.trim().replace("\\n", "\n");
            if !pem.is_empty() {
                return Some(pem);
            }
        }
    }

    // 1. PEM via runtime env (highest precedence)
    if let Ok(direct) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM") {
        let pem = direct.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 2. PEM from a file path via runtime env
    if let Ok(file) = std::env::var("HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE") {
        if Path::new(&file).is_file() {
            return fs::read_to_string(&file).ok();
        }
    }
    // 3. Compile-time embedded PEM (baked into release builds via CI)
    if let Some(baked) = BAKED_PUBLIC_KEY_PEM {
        let pem = baked.trim().replace("\\n", "\n");
        if !pem.is_empty() {
            return Some(pem);
        }
    }
    // 4. Hardcoded fallback — the Eynzof/Hermes-CN-Core production key.
    Some(FALLBACK_PUBLIC_KEY_PEM.to_string())
}

pub(crate) fn file_sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Verify an Ed25519 signature over an arbitrary payload with a PEM-encoded
/// public key. Shared by the kernel manifest (12-field payload) and the UI
/// manifest (10-field payload) so both tracks trust the same baked key.
pub(crate) fn verify_payload_signature(
    payload: &[u8],
    signature_b64: &str,
    public_key_pem: &str,
) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::pkcs8::DecodePublicKey;
    use ed25519_dalek::{Signature, VerifyingKey};

    let key = VerifyingKey::from_public_key_pem(public_key_pem.trim())
        .map_err(|e| format!("Invalid public key PEM: {}", e))?;

    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("Invalid signature base64: {}", e))?;

    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| format!("Invalid signature: {}", e))?;

    key.verify_strict(payload, &signature)
        .map_err(|_| "Signature verification failed".to_string())
}

pub(crate) fn safe_version_segment(version: &str) -> Result<String, String> {
    const MAX_VERSION_SEGMENT_LEN: usize = 120;

    if version.is_empty() {
        return Err("runtimeVersion must not be empty".to_string());
    }
    if version == "." || version == ".." {
        return Err(format!(
            "runtimeVersion must be a normal path segment, got {version:?}"
        ));
    }
    if version.len() > MAX_VERSION_SEGMENT_LEN {
        return Err(format!(
            "runtimeVersion exceeds {MAX_VERSION_SEGMENT_LEN} bytes"
        ));
    }
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err(
            "runtimeVersion may only contain ASCII letters, digits, '.', '_', '+' and '-'"
                .to_string(),
        );
    }

    Ok(version.to_string())
}

const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ZIP_FILES: usize = 5_000;
const MAX_ZIP_TOTAL_BYTES: u64 = 500 * 1024 * 1024; // 500 MB

fn validate_zip_entry_counts(
    archive: &mut zip::ZipArchive<fs::File>,
) -> Result<(usize, usize), String> {
    let entry_count = archive.len();
    if entry_count > MAX_ZIP_ENTRIES {
        return Err(format!(
            "Zip contains {} entries (limit {})",
            entry_count, MAX_ZIP_ENTRIES
        ));
    }

    // ZipArchive::len() includes explicit directory records. The file limit
    // protects payload-bearing files and symlinks; directories remain bounded
    // separately by MAX_ZIP_ENTRIES. Counting both as files rejected the valid
    // cn.7 runtime (4011 files + 996 directory records).
    let mut file_count = 0usize;
    for index in 0..entry_count {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if !entry.is_dir() {
            file_count += 1;
        }
    }

    if file_count > MAX_ZIP_FILES {
        return Err(format!(
            "Zip contains {} files (limit {})",
            file_count, MAX_ZIP_FILES
        ));
    }

    Ok((entry_count, file_count))
}

/// Returns true when a symlink whose target is `target`, living in directory
/// `link_parent`, resolves to a path that stays inside `dest`. The target is
/// resolved purely lexically (no filesystem access, so it works before the
/// target exists): `.` is ignored and `..` pops the last real segment. Absolute
/// targets, and relative targets that climb above `dest`, are rejected. This
/// permits the `..`-into-subtree links shipped by Node.js (`bin/corepack` ->
/// `../lib/node_modules/...`) while still blocking zip-slip via symlink.
#[cfg(unix)]
fn symlink_target_within(dest: &Path, link_parent: &Path, target: &Path) -> bool {
    use std::path::Component;

    if target.is_absolute() {
        return false;
    }

    let mut resolved: Vec<Component> = link_parent.components().collect();
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match resolved.last() {
                // Only collapse against a real path segment; never climb past
                // the root we started from.
                Some(Component::Normal(_)) => {
                    resolved.pop();
                }
                _ => return false,
            },
            other => resolved.push(other),
        }
    }

    let resolved: PathBuf = resolved.iter().collect();
    resolved.starts_with(dest)
}

pub(crate) fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    validate_zip_entry_counts(&mut archive)?;

    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;

        // Prevent zip-slip: use enclosed_name() which rejects ".." and absolute paths
        let relative = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(format!(
                    "Refusing path traversal in zip: {:?}",
                    entry.name()
                ))
            }
        };
        let out_path = dest.join(&relative);
        if !out_path.starts_with(&dest) {
            return Err(format!("Path escapes destination: {:?}", relative));
        }

        #[cfg(unix)]
        let mode = entry.unix_mode();
        #[cfg(unix)]
        let is_symlink = mode.map(|m| (m & 0o170000) == 0o120000).unwrap_or(false);
        #[cfg(not(unix))]
        let is_symlink = false;

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            total_bytes += entry.size();
            if total_bytes > MAX_ZIP_TOTAL_BYTES {
                return Err(format!(
                    "Zip exceeds size limit ({} MB)",
                    MAX_ZIP_TOTAL_BYTES / 1024 / 1024
                ));
            }

            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            if is_symlink {
                #[cfg(unix)]
                {
                    let mut target_bytes = Vec::new();
                    entry
                        .read_to_end(&mut target_bytes)
                        .map_err(|e| e.to_string())?;
                    let target = String::from_utf8(target_bytes)
                        .map_err(|e| format!("Invalid UTF-8 symlink target: {}", e))?;
                    let target_path = Path::new(&target);

                    // Relative symlinks may legitimately use `..` to point at a
                    // sibling subtree — Node.js ships `bin/corepack` ->
                    // `../lib/node_modules/corepack/dist/corepack.js` (likewise
                    // npm/npx), and `Python.framework` is a web of such links.
                    // Resolve the target lexically against the link's own
                    // directory and reject only links that climb out of `dest`
                    // (or are absolute).
                    let link_parent = out_path.parent().unwrap_or(dest.as_path());
                    if !symlink_target_within(&dest, link_parent, target_path) {
                        return Err(format!("Refusing unsafe symlink target: {:?}", target));
                    }
                    std::os::unix::fs::symlink(target_path, &out_path)
                        .map_err(|e| e.to_string())?;
                }
                #[cfg(not(unix))]
                return Err("Zip symlink entries are only supported on Unix platforms".to_string());
            } else {
                let mut out_file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = mode {
                        fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if file_type.is_symlink() {
            let link_target = fs::read_link(entry.path()).map_err(|e| e.to_string())?;
            std::os::unix::fs::symlink(link_target, &target).map_err(|e| e.to_string())?;
            continue;
        }
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
