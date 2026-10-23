use serde::Serialize;

use crate::error::AppResult;
use crate::secrets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStorageStatus {
    pub available: bool,
    pub scheme: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPayload {
    pub payload: String,
    pub scheme: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    pub value: String,
}

#[tauri::command]
pub fn secrets_status() -> SecretStorageStatus {
    SecretStorageStatus {
        available: secrets::available(),
        scheme: secrets::scheme().to_string(),
    }
}

#[tauri::command]
pub fn secrets_protect(value: String) -> AppResult<SecretPayload> {
    let payload = secrets::protect(&value).map_err(crate::error::AppError::InvalidRequest)?;
    Ok(SecretPayload {
        payload,
        scheme: secrets::scheme().to_string(),
    })
}

#[tauri::command]
pub fn secrets_unprotect(payload: String) -> AppResult<RevealedSecret> {
    let value = secrets::unprotect(&payload).map_err(crate::error::AppError::InvalidRequest)?;
    Ok(RevealedSecret { value })
}
