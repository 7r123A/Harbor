use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Child;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::cast_transcode::{CastJob, SharedStats};

const SEGMENT_WAIT_MAX: Duration = Duration::from_secs(25);
const SEGMENT_POLL_INTERVAL: Duration = Duration::from_millis(150);
/// Segments this far behind the newest one a receiver asked for are deleted.
const SEGMENTS_KEPT_BEHIND: u32 = 30;

#[derive(Clone, Debug)]
struct Variant {
    width: u32,
    height: u32,
    fps: f64,
    bandwidth: u64,
    codecs: String,
}

struct HlsSession {
    variant: Variant,
    temp_dir: PathBuf,
    last_access: std::sync::Mutex<Instant>,
    process: Mutex<Option<Child>>,
    newest_requested: AtomicU32,
    /// Segments below this number were deleted; the playlist stops listing them.
    pruned_below: AtomicU32,
}

fn touch(session: &HlsSession) {
    if let Ok(mut t) = session.last_access.lock() {
        *t = Instant::now();
    }
}

async fn stop_session_resources(session: Arc<HlsSession>) {
    let child = { session.process.lock().await.take() };
    if let Some(mut child) = child {
        if let Err(error) = child.start_kill() {
            eprintln!("[cast-hls] ffmpeg termination request failed: {error}");
        }
        if let Err(error) = child.wait().await {
            eprintln!("[cast-hls] ffmpeg reap failed: {error}");
        }
    }
    if let Err(error) = tokio::fs::remove_dir_all(&session.temp_dir).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[cast-hls] temporary session cleanup failed: {error}");
        }
    }
}

#[derive(Clone)]
pub struct HlsState {
    sessions: Arc<RwLock<HashMap<String, Arc<HlsSession>>>>,
}

impl HlsState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Starts converting `job` into an HLS event playlist and returns the session id.
    pub async fn register_job(&self, job: CastJob) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        let temp_dir = std::env::temp_dir().join(format!("harbor-hls-{}", id));
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("mkdir: {}", e))?;
        let child = match spawn_continuous_ffmpeg(&job, &temp_dir).await {
            Ok(child) => child,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&temp_dir).await;
                return Err(error);
            }
        };
        let session = Arc::new(HlsSession {
            variant: Variant {
                width: job.plan.width,
                height: job.plan.height,
                fps: job.plan.fps,
                bandwidth: job.plan.bandwidth,
                codecs: job.plan.hls_codecs.clone(),
            },
            temp_dir,
            last_access: std::sync::Mutex::new(Instant::now()),
            process: Mutex::new(Some(child)),
            newest_requested: AtomicU32::new(0),
            pruned_below: AtomicU32::new(0),
        });
        self.sessions.write().await.insert(id.clone(), session);
        eprintln!("[cast-hls] session {} registered, seek={:.1}s", id, job.seek_sec);
        Ok(id)
    }

    pub async fn stop_session(&self, id: &str) -> bool {
        let session = { self.sessions.write().await.remove(id) };
        let Some(session) = session else {
            return false;
        };
        stop_session_resources(session).await;
        true
    }

    pub async fn stop_all(&self) -> usize {
        let sessions: Vec<Arc<HlsSession>> = {
            let mut map = self.sessions.write().await;
            map.drain().map(|(_, session)| session).collect()
        };
        for session in &sessions {
            stop_session_resources(session.clone()).await;
        }
        sessions.len()
    }

    pub async fn evict_idle(&self, idle: Duration) -> usize {
        let now = Instant::now();
        let stale: Vec<Arc<HlsSession>> = {
            let mut map = self.sessions.write().await;
            let stale_ids: Vec<String> = map
                .iter()
                .filter(|(_, s)| {
                    s.last_access
                        .lock()
                        .map(|t| now.duration_since(*t) > idle)
                        .unwrap_or(false)
                })
                .map(|(k, _)| k.clone())
                .collect();
            stale_ids
                .into_iter()
                .filter_map(|id| map.remove(&id))
                .collect()
        };
        for session in &stale {
            stop_session_resources(session.clone()).await;
        }
        stale.len()
    }
}

pub fn router(state: HlsState) -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route(
            "/cast/hls/{id}/master.m3u8",
            get(handle_master).options(handle_preflight),
        )
        .route(
            "/cast/hls/{id}/variant.m3u8",
            get(handle_variant).options(handle_preflight),
        )
        .route(
            "/cast/hls/{id}/{filename}",
            get(handle_segment).options(handle_preflight),
        )
        .with_state(state)
}

async fn handle_preflight() -> Response {
    let mut resp = Response::builder().status(StatusCode::NO_CONTENT);
    if let Some(h) = resp.headers_mut() {
        h.insert(
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        );
        h.insert(
            HeaderName::from_static("access-control-allow-methods"),
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        );
        h.insert(
            HeaderName::from_static("access-control-allow-headers"),
            HeaderValue::from_static("Content-Type, Accept-Encoding, Range, Origin"),
        );
        h.insert(
            HeaderName::from_static("access-control-max-age"),
            HeaderValue::from_static("86400"),
        );
    }
    resp.body(Body::empty())
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "preflight").into_response())
}

fn master_playlist(variant: &Variant) -> String {
    format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-INDEPENDENT-SEGMENTS\n\
         #EXT-X-STREAM-INF:BANDWIDTH={bw},AVERAGE-BANDWIDTH={bw},CODECS=\"{codecs}\",RESOLUTION={w}x{h},FRAME-RATE={fps:.3}\n\
         variant.m3u8\n",
        bw = variant.bandwidth,
        codecs = variant.codecs,
        w = variant.width,
        h = variant.height,
        fps = variant.fps,
    )
}

async fn handle_master(
    State(state): State<HlsState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("(no-origin)");
    eprintln!("[cast-hls] MASTER hit id={} origin={}", id, origin);
    let session = match state.sessions.read().await.get(&id).cloned() {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "session not found").into_response(),
    };
    touch(&session);
    playlist_response(master_playlist(&session.variant))
}

/// FFmpeg writes an event playlist that grows from the transcode's first segment. Receivers
/// otherwise join an open playlist near its live edge, which skips the start of the film and, with
/// a transcode running faster than real time, keeps skipping ahead.
fn start_at_beginning(playlist: &str) -> String {
    if playlist.contains("#EXT-X-START") {
        return playlist.to_string();
    }
    match playlist.find("#EXT-X-TARGETDURATION") {
        Some(at) => {
            let mut out = String::with_capacity(playlist.len() + 48);
            out.push_str(&playlist[..at]);
            out.push_str("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n");
            out.push_str(&playlist[at..]);
            out
        }
        None => playlist.to_string(),
    }
}

/// The playlist minus deleted segments. An EVENT playlist may never drop a segment, so once
/// pruning starts it is served as a plain live playlist whose media sequence starts at the oldest
/// segment still on disk; EXT-X-START (added after this) then points there instead of at a gap.
fn retained_playlist(playlist: &str, oldest_kept: u32) -> String {
    let mut out = String::with_capacity(playlist.len());
    let mut block = String::new();
    let mut in_segments = false;
    for line in playlist.lines() {
        if !in_segments {
            if line.starts_with("#EXT-X-PLAYLIST-TYPE") || line.starts_with("#EXT-X-MEDIA-SEQUENCE") {
                continue;
            }
            if line.starts_with("#EXTINF") {
                in_segments = true;
                out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{oldest_kept}\n"));
            } else {
                out.push_str(line);
                out.push('\n');
                continue;
            }
        }
        if line.starts_with("#EXT-X-ENDLIST") {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        block.push_str(line);
        block.push('\n');
        if !line.starts_with('#') && !line.trim().is_empty() {
            if segment_number(line.trim()).is_none_or(|n| n >= oldest_kept) {
                out.push_str(&block);
            }
            block.clear();
        }
    }
    out
}

async fn handle_variant(State(state): State<HlsState>, Path(id): Path<String>) -> Response {
    let session = match state.sessions.read().await.get(&id).cloned() {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "session not found").into_response(),
    };
    touch(&session);
    let playlist_path = session.temp_dir.join("playlist.m3u8");
    let deadline = std::time::Instant::now() + SEGMENT_WAIT_MAX;
    loop {
        if let Ok(content) = tokio::fs::read_to_string(&playlist_path).await {
            if content.contains("#EXTINF") {
                let pruned = session.pruned_below.load(Ordering::SeqCst);
                let listed = if pruned > 0 { retained_playlist(&content, pruned) } else { content };
                return playlist_response(start_at_beginning(&listed));
            }
        }
        if std::time::Instant::now() >= deadline {
            return (StatusCode::SERVICE_UNAVAILABLE, "playlist not ready").into_response();
        }
        if transcode_failed(&session).await {
            return (StatusCode::BAD_GATEWAY, "conversion failed").into_response();
        }
        tokio::time::sleep(SEGMENT_POLL_INTERVAL).await;
    }
}

/// True once FFmpeg has exited without producing what a receiver is waiting for.
async fn transcode_failed(session: &HlsSession) -> bool {
    let mut guard = session.process.lock().await;
    match guard.as_mut().map(|child| child.try_wait()) {
        Some(Ok(Some(status))) => !status.success(),
        _ => false,
    }
}

fn segment_number(filename: &str) -> Option<u32> {
    filename.strip_prefix("seg")?.strip_suffix(".ts")?.parse().ok()
}

/// Deletes segments well behind what the receiver plays so a long film does not fill the disk.
async fn prune_behind(session: &HlsSession, requested: u32) {
    let newest = session.newest_requested.fetch_max(requested, Ordering::SeqCst).max(requested);
    if newest <= SEGMENTS_KEPT_BEHIND || newest % 5 != 0 {
        return;
    }
    // Announced before the files go, so no playlist served from now on lists a deleted segment.
    session.pruned_below.fetch_max(newest - SEGMENTS_KEPT_BEHIND, Ordering::SeqCst);
    let Ok(mut entries) = tokio::fs::read_dir(&session.temp_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if let Some(n) = segment_number(&name.to_string_lossy()) {
            if n + SEGMENTS_KEPT_BEHIND < newest {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

/// Only a segment FFmpeg has finished and listed moves the pruning boundary, so a request for a
/// missing or future segment never deletes ones the receiver can still play.
async fn prune_after_serving(session: &HlsSession, filename: &str) {
    let Some(n) = segment_number(filename) else {
        return;
    };
    let Ok(playlist) = tokio::fs::read_to_string(session.temp_dir.join("playlist.m3u8")).await else {
        return;
    };
    if playlist.lines().any(|line| line.trim() == filename) {
        prune_behind(session, n).await;
    }
}

async fn handle_segment(
    State(state): State<HlsState>,
    Path((id, filename)): Path<(String, String)>,
) -> Response {
    if !filename.ends_with(".ts") {
        return (StatusCode::NOT_FOUND, "not a segment").into_response();
    }
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return (StatusCode::BAD_REQUEST, "bad name").into_response();
    }
    let session = match state.sessions.read().await.get(&id).cloned() {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "session not found").into_response(),
    };
    touch(&session);
    if let Some(n) = segment_number(&filename) {
        if n < session.pruned_below.load(Ordering::SeqCst) {
            return (StatusCode::GONE, "segment pruned").into_response();
        }
    }
    let path = session.temp_dir.join(&filename);
    let deadline = std::time::Instant::now() + SEGMENT_WAIT_MAX;
    loop {
        if path.is_file() {
            tokio::time::sleep(Duration::from_millis(80)).await;
            if let Ok(bytes) = tokio::fs::read(&path).await {
                if !bytes.is_empty() && bytes[0] == 0x47 {
                    prune_after_serving(&session, &filename).await;
                    return binary_response(bytes, "video/mp2t");
                }
            }
        }
        if std::time::Instant::now() >= deadline || transcode_failed(&session).await {
            eprintln!("[cast-hls] SEGMENT unavailable id={} filename={}", id, filename);
            return (StatusCode::SERVICE_UNAVAILABLE, "segment not ready").into_response();
        }
        tokio::time::sleep(SEGMENT_POLL_INTERVAL).await;
    }
}

fn playlist_response(body: String) -> Response {
    let bytes = body.into_bytes();
    let mut resp = Response::builder().status(StatusCode::OK);
    if let Some(h) = resp.headers_mut() {
        h.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/vnd.apple.mpegurl"),
        );
        h.insert(
            HeaderName::from_static("cache-control"),
            HeaderValue::from_static("no-cache"),
        );
        h.insert(
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        );
        h.insert(
            HeaderName::from_static("access-control-expose-headers"),
            HeaderValue::from_static("Content-Length, Content-Range"),
        );
        h.insert(
            HeaderName::from_static("content-length"),
            HeaderValue::from_str(&bytes.len().to_string()).unwrap(),
        );
    }
    resp.body(Body::from(bytes))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "build").into_response())
}

fn binary_response(bytes: Vec<u8>, content_type: &'static str) -> Response {
    let mut resp = Response::builder().status(StatusCode::OK);
    if let Some(h) = resp.headers_mut() {
        h.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static(content_type),
        );
        h.insert(
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        );
        h.insert(
            HeaderName::from_static("access-control-expose-headers"),
            HeaderValue::from_static("Content-Length, Content-Range"),
        );
        h.insert(
            HeaderName::from_static("accept-ranges"),
            HeaderValue::from_static("bytes"),
        );
        h.insert(
            HeaderName::from_static("content-length"),
            HeaderValue::from_str(&bytes.len().to_string()).unwrap(),
        );
    }
    resp.body(Body::from(bytes))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "build").into_response())
}

/// Drains FFmpeg's stderr into the session statistics and the log.
pub(crate) fn watch_stderr(stderr: tokio::process::ChildStderr, stats: SharedStats, tag: &'static str) {
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !crate::cast_transcode::note_progress_line(&stats, &line) {
                eprintln!("[{tag}][ffmpeg] {}", line);
            }
        }
        if let Ok(mut s) = stats.lock() {
            s.running = false;
        }
    });
}

async fn spawn_continuous_ffmpeg(job: &CastJob, temp_dir: &std::path::Path) -> Result<Child, String> {
    let ffmpeg = crate::transcode::locate_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())?;
    let caps = crate::cast_transcode::caps().await;
    let segment_pattern = temp_dir.join("seg%05d.ts");
    let playlist_path = temp_dir.join("playlist.m3u8");
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args(job.input_args(true, &caps))
        .args(&job.plan.output)
        .args([
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_segment_type",
            "mpegts",
            "-hls_playlist_type",
            "event",
            "-hls_list_size",
            "0",
            "-hls_flags",
            "independent_segments+temp_file",
            "-hls_segment_filename",
        ])
        .arg(&segment_pattern)
        .arg(&playlist_path);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    crate::proc_guard::configure_command(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    crate::proc_guard::adopt(&child);
    eprintln!(
        "[cast-hls] ffmpeg spawned for seek={:.1} video={} audio={}",
        job.seek_sec, job.plan.summary.video, job.plan.summary.audio
    );
    if let Some(stderr) = child.stderr.take() {
        watch_stderr(stderr, job.stats.clone(), "cast-hls");
    }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variant() -> Variant {
        Variant { width: 1920, height: 1080, fps: 23.976, bandwidth: 2_500_000, codecs: "avc1.640029,mp4a.40.2".into() }
    }

    fn session(temp_dir: PathBuf) -> Arc<HlsSession> {
        Arc::new(HlsSession {
            variant: variant(),
            temp_dir,
            last_access: std::sync::Mutex::new(Instant::now()),
            process: tokio::sync::Mutex::new(None),
            newest_requested: AtomicU32::new(0),
            pruned_below: AtomicU32::new(0),
        })
    }

    #[test]
    fn master_playlist_names_the_planned_codecs() {
        let body = master_playlist(&Variant { codecs: "avc1.640029,ac-3".into(), ..variant() });
        assert!(body.contains("CODECS=\"avc1.640029,ac-3\",RESOLUTION=1920x1080,FRAME-RATE=23.976"));
        assert!(body.ends_with("variant.m3u8\n"));
    }

    #[test]
    fn event_playlists_start_at_the_first_segment() {
        let p = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.0,\nseg00000.ts\n";
        let out = start_at_beginning(p);
        assert!(out.contains("#EXT-X-VERSION:3\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-TARGETDURATION:4"));
        assert_eq!(start_at_beginning(&out), out);
        assert_eq!(segment_number("seg00042.ts"), Some(42));
        assert_eq!(segment_number("playlist.m3u8"), None);
    }

    #[tokio::test]
    async fn old_segments_are_pruned_behind_the_receiver() {
        let temp_dir = std::env::temp_dir().join(format!("harbor-hls-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        for n in 0..40u32 {
            std::fs::write(temp_dir.join(format!("seg{n:05}.ts")), b"G").unwrap();
        }
        let s = session(temp_dir.clone());
        prune_behind(&s, 40).await;
        assert!(!temp_dir.join("seg00000.ts").exists());
        assert!(!temp_dir.join("seg00009.ts").exists());
        assert!(temp_dir.join("seg00010.ts").exists());
        assert_eq!(s.pruned_below.load(Ordering::SeqCst), 10);
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn missing_or_future_segment_requests_never_prune() {
        let temp_dir = std::env::temp_dir().join(format!("harbor-hls-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let mut playlist = String::from("#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
");
        for n in 0..40u32 {
            std::fs::write(temp_dir.join(format!("seg{n:05}.ts")), b"G").unwrap();
            playlist.push_str(&format!("#EXTINF:4.000000,
seg{n:05}.ts
"));
        }
        std::fs::write(temp_dir.join("playlist.m3u8"), &playlist).unwrap();
        // Written to disk but not listed yet: FFmpeg has not finished it.
        std::fs::write(temp_dir.join("seg00045.ts"), b"G").unwrap();
        let s = session(temp_dir.clone());
        prune_after_serving(&s, "seg01000.ts").await;
        prune_after_serving(&s, "seg00045.ts").await;
        assert_eq!(s.pruned_below.load(Ordering::SeqCst), 0);
        assert_eq!(s.newest_requested.load(Ordering::SeqCst), 0);
        assert!(temp_dir.join("seg00000.ts").exists());
        prune_after_serving(&s, "seg00035.ts").await;
        assert_eq!(s.pruned_below.load(Ordering::SeqCst), 5);
        assert!(!temp_dir.join("seg00004.ts").exists());
        assert!(temp_dir.join("seg00005.ts").exists());
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn the_playlist_never_lists_a_pruned_segment() {
        let mut p = String::from(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n",
        );
        for n in 0..14 {
            p.push_str(&format!("#EXTINF:4.000000,\nseg{n:05}.ts\n"));
        }
        let out = start_at_beginning(&retained_playlist(&p, 10));
        assert!(!out.contains("PLAYLIST-TYPE"), "an EVENT playlist cannot drop segments: {out}");
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:4.000000,\nseg00010.ts\n"), "{out}");
        assert!(!out.contains("seg00009.ts"), "{out}");
        assert!(out.contains("seg00013.ts") && out.contains("#EXT-X-START:TIME-OFFSET=0"), "{out}");
        assert_eq!(out.matches("#EXTINF").count(), 4);
    }

    #[tokio::test]
    async fn stop_session_removes_the_session_and_its_temp_dir() {
        let state = HlsState::new();
        let id = Uuid::new_v4().to_string();
        let temp_dir = std::env::temp_dir().join(format!("harbor-hls-test-{id}"));
        std::fs::create_dir_all(&temp_dir).expect("create test HLS directory");
        std::fs::write(temp_dir.join("segment.ts"), b"segment").expect("write test segment");
        state.sessions.write().await.insert(id.clone(), session(temp_dir.clone()));

        assert!(state.stop_session(&id).await);
        assert!(!temp_dir.exists());
        assert!(!state.stop_session(&id).await);
    }

    #[tokio::test]
    async fn stop_all_removes_every_session_and_is_idempotent() {
        let state = HlsState::new();
        let mut temp_dirs = Vec::new();
        for _ in 0..2 {
            let id = Uuid::new_v4().to_string();
            let temp_dir = std::env::temp_dir().join(format!("harbor-hls-test-{id}"));
            std::fs::create_dir_all(&temp_dir).expect("create test HLS directory");
            state.sessions.write().await.insert(id, session(temp_dir.clone()));
            temp_dirs.push(temp_dir);
        }

        assert_eq!(state.stop_all().await, 2);
        assert!(temp_dirs.iter().all(|path| !path.exists()));
        assert_eq!(state.stop_all().await, 0);
    }
}
