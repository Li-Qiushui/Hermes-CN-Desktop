use base64::engine::general_purpose::STANDARD;
use base64::Engine;

pub const SCHEME_DPAPI: &str = "dpapi";
pub const SCHEME_NONE: &str = "none";

pub fn available() -> bool {
    cfg!(target_os = "windows")
}

pub fn scheme() -> &'static str {
    if available() {
        SCHEME_DPAPI
    } else {
        SCHEME_NONE
    }
}

pub fn protect(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("待加密内容为空".to_string());
    }
    protect_impl(value.as_bytes())
}

pub fn unprotect(payload: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| "密文格式无效".to_string())?;
    let plain = unprotect_impl(&bytes)?;
    String::from_utf8(plain).map_err(|_| "密文解密结果不是合法文本".to_string())
}

#[cfg(target_os = "windows")]
fn protect_impl(data: &[u8]) -> Result<String, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input_bytes = data.to_vec();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len() as u32,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "DPAPI 加密失败（Windows 错误码 {}）",
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
        ));
    }
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(STANDARD.encode(encrypted))
}

#[cfg(target_os = "windows")]
fn unprotect_impl(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input_bytes = data.to_vec();
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: input_bytes.len() as u32,
        pbData: input_bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "DPAPI 解密失败（Windows 错误码 {}）",
            std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
        ));
    }
    let plain = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(plain)
}

#[cfg(not(target_os = "windows"))]
fn protect_impl(_data: &[u8]) -> Result<String, String> {
    Err("本系统未启用加密存储".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_impl(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("本系统未启用加密存储".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_when_available() {
        if !available() {
            return;
        }
        let payload = protect("sk-test-token").expect("protect");
        assert_ne!(payload, "sk-test-token");
        assert_eq!(unprotect(&payload).expect("unprotect"), "sk-test-token");
    }

    #[test]
    fn rejects_empty_input() {
        assert!(protect("").is_err());
    }

    #[test]
    fn rejects_broken_payload() {
        assert!(unprotect("not-base64!!").is_err());
    }
}
