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
/// Length FFmpeg aims for. A converted stream has a keyframe every 2 s, so its segments are this
/// long and its target duration never grows.
const SEGMENT_SEC: u32 = 4;
/// Target duration of a stream whose video is copied: its own keyframes decide where segments
/// end, and x264/x265 place one at least every 250 frames (10.4 s at 23.976 fps).
const COPIED_TARGET_SEC: u32 = 11;

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
    /// EXT-X-TARGETDURATION served for the whole session. It only grows if FFmpeg ever reports a
    /// longer segment, which the floor chosen at registration is there to prevent.
    target_duration: AtomicU32,
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
            target_duration: AtomicU32::new(if job.plan.summary.video == "copy" {
                COPIED_TARGET_SEC
            } else {
                SEGMENT_SEC
            }),
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

/// Tags that describe the media segment after them, so they belong to its block.
fn is_segment_tag(line: &str) -> bool {
    [
        "#EXTINF",
        "#EXT-X-BYTERANGE",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-PROGRAM-DATE-TIME",
        "#EXT-X-GAP",
        "#EXT-X-BITRATE",
        "#EXT-X-DATERANGE",
    ]
    .iter()
    .any(|tag| line.starts_with(tag))
}

/// Tags that hold for every later segment until replaced: they outlive the segment they precede.
fn is_carried_tag(line: &str) -> bool {
    line.starts_with("#EXT-X-MAP") || line.starts_with("#EXT-X-KEY")
}

/// FFmpeg's target duration, or 0 when the playlist has none yet.
fn playlist_target_duration(playlist: &str) -> u32 {
    playlist
        .lines()
        .find_map(|line| line.trim().strip_prefix("#EXT-X-TARGETDURATION:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

/// The variant playlist exactly as receivers get it, on every request of the session.
///
/// FFmpeg writes an EVENT playlist, but segments well behind the receiver are deleted (see
/// [`prune_behind`]) and an EVENT playlist may never drop one. Switching the type once pruning
/// starts would change the playlist under a playing receiver, which strict players answer with an
/// error or a reset, so the playlist is always served the same way:
/// - as a live playlist with no EXT-X-PLAYLIST-TYPE, from the first response on;
/// - with EXT-X-MEDIA-SEQUENCE naming the first segment still listed;
/// - with the session's fixed EXT-X-TARGETDURATION (RFC 8216 6.2.1: it must not change);
/// - with EXT-X-START at offset 0, so receivers begin at the oldest listed segment instead of
///   joining near the live edge, which skips the film's start and, with a conversion running
///   faster than real time, keeps skipping ahead;
/// - keeping EXT-X-MAP and EXT-X-KEY even when the segment they preceded is gone, since every
///   later segment still depends on them.
fn served_playlist(playlist: &str, oldest_kept: u32, target_duration: u32) -> String {
    let mut header: Vec<String> = Vec::new();
    let mut body = String::with_capacity(playlist.len());
    let mut block: Vec<&str> = Vec::new();
    let mut carried: Vec<&str> = Vec::new();
    let mut first_kept: Option<u32> = None;
    let mut listed_any = false;
    let mut ended = false;
    let mut in_segments = false;
    for raw in playlist.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if !in_segments && !is_segment_tag(line) && line.starts_with('#') {
            if line.starts_with("#EXT-X-PLAYLIST-TYPE")
                || line.starts_with("#EXT-X-MEDIA-SEQUENCE")
                || line.starts_with("#EXT-X-START")
            {
                continue;
            }
            if line.starts_with("#EXT-X-TARGETDURATION") {
                header.push(format!("#EXT-X-TARGETDURATION:{target_duration}"));
            } else {
                header.push(line.to_string());
            }
            continue;
        }
        in_segments = true;
        if line.starts_with("#EXT-X-ENDLIST") {
            ended = true;
            continue;
        }
        if line.starts_with('#') {
            block.push(line);
            continue;
        }
        // A URI line closes the segment its tags described.
        let number = segment_number(line);
        if number.is_none_or(|n| n >= oldest_kept) {
            if !listed_any {
                listed_any = true;
                first_kept = number;
            }
            for tag in carried.drain(..).chain(block.drain(..)) {
                body.push_str(tag);
                body.push('\n');
            }
            body.push_str(line);
            body.push('\n');
        } else {
            for tag in block.drain(..) {
                if is_carried_tag(tag) {
                    // Only the latest of each kind still applies.
                    carried.retain(|kept| kept.split(':').next() != tag.split(':').next());
                    carried.push(tag);
                }
            }
        }
    }
    let sequence = format!("#EXT-X-MEDIA-SEQUENCE:{}", first_kept.unwrap_or(oldest_kept));
    let target_at = header.iter().position(|line| line.starts_with("#EXT-X-TARGETDURATION"));
    // The media sequence must precede the first segment and every tag of it, EXT-X-MAP included,
    // so it goes right after the target duration.
    match target_at {
        Some(at) => {
            header.insert(at + 1, sequence);
            header.insert(at, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES".into());
        }
        None => {
            let at = header.len().min(1);
            header.insert(at, sequence);
            header.insert(at, format!("#EXT-X-TARGETDURATION:{target_duration}"));
            header.insert(at, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES".into());
        }
    }
    let mut out = header.join("\n");
    out.push('\n');
    out.push_str(&body);
    if ended {
        out.push_str("#EXT-X-ENDLIST\n");
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
                let target = session_target_duration(&session, &content);
                return playlist_response(served_playlist(&content, pruned, target));
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

/// The session's target duration, raised (never lowered) to cover FFmpeg's own.
fn session_target_duration(session: &HlsSession, playlist: &str) -> u32 {
    let reported = playlist_target_duration(playlist);
    session.target_duration.fetch_max(reported, Ordering::SeqCst).max(reported)
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
    let stem = filename.strip_prefix("seg")?;
    stem.strip_suffix(".ts").or_else(|| stem.strip_suffix(".m4s"))?.parse().ok()
}

/// The fragmented-MP4 header every `.m4s` segment of an H.265 stream starts from.
const FMP4_INIT: &str = "init.mp4";

/// The content type of a finished segment, or None while FFmpeg is still writing it.
fn finished_segment_type(filename: &str, bytes: &[u8]) -> Option<&'static str> {
    if filename.ends_with(".ts") {
        return (bytes.first() == Some(&0x47)).then_some("video/mp2t");
    }
    // An MP4 file starts with a box: a 4-byte size, then a 4-letter type (ftyp, styp, moof).
    let boxed = bytes.len() >= 8 && bytes[4..8].iter().all(u8::is_ascii_alphanumeric);
    boxed.then_some("video/mp4")
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
    if segment_number(&filename).is_none() && filename != FMP4_INIT {
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
                if let Some(content_type) = finished_segment_type(&filename, &bytes) {
                    prune_after_serving(&session, &filename).await;
                    return binary_response(bytes, content_type);
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
    let fmp4 = job.plan.hls_fmp4;
    let segment_pattern = temp_dir.join(if fmp4 { "seg%05d.m4s" } else { "seg%05d.ts" });
    let playlist_path = temp_dir.join("playlist.m3u8");
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.args(job.input_args(true, &caps)).args(&job.plan.output);
    if fmp4 {
        // `hvc1` is the sample entry Apple's players require for H.265.
        cmd.args(["-tag:v", "hvc1", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", FMP4_INIT]);
    } else {
        cmd.args(["-hls_segment_type", "mpegts"]);
    }
    cmd.arg("-hls_time").arg(SEGMENT_SEC.to_string());
    cmd.args([
            "-f",
            "hls",
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
            target_duration: AtomicU32::new(SEGMENT_SEC),
        })
    }

    fn first_segment(playlist: &str) -> &str {
        playlist.lines().find(|line| !line.starts_with('#')).unwrap_or("")
    }

    /// FFmpeg's EVENT playlist with segments `0..count` of `extension`.
    fn ffmpeg_playlist(count: u32, extension: &str, header: &str) -> String {
        let mut p = format!(
            "#EXTM3U\n#EXT-X-VERSION:{}\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n{header}",
            if extension == "m4s" { 7 } else { 3 }
        );
        for n in 0..count {
            p.push_str(&format!("#EXTINF:4.004000,\nseg{n:05}.{extension}\n"));
        }
        p
    }

    #[test]
    fn master_playlist_names_the_planned_codecs() {
        let body = master_playlist(&Variant { codecs: "avc1.640029,ac-3".into(), ..variant() });
        assert!(body.contains("CODECS=\"avc1.640029,ac-3\",RESOLUTION=1920x1080,FRAME-RATE=23.976"));
        assert!(body.ends_with("variant.m3u8\n"));
    }

    #[test]
    fn mp4_segments_are_served_once_finished() {
        assert_eq!(segment_number("seg00042.m4s"), Some(42));
        assert_eq!(segment_number("init.mp4"), None);
        let moof = [0u8, 0, 0, 24, b'm', b'o', b'o', b'f'];
        assert_eq!(finished_segment_type("seg00001.m4s", &moof), Some("video/mp4"));
        assert_eq!(finished_segment_type(FMP4_INIT, &[0, 0, 0, 32, b'f', b't', b'y', b'p']), Some("video/mp4"));
        assert_eq!(finished_segment_type("seg00001.m4s", &[0, 0]), None);
        assert_eq!(finished_segment_type("seg00001.ts", &[0x47, 0x40]), Some("video/mp2t"));
        assert_eq!(finished_segment_type("seg00001.ts", &[0, 0]), None);
        // FFmpeg's fMP4 playlist: pruning keeps the header map every segment depends on.
        let p = ffmpeg_playlist(14, "m4s", "#EXT-X-MAP:URI=\"init.mp4\"\n");
        let out = served_playlist(&p, 10, 4);
        assert!(out.contains("#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.004000,\nseg00010.m4s\n"), "{out}");
        assert!(out.contains("#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n"), "{out}");
        assert!(out.find("MEDIA-SEQUENCE") < out.find("#EXT-X-MAP"), "the sequence precedes the map: {out}");
        assert!(!out.contains("seg00009.m4s"), "{out}");
    }

    #[test]
    fn playlists_start_at_the_first_listed_segment() {
        let out = served_playlist(&ffmpeg_playlist(1, "ts", ""), 0, 4);
        assert!(
            out.starts_with(
                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n"
            ),
            "{out}"
        );
        // Serving a served playlist again changes nothing: one EXT-X-START, one media sequence.
        assert_eq!(served_playlist(&out, 0, 4), out);
        assert_eq!(segment_number("seg00042.ts"), Some(42));
        assert_eq!(segment_number("playlist.m3u8"), None);
    }

    #[test]
    fn the_playlist_type_never_changes_during_a_session() {
        // Strict receivers (AVPlayer, the Chromecast receiver) reset when a reloaded playlist
        // changes type, so the first response must already look like the pruned ones.
        let before = served_playlist(&ffmpeg_playlist(12, "ts", ""), 0, 4);
        let after = served_playlist(&ffmpeg_playlist(80, "ts", ""), 45, 4);
        for out in [&before, &after] {
            assert!(!out.contains("PLAYLIST-TYPE"), "{out}");
            assert_eq!(out.matches("#EXT-X-MEDIA-SEQUENCE").count(), 1, "{out}");
            assert_eq!(out.matches("#EXT-X-TARGETDURATION:4\n").count(), 1, "{out}");
            assert_eq!(out.matches("#EXT-X-START").count(), 1, "{out}");
        }
        assert!(before.contains("#EXT-X-MEDIA-SEQUENCE:0\n") && first_segment(&before) == "seg00000.ts", "{before}");
        assert!(after.contains("#EXT-X-MEDIA-SEQUENCE:45\n") && first_segment(&after) == "seg00045.ts", "{after}");
        assert_eq!(before.matches("#EXTINF").count(), 12);
        assert_eq!(after.matches("#EXTINF").count(), 35);
        // The finished film keeps its end marker after the last segment.
        let ended = served_playlist(&format!("{}#EXT-X-ENDLIST\n", ffmpeg_playlist(80, "ts", "")), 45, 4);
        assert!(ended.ends_with("seg00079.ts\n#EXT-X-ENDLIST\n"), "{ended}");
    }

    #[test]
    fn the_media_sequence_names_the_first_segment_actually_listed() {
        // FFmpeg's playlist can lag the pruning boundary by a segment or two.
        let mut p = ffmpeg_playlist(0, "ts", "");
        for n in 12..20u32 {
            p.push_str(&format!("#EXTINF:4.004000,\r\nseg{n:05}.ts\r\n"));
        }
        let out = served_playlist(&p, 10, 4);
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:12\n"), "{out}");
        assert!(!out.contains('\r'), "{out}");
    }

    #[test]
    fn header_tags_of_a_dropped_segment_carry_over() {
        // A map or key in front of a deleted segment still applies to the ones after it.
        let mut p = ffmpeg_playlist(0, "m4s", "#EXT-X-MAP:URI=\"init.mp4\"\n");
        p.push_str("#EXTINF:4.0,\nseg00000.m4s\n");
        p.push_str("#EXT-X-MAP:URI=\"init1.mp4\"\n#EXTINF:4.0,\nseg00001.m4s\n");
        p.push_str("#EXT-X-MAP:URI=\"init2.mp4\"\n#EXTINF:4.0,\nseg00002.m4s\n#EXTINF:4.0,\nseg00003.m4s\n");
        let out = served_playlist(&p, 3, 4);
        assert!(out.contains("#EXT-X-MAP:URI=\"init2.mp4\"\n#EXTINF:4.0,\nseg00003.m4s\n"), "{out}");
        assert!(!out.contains("init1.mp4"), "only the latest map of the dropped ones still applies: {out}");
        // The header's own map is never dropped.
        assert!(out.contains("#EXT-X-MAP:URI=\"init.mp4\"\n"), "{out}");
    }

    #[test]
    fn the_target_duration_is_fixed_for_the_session() {
        let s = session(std::env::temp_dir());
        s.target_duration.store(COPIED_TARGET_SEC, Ordering::SeqCst);
        // A copied film whose early segments are short still announces the session's value.
        let early = ffmpeg_playlist(3, "ts", "");
        assert_eq!(session_target_duration(&s, &early), COPIED_TARGET_SEC);
        let out = served_playlist(&early, 0, session_target_duration(&s, &early));
        assert!(out.contains("#EXT-X-TARGETDURATION:11\n") && !out.contains("TARGETDURATION:4"), "{out}");
        // A longer segment than ever planned raises it once; it never drops back.
        let long = early.replace("#EXT-X-TARGETDURATION:4", "#EXT-X-TARGETDURATION:13");
        assert_eq!(session_target_duration(&s, &long), 13);
        assert_eq!(session_target_duration(&s, &early), 13);
        assert_eq!(playlist_target_duration("#EXTM3U\n"), 0);
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
        let mut playlist = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n");
        for n in 0..40u32 {
            std::fs::write(temp_dir.join(format!("seg{n:05}.ts")), b"G").unwrap();
            playlist.push_str(&format!("#EXTINF:4.000000,\nseg{n:05}.ts\n"));
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
        let out = served_playlist(&ffmpeg_playlist(14, "ts", ""), 10, 4);
        assert!(!out.contains("PLAYLIST-TYPE"), "an EVENT playlist cannot drop segments: {out}");
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:10\n") && first_segment(&out) == "seg00010.ts", "{out}");
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
