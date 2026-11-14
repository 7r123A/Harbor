//! "Add audio" for the player: attach another release's audio track (a dub, a separately saved
//! track) to the film that is playing, after checking it belongs to this film and re-timing it
//! onto this film's clock, and save any audio track of the film as a file.
//!
//! The analysis lives in [`crate::audio_align`]; this module runs FFmpeg around it. Pipes are read
//! with the standard library on blocking threads (see `process_output.rs` for why Tokio's adapter
//! is avoided on Windows), and every child is killed when its job is cancelled.

use crate::audio_align::{self, FeatureExtractor, Features, RefClip, Verdict, VerifyStats};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const PROGRESS_EVENT: &str = "external-audio://progress";
const NETWORK_CLIPS: usize = 16;
const NETWORK_CLIP_SEC: f64 = 30.0;
const CACHE_KEEP: usize = 6;
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub ordinal: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileInfo {
    pub duration_sec: f64,
    pub streams: Vec<AudioStreamInfo>,
    /// Language inferred from the file name when the streams carry no tag.
    pub guessed_language: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub job_id: String,
    pub reference_url: String,
    #[serde(default)]
    pub reference_headers: HashMap<String, String>,
    pub reference_ordinal: u32,
    pub reference_duration_sec: f64,
    pub external_path: String,
    pub external_ordinal: u32,
    #[serde(default)]
    pub keep_pitch: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub job_id: String,
    pub verdict: String,
    /// The re-timed track, absent when the audio does not belong to this film.
    pub output_path: Option<String>,
    pub offset_sec: f64,
    pub speed: f64,
    pub segments: usize,
    pub matched: usize,
    pub windows: usize,
    pub confidence: f32,
    pub verify_windows: usize,
    pub verify_median_ms: f64,
    pub verify_max_ms: f64,
    pub cached: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job_id: &'a str,
    stage: &'a str,
    progress: f32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub job_id: String,
    pub source_url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub ordinal: u32,
    pub dest_path: String,
    #[serde(default)]
    pub duration_sec: Option<f64>,
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct JobGuard(String);

impl JobGuard {
    fn start(id: &str) -> (Self, Arc<AtomicBool>) {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = jobs().lock() {
            if let Some(previous) = map.insert(id.to_string(), flag.clone()) {
                previous.store(true, Ordering::SeqCst);
            }
        }
        (JobGuard(id.to_string()), flag)
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = jobs().lock() {
            map.remove(&self.0);
        }
    }
}

fn is_http(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Accepts plain paths and `file://` URLs; anything else must be HTTP(S).
fn local_path(url: &str) -> Option<PathBuf> {
    if is_http(url) {
        return None;
    }
    if let Some(rest) = url.strip_prefix("file://") {
        let rest = rest.trim_start_matches('/');
        let decoded = percent_decode(rest);
        let candidate = if cfg!(windows) { PathBuf::from(decoded) } else { PathBuf::from(format!("/{decoded}")) };
        return Some(candidate);
    }
    if url.contains("://") {
        return None;
    }
    Some(PathBuf::from(url))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    // Hex digits are read from the bytes: slicing the &str would panic when a multibyte
    // character follows the '%' (as in "50%aé").
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn ffmpeg_path() -> Result<PathBuf, String> {
    crate::transcode::locate_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())
}

fn ffprobe_path() -> Result<PathBuf, String> {
    crate::transcode::locate_ffprobe().ok_or_else(|| "ffprobe not found".to_string())
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// HTTP-only input options. FFmpeg refuses to open a local file when they are present.
fn push_input(cmd: &mut Command, url: &str, headers: &HashMap<String, String>) {
    if is_http(url) {
        let ua = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| "Harbor".into());
        cmd.arg("-user_agent").arg(ua);
        let blob: String = headers
            .iter()
            .filter(|(k, _)| !k.eq_ignore_ascii_case("user-agent") && !k.contains(['\r', '\n']))
            .filter(|(_, v)| !v.contains(['\r', '\n']))
            .map(|(k, v)| format!("{k}: {v}\r\n"))
            .collect();
        if !blob.is_empty() {
            cmd.arg("-headers").arg(blob);
        }
        cmd.arg("-reconnect").arg("1").arg("-reconnect_streamed").arg("1").arg("-reconnect_delay_max").arg("4");
        // A connection that stays open but sends nothing would otherwise block the read forever.
        cmd.arg("-rw_timeout").arg("20000000");
    }
    cmd.arg("-i").arg(match local_path(url) {
        Some(path) => path.into_os_string(),
        None => url.into(),
    });
}

/// Kills the child when dropped unless it already exited.
struct Running(std::sync::Mutex<Child>);

impl Running {
    fn child(&self) -> std::sync::MutexGuard<'_, Child> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `work` (which reads the child's pipes) while a watchdog kills the child once the job
    /// is cancelled. A stalled input gives neither output nor progress lines, so the readers
    /// themselves never get to look at the flag; killing the child closes the pipes they wait on.
    fn watch_cancel<T>(&self, cancel: &AtomicBool, work: impl FnOnce() -> T) -> T {
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::SeqCst) {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = self.child().kill();
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            });
            let out = work();
            done.store(true, Ordering::SeqCst);
            out
        })
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let mut child = self.child();
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn spawn(mut cmd: Command) -> Result<Running, String> {
    hide_window(&mut cmd);
    crate::proc_guard::configure_std_command(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {e}"))?;
    crate::proc_guard::adopt_std(&child);
    Ok(Running(std::sync::Mutex::new(child)))
}

#[derive(Deserialize)]
struct ProbeOut {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    #[serde(default)]
    codec_name: Option<String>,
    #[serde(default)]
    channels: Option<u32>,
    #[serde(default)]
    sample_rate: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i64>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    #[serde(default)]
    duration: Option<String>,
}

fn probe_file(path: &Path) -> Result<AudioFileInfo, String> {
    let mut cmd = Command::new(ffprobe_path()?);
    cmd.arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("a")
        .arg("-show_entries")
        .arg("format=duration:stream=codec_name,channels,sample_rate:stream_tags:stream_disposition=default")
        .arg("-of")
        .arg("json")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let running = spawn(cmd)?;
    let mut text = String::new();
    let stdout = running.child().stdout.take();
    if let Some(mut out) = stdout {
        out.read_to_string(&mut text).map_err(|e| format!("ffprobe read: {e}"))?;
    }
    let parsed: ProbeOut = serde_json::from_str(&text).map_err(|_| "This file could not be read".to_string())?;
    let streams = parsed
        .streams
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let tag = |name: &str| {
                s.tags
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.trim().to_string())
                    .filter(|v| !v.is_empty() && v != "und")
            };
            AudioStreamInfo {
                ordinal: i as u32,
                codec: s.codec_name.unwrap_or_default(),
                channels: s.channels.unwrap_or(2),
                sample_rate: s.sample_rate.and_then(|r| r.parse().ok()).unwrap_or(48000),
                language: tag("language"),
                title: tag("title"),
                default: s.disposition.get("default").copied().unwrap_or(0) == 1,
            }
        })
        .collect::<Vec<_>>();
    if streams.is_empty() {
        return Err("This file has no audio".into());
    }
    let duration_sec = parsed
        .format
        .and_then(|f| f.duration)
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok(AudioFileInfo { duration_sec, streams, guessed_language: guess_language(path) })
}

/// Dubs downloaded from regional sites rarely carry a language tag; their names usually do.
fn guess_language(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)) || name.contains("arabic") || name.contains("مدبلج") {
        return Some("ara".into());
    }
    let tokens: HashSet<&str> = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    const MAP: &[(&[&str], &str)] = &[
        (&["ar", "ara", "arb"], "ara"),
        (&["en", "eng", "english"], "eng"),
        (&["fr", "fre", "fra", "french", "vf", "vff"], "fre"),
        (&["es", "spa", "spanish", "latino"], "spa"),
        (&["de", "ger", "deu", "german"], "ger"),
        (&["it", "ita", "italian"], "ita"),
        (&["pt", "por", "portuguese", "dublado"], "por"),
        (&["ru", "rus", "russian"], "rus"),
        (&["tr", "tur", "turkish"], "tur"),
        (&["hi", "hin", "hindi"], "hin"),
        (&["ja", "jpn", "japanese"], "jpn"),
        (&["ko", "kor", "korean"], "kor"),
    ];
    MAP.iter()
        .find(|(keys, _)| keys.iter().any(|k| tokens.contains(k)))
        .map(|(_, code)| code.to_string())
}

#[tauri::command]
pub async fn external_audio_probe(path: String) -> Result<AudioFileInfo, String> {
    let path = local_path(&path).ok_or("Choose a file on this computer")?;
    if !path.is_file() {
        return Err("File not found".into());
    }
    tauri::async_runtime::spawn_blocking(move || probe_file(&path))
        .await
        .map_err(|e| format!("probe task: {e}"))?
}

/// Decodes one audio stream to 8 kHz mono and feeds it to the feature extractor while it streams.
fn decode_features(
    url: &str,
    headers: &HashMap<String, String>,
    ordinal: u32,
    window: Option<(f64, f64)>,
    cancel: &AtomicBool,
    on_seconds: &mut dyn FnMut(f64),
) -> Result<Features, String> {
    let mut cmd = Command::new(ffmpeg_path()?);
    cmd.arg("-hide_banner").arg("-v").arg("error").arg("-nostdin");
    if let Some((start, _)) = window {
        cmd.arg("-ss").arg(format!("{start:.3}"));
    }
    push_input(&mut cmd, url, headers);
    if let Some((_, len)) = window {
        cmd.arg("-t").arg(format!("{len:.3}"));
    }
    cmd.arg("-map")
        .arg(format!("0:a:{ordinal}"))
        .args(["-vn", "-sn", "-dn", "-ac", "1", "-ar"])
        .arg(audio_align::PCM_RATE.to_string())
        .args(["-f", "f32le", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let running = spawn(cmd)?;
    let stderr = running.child().stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let mut out = running.child().stdout.take().ok_or("ffmpeg stdout missing")?;
    let mut extractor = FeatureExtractor::new();
    let total = running.watch_cancel(cancel, || -> Result<usize, String> {
        let mut buf = vec![0u8; 1 << 16];
        let mut carry: Vec<u8> = Vec::with_capacity(1 << 16);
        let mut samples: Vec<f32> = Vec::with_capacity(1 << 14);
        let mut total = 0usize;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let n = out.read(&mut buf).map_err(|e| format!("ffmpeg read: {e}"))?;
            if n == 0 {
                break;
            }
            carry.extend_from_slice(&buf[..n]);
            let whole = carry.len() / 4 * 4;
            samples.clear();
            samples.extend(carry[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
            carry.drain(..whole);
            extractor.push(&samples);
            total += samples.len();
            on_seconds(total as f64 / audio_align::PCM_RATE as f64);
        }
        Ok(total)
    });
    drop(out);
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let total = total?;
    let status = running.child().wait().map_err(|e| format!("ffmpeg wait: {e}"))?;
    let stderr = err_reader.join().unwrap_or_default();
    if total < audio_align::PCM_RATE as usize * 2 {
        let detail = stderr.lines().last().unwrap_or("").trim();
        return Err(if detail.is_empty() {
            format!("Could not read this audio track ({status})")
        } else {
            format!("Could not read this audio track: {detail}")
        });
    }
    Ok(extractor.finish())
}

/// A local reference is decoded whole; a network one contributes evenly spaced clips so the
/// analysis does not download the entire film.
fn reference_clips(
    req: &SyncRequest,
    cancel: &AtomicBool,
    progress: &(dyn Fn(f64) + Sync),
) -> Result<Vec<RefClip>, String> {
    let duration = req.reference_duration_sec.max(1.0);
    if !is_http(&req.reference_url) {
        let features = decode_features(
            &req.reference_url,
            &req.reference_headers,
            req.reference_ordinal,
            None,
            cancel,
            &mut |sec| progress((sec / duration).min(1.0)),
        )?;
        return Ok(vec![RefClip { start_sec: 0.0, features }]);
    }
    let starts: Vec<f64> = (0..NETWORK_CLIPS)
        .map(|i| duration * (0.04 + 0.92 * i as f64 / (NETWORK_CLIPS - 1) as f64))
        .filter(|s| s + NETWORK_CLIP_SEC <= duration)
        .collect();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<Result<RefClip, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = starts
            .chunks(starts.len().div_ceil(4).max(1))
            .map(|chunk| {
                let done = &done;
                let total = starts.len();
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|&start| {
                            let features = decode_features(
                                &req.reference_url,
                                &req.reference_headers,
                                req.reference_ordinal,
                                Some((start, NETWORK_CLIP_SEC)),
                                cancel,
                                &mut |_| {},
                            )?;
                            let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                            progress(finished as f64 / total as f64);
                            Ok(RefClip { start_sec: start, features })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let clips: Vec<RefClip> = results.into_iter().filter_map(Result::ok).collect();
    if clips.len() < 3 {
        return Err("Could not read enough of this film's audio".into());
    }
    Ok(clips)
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("harbor-synced-audio")
}

fn prune_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .filter(|(p, _)| p.extension().is_some_and(|x| x == "mka"))
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let now = std::time::SystemTime::now();
    for (i, (path, modified)) in files.iter().enumerate() {
        let old = now.duration_since(*modified).map(|age| age > CACHE_MAX_AGE).unwrap_or(false);
        if i >= CACHE_KEEP || old {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(path.with_extension("json"));
        }
    }
}

fn cache_key(req: &SyncRequest) -> String {
    use sha2::{Digest, Sha256};
    let meta = std::fs::metadata(&req.external_path).ok();
    let stamp = meta
        .as_ref()
        .map(|m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs())))
        .unwrap_or((0, None));
    let mut h = Sha256::new();
    h.update(req.reference_url.as_bytes());
    h.update(req.reference_ordinal.to_le_bytes());
    h.update(req.external_path.as_bytes());
    h.update(req.external_ordinal.to_le_bytes());
    h.update(stamp.0.to_le_bytes());
    h.update(stamp.1.unwrap_or(0).to_le_bytes());
    h.update([req.keep_pitch as u8, 2]);
    let digest = h.finalize();
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

fn layout_for(channels: u32) -> (&'static str, &'static str) {
    match channels {
        0 | 1 => ("mono", "192k"),
        2 => ("stereo", "448k"),
        _ => ("5.1", "640k"),
    }
}

/// Renders the re-timed track with AC-3: hundreds of times faster than real time, decoded by
/// every player and receiver Harbor supports, and transparent at these bit rates.
fn render(
    req: &SyncRequest,
    pieces: &[audio_align::Piece],
    channels: u32,
    out: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<(), String> {
    let (layout, bitrate) = layout_for(channels);
    let graph = audio_align::render_graph(pieces, req.external_ordinal, layout, 48000, req.keep_pitch)
        .ok_or("Nothing in this audio matches the film")?;
    let ext = local_path(&req.external_path).ok_or("Choose a file on this computer")?;
    let partial = out.with_extension("partial.mka");
    let mut cmd = Command::new(ffmpeg_path()?);
    cmd.arg("-hide_banner").arg("-v").arg("error").arg("-nostdin").arg("-y");
    for (ss, t) in &graph.inputs {
        cmd.arg("-ss").arg(format!("{ss:.6}")).arg("-t").arg(format!("{t:.6}")).arg("-i").arg(&ext);
    }
    cmd.arg("-filter_complex")
        .arg(&graph.filter)
        .arg("-map")
        .arg("[out]")
        .args(["-c:a", "ac3", "-b:a", bitrate, "-metadata:s:a:0"])
        .arg("title=Synced")
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(&partial)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let running = spawn(cmd)?;
    let stderr = running.child().stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let stdout = running.child().stdout.take();
    if let Some(stdout) = stdout {
        running.watch_cancel(cancel, || {
            for line in BufReader::new(stdout).lines() {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(line) = line else { break };
                if let Some(us) = line.strip_prefix("out_time_us=") {
                    if let Ok(us) = us.trim().parse::<f64>() {
                        progress((us / 1e6 / graph.duration.max(1.0)).clamp(0.0, 1.0));
                    }
                }
            }
        });
    }
    if cancel.load(Ordering::SeqCst) {
        drop(running);
        let _ = std::fs::remove_file(&partial);
        return Err("cancelled".into());
    }
    let status = running.child().wait().map_err(|e| format!("ffmpeg wait: {e}"))?;
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        let detail = stderr.lines().last().unwrap_or("").trim().to_string();
        return Err(format!("Could not write the synced audio: {detail}"));
    }
    std::fs::rename(&partial, out).map_err(|e| format!("save synced audio: {e}"))
}

fn run_sync(app: &AppHandle, req: &SyncRequest, cancel: &AtomicBool) -> Result<SyncResult, String> {
    let emit = |stage: &str, progress: f64| {
        let _ = app.emit(PROGRESS_EVENT, Progress { job_id: &req.job_id, stage, progress: progress as f32 });
    };
    sync_with_progress(&emit, req, cancel)
}

fn sync_with_progress(
    emit: &(dyn Fn(&str, f64) + Sync),
    req: &SyncRequest,
    cancel: &AtomicBool,
) -> Result<SyncResult, String> {
    let ext_path = local_path(&req.external_path).ok_or("Choose a file on this computer")?;
    if !ext_path.is_file() {
        return Err("File not found".into());
    }
    if !is_http(&req.reference_url) && local_path(&req.reference_url).is_none() {
        return Err("This source cannot be analysed".into());
    }
    let dir = cache_dir();
    let _ = std::fs::create_dir_all(&dir);
    prune_cache(&dir);
    let key = cache_key(req);
    let out = dir.join(format!("{key}.mka"));
    let meta = dir.join(format!("{key}.json"));
    if out.is_file() {
        if let Some(mut cached) = std::fs::read(&meta).ok().and_then(|b| serde_json::from_slice::<SyncResult>(&b).ok()) {
            cached.job_id = req.job_id.clone();
            cached.output_path = Some(out.to_string_lossy().into_owned());
            cached.cached = true;
            emit("done", 1.0);
            return Ok(cached);
        }
    }
    let info = probe_file(&ext_path)?;
    let stream = info
        .streams
        .get(req.external_ordinal as usize)
        .cloned()
        .ok_or("That audio track is not in the file")?;
    emit("decode", 0.0);
    let ext_progress = Mutex::new(0f64);
    let ref_progress = Mutex::new(0f64);
    let report = |which: &Mutex<f64>, value: f64| {
        if let Ok(mut v) = which.lock() {
            *v = value;
        }
        let a = ext_progress.lock().map(|v| *v).unwrap_or(0.0);
        let b = ref_progress.lock().map(|v| *v).unwrap_or(0.0);
        emit("decode", (a * 0.35 + b * 0.65) * 0.55);
    };
    let ext_duration = info.duration_sec.max(1.0);
    let (ext, clips) = std::thread::scope(|scope| {
        let ext = scope.spawn(|| {
            decode_features(
                &req.external_path,
                &HashMap::new(),
                req.external_ordinal,
                None,
                cancel,
                &mut |sec| report(&ext_progress, (sec / ext_duration).min(1.0)),
            )
        });
        let clips = reference_clips(req, cancel, &|p| report(&ref_progress, p));
        (ext.join().unwrap_or_else(|_| Err("decode task failed".into())), clips)
    });
    let ext = ext?;
    let clips = clips?;
    emit("analyze", 0.55);
    let alignment = audio_align::analyze(&clips, req.reference_duration_sec, &ext, &mut |p| {
        emit("analyze", 0.55 + p as f64 * 0.15)
    });
    let headline = alignment.headline_offset(req.reference_duration_sec);
    let speed = alignment
        .segments
        .iter()
        .max_by_key(|s| s.anchors)
        .map(|s| s.speed)
        .unwrap_or(alignment.ratio);
    let mut result = SyncResult {
        job_id: req.job_id.clone(),
        verdict: match alignment.verdict {
            Verdict::Match => "match",
            Verdict::Partial => "partial",
            Verdict::Mismatch => "mismatch",
        }
        .into(),
        output_path: None,
        offset_sec: headline,
        speed,
        segments: alignment.segments.len(),
        matched: alignment.matched,
        windows: alignment.windows,
        confidence: (alignment.matched as f32 / alignment.windows.max(1) as f32).clamp(0.0, 1.0),
        verify_windows: 0,
        verify_median_ms: 0.0,
        verify_max_ms: 0.0,
        cached: false,
    };
    eprintln!(
        "[harbor::external-audio] verdict={} windows={} matched={} segments={} offset={:.3}s speed={:.6}",
        result.verdict, result.windows, result.matched, result.segments, headline, speed
    );
    if alignment.verdict == Verdict::Mismatch {
        emit("done", 1.0);
        return Ok(result);
    }
    // Raw streams (.thd, some .dts) carry no container duration; the decoded length is exact.
    let ext_length = if info.duration_sec > 0.0 { info.duration_sec } else { ext.duration_sec() };
    let pieces = audio_align::pieces(&alignment, req.reference_duration_sec, ext_length);
    emit("render", 0.7);
    render(req, &pieces, stream.channels, &out, cancel, &|p| emit("render", 0.7 + p * 0.22))?;
    emit("verify", 0.92);
    let rendered = decode_features(
        &out.to_string_lossy(),
        &HashMap::new(),
        0,
        None,
        cancel,
        &mut |sec| emit("verify", 0.92 + (sec / req.reference_duration_sec.max(1.0)).min(1.0) * 0.07),
    )?;
    let stats: VerifyStats = audio_align::verify(&clips, req.reference_duration_sec, &rendered);
    result.verify_windows = stats.windows;
    result.verify_median_ms = stats.median_ms;
    result.verify_max_ms = stats.max_ms;
    result.output_path = Some(out.to_string_lossy().into_owned());
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = std::fs::write(&meta, bytes);
    }
    eprintln!(
        "[harbor::external-audio] rendered {} verify windows={} median={:.1}ms max={:.1}ms",
        out.display(),
        stats.windows,
        stats.median_ms,
        stats.max_ms
    );
    emit("done", 1.0);
    Ok(result)
}

#[tauri::command]
pub async fn external_audio_sync(app: AppHandle, request: SyncRequest) -> Result<SyncResult, String> {
    let (guard, cancel) = JobGuard::start(&request.job_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_sync(&app, &request, &cancel)
    })
    .await
    .map_err(|e| format!("sync task: {e}"))?
}

#[tauri::command]
pub fn external_audio_cancel(job_id: String) {
    if let Ok(map) = jobs().lock() {
        if let Some(flag) = map.get(&job_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn run_export(app: &AppHandle, req: &ExportRequest, cancel: &AtomicBool) -> Result<String, String> {
    let dest = PathBuf::from(&req.dest_path);
    let parent = dest.parent().ok_or("Choose where to save the audio")?;
    if !parent.is_dir() {
        return Err("Choose where to save the audio".into());
    }
    if !is_http(&req.source_url) && local_path(&req.source_url).is_none() {
        return Err("This source cannot be saved".into());
    }
    let emit = |progress: f64| {
        let _ = app.emit(PROGRESS_EVENT, Progress { job_id: &req.job_id, stage: "export", progress: progress as f32 });
    };
    let partial = dest.with_extension("partial.mka");
    let mut cmd = Command::new(ffmpeg_path()?);
    cmd.arg("-hide_banner").arg("-v").arg("error").arg("-nostdin").arg("-y");
    push_input(&mut cmd, &req.source_url, &req.headers);
    cmd.arg("-map")
        .arg(format!("0:a:{}", req.ordinal))
        .args(["-vn", "-sn", "-dn", "-c:a", "copy", "-f", "matroska", "-progress", "pipe:1", "-nostats"])
        .arg(&partial)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let running = spawn(cmd)?;
    let stderr = running.child().stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let duration = req.duration_sec.unwrap_or(0.0);
    let stdout = running.child().stdout.take();
    if let Some(stdout) = stdout {
        running.watch_cancel(cancel, || {
            for line in BufReader::new(stdout).lines() {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(line) = line else { break };
                if let (Some(us), true) = (line.strip_prefix("out_time_us="), duration > 0.0) {
                    if let Ok(us) = us.trim().parse::<f64>() {
                        emit((us / 1e6 / duration).clamp(0.0, 0.99));
                    }
                }
            }
        });
    }
    if cancel.load(Ordering::SeqCst) {
        drop(running);
        let _ = std::fs::remove_file(&partial);
        return Err("cancelled".into());
    }
    let status = running.child().wait().map_err(|e| format!("ffmpeg wait: {e}"))?;
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        let detail = stderr.lines().last().unwrap_or("").trim().to_string();
        return Err(format!("Could not save this audio track: {detail}"));
    }
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&partial, &dest).map_err(|e| format!("save audio: {e}"))?;
    emit(1.0);
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn audio_track_export(app: AppHandle, request: ExportRequest) -> Result<String, String> {
    let (guard, cancel) = JobGuard::start(&request.job_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        run_export(&app, &request, &cancel)
    })
    .await
    .map_err(|e| format!("export task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_paths_never_receive_http_options() {
        let mut cmd = Command::new("ffmpeg");
        push_input(&mut cmd, "C:/films/movie.mkv", &HashMap::from([("User-Agent".into(), "x".into())]));
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-i", "C:/films/movie.mkv"]);
        let mut cmd = Command::new("ffmpeg");
        push_input(&mut cmd, "https://cdn.example/movie.mkv", &HashMap::new());
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"-user_agent".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("https://cdn.example/movie.mkv"));
    }

    #[test]
    fn file_urls_become_paths_and_other_schemes_are_refused() {
        assert_eq!(local_path("file:///C:/My%20Films/a.mkv"), Some(PathBuf::from(if cfg!(windows) { "C:/My Films/a.mkv" } else { "/C:/My Films/a.mkv" })));
        assert_eq!(local_path("smb://nas/a.mkv"), None);
        assert_eq!(local_path("https://x/a.mkv"), None);
        assert_eq!(local_path("D:\\a.mka"), Some(PathBuf::from("D:\\a.mka")));
    }

    #[test]
    fn percent_decoding_never_splits_a_character() {
        assert_eq!(percent_decode("50%aé.mka"), "50%aé.mka");
        assert_eq!(percent_decode("%D9%81%D9%8A%D9%84%D9%85.mka"), "فيلم.mka");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn guesses_dub_language_from_the_name() {
        assert_eq!(guess_language(Path::new("فيلم Monsters, Inc. 2001 مدبلج.mka")).as_deref(), Some("ara"));
        assert_eq!(guess_language(Path::new("Sonic.2020.720p.Arabic.Dub.mkv")).as_deref(), Some("ara"));
        assert_eq!(guess_language(Path::new("Sonic.2020.FRENCH.720p.mkv")).as_deref(), Some("fre"));
        assert_eq!(guess_language(Path::new("Sonic.2020.720p.mkv")), None);
    }

    #[test]
    fn surround_sources_keep_five_one() {
        assert_eq!(layout_for(8), ("5.1", "640k"));
        assert_eq!(layout_for(6), ("5.1", "640k"));
        assert_eq!(layout_for(2), ("stereo", "448k"));
        assert_eq!(layout_for(1), ("mono", "192k"));
    }

    /// Syncs a real dub to a real film. Run with `HARBOR_SYNC_REF=<film> HARBOR_SYNC_REF_TRACK=<n>
    /// HARBOR_SYNC_EXT=<audio file> cargo test --lib live_sync -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_sync_of_a_real_dub() {
        let (Ok(reference), Ok(external)) = (std::env::var("HARBOR_SYNC_REF"), std::env::var("HARBOR_SYNC_EXT")) else {
            return;
        };
        let ordinal = std::env::var("HARBOR_SYNC_REF_TRACK").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let duration = probe_file(Path::new(&reference)).expect("probe film").duration_sec;
        let req = SyncRequest {
            job_id: "live".into(),
            reference_url: reference,
            reference_headers: HashMap::new(),
            reference_ordinal: ordinal,
            reference_duration_sec: duration,
            external_path: external,
            external_ordinal: 0,
            keep_pitch: false,
        };
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let last = Mutex::new(String::new());
        let result = sync_with_progress(
            &|stage, p| {
                let line = format!("{stage} {}0%", (p * 10.0).floor() as u32);
                let mut last = last.lock().unwrap();
                if *last != line {
                    eprintln!("[live-sync] {line} at {:.1}s", started.elapsed().as_secs_f64());
                    *last = line;
                }
            },
            &req,
            &cancel,
        )
        .expect("sync");
        eprintln!("[live-sync] {result:?} in {:.1}s", started.elapsed().as_secs_f64());
        assert_eq!(result.verdict, "match");
        assert!(result.output_path.as_deref().is_some_and(|p| Path::new(p).is_file()));
        assert!(result.verify_windows >= 10, "{result:?}");
        assert!(result.verify_max_ms < 30.0, "{result:?}");
    }
}
