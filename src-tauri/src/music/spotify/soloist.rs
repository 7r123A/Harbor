//! Spotify Soloist managed process, credentials, connection status and native playback adapter.
use super::keystore;
pub mod playback;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const KEY: &str = "harbor.spotify.soloist.v1.apiKey";
const PATH: &str = "harbor.spotify.soloist.v1.executable";
const ENGINE: &str = "harbor.spotify.soloist.v1.engine";
const DEVICE_NAME: &str = "Harbor Soloist";

static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
fn child() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoloistStatus {
    pub preferred_engine: &'static str,
    pub executable_path: Option<String>,
    pub key_configured: bool,
    pub active_in_harbor: bool,
    pub active_playback_engine: Option<&'static str>,
    pub active_playback_live: bool,
    pub running: bool,
    pub api_ready: bool,
    pub logged_in: bool,
    pub device_name: Option<String>,
    pub error: Option<String>,
}

fn selected_engine(saved: Option<&str>) -> &'static str {
    // Soloist is the recommended default for newly enabled Spotify connections.
    // A user-selected Librespot preference still wins on later launches.
    match saved {
        Some("librespot") => "librespot",
        _ => "soloist",
    }
}

pub(crate) fn engine(app: &AppHandle) -> &'static str {
    selected_engine(keystore::read(app, ENGINE).as_deref())
}

fn executable(app: &AppHandle) -> Option<PathBuf> {
    keystore::read(app, PATH).map(PathBuf::from)
}

fn validate_executable(path: &Path) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path)
        .map_err(|_| "Select the extracted Spotify Soloist executable.".to_owned())?;
    if !path.is_file() {
        return Err("The selected Soloist path is not a file.".into());
    }
    let expected = if cfg!(windows) {
        "soloist.exe"
    } else {
        "soloist"
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !name.eq_ignore_ascii_case(expected) {
        return Err(format!("Select the official {expected} executable."));
    }
    Ok(path)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "App data directory unavailable")?
        .join("spotify-soloist"))
}
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "App cache directory unavailable")?
        .join("spotify-soloist"))
}

/// The address is deliberately *not* taken from ws.addr: only 127.0.0.1
/// is permitted. The port belongs to the process launched by Harbor.
fn endpoint(data: &Path) -> Option<String> {
    let addr = std::fs::read_to_string(data.join("ws.addr")).ok()?;
    if addr.trim() != "127.0.0.1" {
        return None;
    }
    let port: u16 = std::fs::read_to_string(data.join("ws.port"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if port == 0 {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}"))
}

fn running() -> bool {
    let Ok(mut guard) = child().lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(process) => match process.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

/// One short-lived WebSocket handshake; never expose the unauthenticated API
/// through the webview or bind to an address accessible over the network.
async fn auth_state(url: &str) -> Result<(bool, Option<String>), String> {
    let connect = tokio::time::timeout(
        Duration::from_secs(2),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .map_err(|_| "Soloist WebSocket connection timed out".to_owned())?
    .map_err(|_| "Cannot connect to Soloist's local WebSocket".to_owned())?;
    let (mut socket, _) = connect;
    let event = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .map_err(|_| "Soloist did not send an authentication event".to_owned())?
        .ok_or_else(|| "Soloist closed its WebSocket".to_owned())?
        .map_err(|_| "Soloist WebSocket message failed".to_owned())?;
    let data: serde_json::Value = serde_json::from_str(
        event
            .to_text()
            .map_err(|_| "Invalid Soloist authentication frame")?,
    )
    .map_err(|_| "Invalid Soloist authentication payload")?;
    if data["type"] != "auth_state" {
        return Err("Soloist did not report authentication state".into());
    }
    let logged_in = data["logged_in"]
        .as_bool()
        .ok_or("Incomplete Soloist authentication state")?;
    let name = data["device_name"].as_str().map(str::to_owned);
    Ok((logged_in, name))
}

#[tauri::command]
pub async fn music_soloist_status(app: AppHandle) -> Result<SoloistStatus, String> {
    let active = running();
    let music = app.state::<crate::music::MusicState>();
    let (active_playback_engine, active_playback_live) = match music.active_engine() {
        crate::music::ACTIVE_SOLOIST => (
            Some("soloist"),
            playback::snapshot().is_some_and(|playback| playback.live),
        ),
        crate::music::ACTIVE_SPOTIFY => {
            (Some("librespot"), music.spotify.playback_state().await.live)
        }
        _ => (None, false),
    };
    let mut status = SoloistStatus {
        preferred_engine: engine(&app),
        executable_path: executable(&app).map(|path| path.to_string_lossy().into_owned()),
        key_configured: keystore::read(&app, KEY).is_some(),
        active_in_harbor: playback::snapshot().is_some_and(|p| p.live),
        active_playback_engine,
        active_playback_live,
        running: active,
        api_ready: false,
        logged_in: false,
        device_name: None,
        error: None,
    };
    if active {
        match data_dir(&app).ok().and_then(|folder| endpoint(&folder)) {
            Some(url) => match auth_state(&url).await {
                Ok((logged_in, device_name)) => {
                    status.api_ready = true;
                    status.logged_in = logged_in;
                    status.device_name = device_name;
                }
                Err(message) => status.error = Some(message),
            },
            None => status.error = Some("Soloist's local API is starting or unavailable.".into()),
        }
    }
    Ok(status)
}

#[tauri::command]
pub fn music_soloist_configure(
    app: AppHandle,
    executable_path: Option<String>,
    api_key: Option<String>,
) -> Result<(), String> {
    if running() {
        return Err("Stop Soloist before updating its setup.".into());
    }
    if let Some(path) = executable_path {
        let verified = validate_executable(Path::new(path.trim()))?;
        keystore::write(&app, PATH, Some(&verified.to_string_lossy()))?;
    }
    if let Some(key) = api_key {
        let key = key.trim();
        if key.len() > 4096 || key.chars().any(char::is_control) {
            return Err("Invalid Soloist API key.".into());
        }
        keystore::write(&app, KEY, if key.is_empty() { None } else { Some(key) })?;
    }
    Ok(())
}

// A remote Spotify Connect session may be playing on a different device.
// Never silently switch its target or pause it without confirming the exact
// selected device; a stale confirmation cannot authorize a newer selection.
fn require_remote_confirmation(
    selected_remote: Option<&str>,
    confirmed_remote: Option<&str>,
) -> Result<(), String> {
    match selected_remote {
        Some(selected) if Some(selected) != confirmed_remote => {
            Err("Confirm switching away from the currently selected Spotify Connect device.".into())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn music_soloist_set_engine(
    app: AppHandle,
    state: tauri::State<'_, crate::music::MusicState>,
    engine: String,
    remote_device_confirmation: Option<String>,
) -> Result<(), String> {
    if engine != "librespot" && engine != "soloist" {
        return Err("Unsupported Spotify playback engine.".into());
    }
    // Choosing a *local* playback engine must actually select that engine.
    // Previously a persisted remote Connect target silently overrode both
    // options, so a stale/unreachable remote device made both appear broken.
    // A remote target can still be deliberately selected again afterwards.
    let selected_remote = state.spotify.remote_device();
    require_remote_confirmation(
        selected_remote.as_deref(),
        remote_device_confirmation.as_deref(),
    )?;
    if selected_remote.is_some() {
        state.spotify.set_remote_device(None).await?;
    }
    keystore::write(&app, ENGINE, Some(&engine))
}

#[tauri::command]
pub async fn music_soloist_start(app: AppHandle) -> Result<SoloistStatus, String> {
    if running() {
        return music_soloist_status(app).await;
    }
    let executable = executable(&app).ok_or("Choose the downloaded Soloist executable first.")?;
    let executable = validate_executable(&executable)?;
    let key = keystore::read(&app, KEY).ok_or("Add your personal Spotify Soloist API key.")?;
    let data = data_dir(&app)?;
    let cache = cache_dir(&app)?;
    std::fs::create_dir_all(&data).map_err(|_| "Cannot create Soloist data directory")?;
    std::fs::create_dir_all(&cache).map_err(|_| "Cannot create Soloist cache directory")?;
    // Remove discovery data left by an earlier crashed process. A fresh
    // managed child must publish its own port before we connect to it.
    for name in ["ws.addr", "ws.port"] {
        let _ = std::fs::remove_file(data.join(name));
    }
    let mut command = Command::new(executable);
    command.args([
        "--device-name",
        DEVICE_NAME,
        "--api-key",
        &key,
        "--ws",
        "127.0.0.1:0",
    ]);
    command.arg("--data-dir").arg(&data);
    command.arg("--cache-dir").arg(&cache);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    {
        // Keep std::sync::MutexGuard out of the async state machine: Tauri
        // commands require Send futures and this guard must never span an await.
        let mut guard = child()
            .lock()
            .map_err(|_| "Soloist process manager unavailable")?;
        if guard.is_none() {
            *guard = Some(
                command
                    .spawn()
                    .map_err(|_| "Failed to start the Soloist executable")?,
            );
        }
    }
    // A restarted daemon has a new port; never reuse the old control socket.
    playback::reset_control().await;
    // Don't wait for Spotify Connect pairing; users must complete that in
    // the Spotify app. Just give Soloist a short window to initialize its API.
    for _ in 0..16 {
        if !running() {
            return Err(
                "Soloist exited during startup. Check your API key and install a current build."
                    .into(),
            );
        }
        if endpoint(&data).is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    music_soloist_status(app).await
}

/// Forcefully release Soloist's audio output when its WebSocket cannot stop it.
/// Keep the child handle on a failed kill rather than reporting a false stop.
pub fn terminate_managed() -> Result<(), String> {
    playback::shutdown();
    let mut slot = child()
        .lock()
        .map_err(|_| "Soloist process manager unavailable")?;
    if let Some(mut process) = slot.take() {
        if process.kill().is_err() && !matches!(process.try_wait(), Ok(Some(_))) {
            *slot = Some(process);
            return Err(
                "Could not stop the Soloist process; close it before playing another source."
                    .into(),
            );
        }
        let _ = process.wait();
    }
    Ok(())
}

pub fn shutdown() {
    let _ = terminate_managed();
}

#[tauri::command]
pub fn music_soloist_stop() -> Result<(), String> {
    if playback::snapshot().is_some_and(|state| state.live) {
        return Err("Stop the current Harbor track before shutting down Soloist.".into());
    }
    terminate_managed()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn soloist_is_default_but_explicit_librespot_selection_is_retained() {
        assert_eq!(selected_engine(None), "soloist");
        assert_eq!(selected_engine(Some("soloist")), "soloist");
        assert_eq!(selected_engine(Some("librespot")), "librespot");
    }

    #[test]
    fn switching_from_remote_connect_requires_confirmation_of_exact_device() {
        assert!(require_remote_confirmation(None, None).is_ok());
        assert!(require_remote_confirmation(Some("living-room"), None).is_err());
        assert!(require_remote_confirmation(Some("living-room"), Some("bedroom")).is_err());
        assert!(require_remote_confirmation(Some("living-room"), Some("living-room")).is_ok());
    }

    #[test]
    fn rejects_non_soloist_executable_and_nonexistent_files() {
        assert!(validate_executable(Path::new("does-not-exist-soloist.exe")).is_err());
        assert!(validate_executable(Path::new("Cargo.toml")).is_err());
    }
    #[test]
    fn rejects_non_local_and_invalid_websocket_port() {
        let folder =
            std::env::temp_dir().join(format!("harbor-soloist-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("ws.addr"), "0.0.0.0").unwrap();
        std::fs::write(folder.join("ws.port"), "9090").unwrap();
        assert_eq!(endpoint(&folder), None);
        std::fs::write(folder.join("ws.addr"), "127.0.0.1").unwrap();
        assert_eq!(endpoint(&folder), Some("ws://127.0.0.1:9090".into()));
        std::fs::write(folder.join("ws.port"), "0").unwrap();
        assert_eq!(endpoint(&folder), None);
        std::fs::remove_dir_all(folder).unwrap();
    }
}
