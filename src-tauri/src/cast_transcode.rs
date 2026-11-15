//! Decides how a source is converted for a cast receiver and builds the FFmpeg arguments for it.
//!
//! The options mirror the cast settings panel (quality, forced conversion, native H.265, hardware
//! decoding/encoding, HDR tone mapping, deinterlacing, aspect, surround, volume and delays). The plan
//! is pure (`build_plan`) so it can be unit tested; probing the source and the local FFmpeg build is
//! async and cached. The same plan feeds both outputs a receiver can take: an HLS event playlist
//! (Chromecast, AirPlay, Roku, optionally DLNA) and one continuous MPEG-TS response (DLNA's most
//! widely supported transfer).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;

/// Viewer choices from the cast settings panel. Every field is lenient: an unknown value falls
/// back to the default instead of failing the cast.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CastOptions {
    /// 720p | 1080p | 1080p-hq | 4k | original
    pub quality: String,
    /// Convert even when the receiver could take the source as it is.
    pub force_conversion: bool,
    /// The receiver decodes H.265 (and its HDR) itself, so H.265 sources are sent untouched.
    pub hevc_native: bool,
    pub hardware_decoding: bool,
    pub hardware_encoding: bool,
    /// Seeks restart at the nearest keyframe instead of the exact frame: faster, up to ~2 s early.
    pub fast_seek: bool,
    /// auto | on | off
    pub tonemap: String,
    /// none | auto | always
    pub deinterlace: String,
    /// default | 16:9 | 4:3 | 21:9 | fill
    pub aspect: String,
    /// auto | ts | hls
    pub stream_format: String,
    /// stereo | surround | original
    pub audio_mode: String,
    /// Percent added to the volume: 0, 25, 50, 100.
    pub volume_boost: u32,
    pub night_mode: bool,
    pub dialogue_boost: bool,
    /// Positive values delay the sound on the TV.
    pub audio_delay_ms: i32,
    /// Positive values show burned-in subtitles later.
    pub sub_delay_ms: i32,
    /// auto | utf-8 | windows-1256 | windows-1252 | ... (text subtitles only)
    pub sub_encoding: String,
}

impl Default for CastOptions {
    fn default() -> Self {
        CastOptions {
            quality: "1080p-hq".into(),
            force_conversion: false,
            hevc_native: false,
            hardware_decoding: true,
            hardware_encoding: true,
            fast_seek: false,
            tonemap: "auto".into(),
            deinterlace: "auto".into(),
            aspect: "default".into(),
            stream_format: "auto".into(),
            audio_mode: "stereo".into(),
            volume_boost: 0,
            night_mode: false,
            dialogue_boost: false,
            audio_delay_ms: 0,
            sub_delay_ms: 0,
            sub_encoding: "auto".into(),
        }
    }
}

impl CastOptions {
    /// (max output height, target video kbps)
    fn quality(&self) -> (u32, u32) {
        match self.quality.as_str() {
            "720p" => (720, 4_000),
            "1080p" => (1080, 8_000),
            "4k" => (2160, 30_000),
            "original" => (4320, 40_000),
            _ => (1080, 14_000),
        }
    }

    pub(crate) fn audio_filters_requested(&self) -> bool {
        self.volume_boost > 0 || self.night_mode || self.dialogue_boost || self.audio_delay_ms != 0
    }

    fn aspect_ratio(&self) -> Option<(u32, u32)> {
        match self.aspect.as_str() {
            "16:9" | "fill" => Some((16, 9)),
            "4:3" => Some((4, 3)),
            "21:9" => Some((64, 27)),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub index: u32,
    pub codec: String,
    pub pix_fmt: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub hdr: bool,
    pub dolby_vision: Option<u32>,
    pub interlaced: bool,
    pub bitrate: u64,
    /// Sample (pixel) aspect ratio when it is not square, e.g. 16:15 for a PAL DVD.
    pub sar: Option<(u32, u32)>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleInfo {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
}

impl SubtitleInfo {
    /// Picture subtitles (Blu-ray, DVD, DVB) cannot become text; they are overlaid instead.
    pub fn is_bitmap(&self) -> bool {
        matches!(self.codec.as_str(), "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub")
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub duration: f64,
    pub container: String,
    pub video: Option<VideoInfo>,
    pub audio: Vec<AudioInfo>,
    pub subtitles: Vec<SubtitleInfo>,
}

pub fn is_http(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// HTTP options for an input. FFmpeg refuses to open a local file when any of them is present,
/// which is what left local-file casts "Transcoding" forever.
pub fn http_input_args(url: &str, headers: &HashMap<String, String>, reconnect: bool) -> Vec<String> {
    if !is_http(url) {
        return Vec::new();
    }
    let mut args = Vec::new();
    let ua = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Harbor/1.0".into());
    args.push("-user_agent".into());
    args.push(ua);
    let blob: String = headers
        .iter()
        .filter(|(k, v)| !k.eq_ignore_ascii_case("user-agent") && !k.contains(['\r', '\n']) && !v.contains(['\r', '\n']))
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect();
    if !blob.is_empty() {
        args.push("-headers".into());
        args.push(blob);
    }
    if reconnect {
        for (k, v) in [
            ("-reconnect", "1"),
            ("-reconnect_streamed", "1"),
            ("-reconnect_on_network_error", "1"),
            ("-reconnect_delay_max", "8"),
        ] {
            args.push(k.into());
            args.push(v.into());
        }
    }
    args
}

#[derive(Deserialize)]
struct ProbeJson {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: Option<ProbeFormat>,
}

#[derive(Deserialize, Default)]
struct ProbeStream {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    codec_name: String,
    #[serde(default)]
    pix_fmt: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    avg_frame_rate: Option<String>,
    #[serde(default)]
    r_frame_rate: Option<String>,
    #[serde(default)]
    sample_aspect_ratio: Option<String>,
    #[serde(default)]
    color_transfer: Option<String>,
    #[serde(default)]
    field_order: Option<String>,
    #[serde(default)]
    channels: Option<u32>,
    #[serde(default)]
    bit_rate: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i64>,
    #[serde(default)]
    side_data_list: Vec<HashMap<String, serde_json::Value>>,
}

#[derive(Deserialize, Default)]
struct ProbeFormat {
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    format_name: Option<String>,
}

fn parse_rate(rate: Option<&str>) -> Option<f64> {
    let (n, d) = rate?.split_once('/')?;
    let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
    (d > 0.0 && n > 0.0).then_some(n / d).filter(|v| *v > 1.0 && *v < 300.0)
}

/// "16:15" -> (16, 15); square ("1:1") and unknown ("0:1", "N/A") ratios give None.
fn parse_sar(sar: Option<&str>) -> Option<(u32, u32)> {
    let (n, d) = sar?.split_once(':')?;
    let (n, d) = (n.trim().parse::<u32>().ok()?, d.trim().parse::<u32>().ok()?);
    (n > 0 && d > 0 && n != d).then_some((n, d))
}

pub(crate) fn parse_probe(json: &str) -> Result<MediaProbe, String> {
    let parsed: ProbeJson = serde_json::from_str(json).map_err(|e| format!("ffprobe json: {e}"))?;
    let format = parsed.format.unwrap_or_default();
    let mut probe = MediaProbe {
        duration: format.duration.and_then(|d| d.parse().ok()).unwrap_or(0.0),
        container: format.format_name.unwrap_or_default(),
        ..Default::default()
    };
    for s in parsed.streams {
        match s.codec_type.as_str() {
            // Cover art travels as a one-frame video stream; it is never the film.
            "video" if s.disposition.get("attached_pic").copied().unwrap_or(0) == 0 && probe.video.is_none() => {
                let transfer = s.color_transfer.as_deref().unwrap_or("");
                let dolby_vision = s.side_data_list.iter().find_map(|d| {
                    let kind = d.get("side_data_type")?.as_str()?.to_ascii_lowercase();
                    if !kind.contains("dovi") && !kind.contains("dolby vision") {
                        return None;
                    }
                    d.get("dv_profile").and_then(|v| v.as_u64()).map(|v| v as u32)
                });
                let field_order = s.field_order.as_deref().unwrap_or("");
                probe.video = Some(VideoInfo {
                    index: s.index,
                    codec: s.codec_name.to_ascii_lowercase(),
                    pix_fmt: s.pix_fmt.unwrap_or_default(),
                    width: s.width.unwrap_or(0),
                    height: s.height.unwrap_or(0),
                    fps: parse_rate(s.avg_frame_rate.as_deref())
                        .or_else(|| parse_rate(s.r_frame_rate.as_deref()))
                        .unwrap_or(24.0),
                    hdr: matches!(transfer, "smpte2084" | "arib-std-b67") || dolby_vision.is_some(),
                    dolby_vision,
                    interlaced: matches!(field_order, "tt" | "bb" | "tb" | "bt"),
                    bitrate: s.bit_rate.and_then(|b| b.parse().ok()).unwrap_or(0),
                    sar: parse_sar(s.sample_aspect_ratio.as_deref()),
                });
            }
            "audio" => probe.audio.push(AudioInfo {
                index: s.index,
                codec: s.codec_name.to_ascii_lowercase(),
                channels: s.channels.unwrap_or(2),
                language: s.tags.get("language").cloned().filter(|l| l != "und"),
            }),
            "subtitle" => probe.subtitles.push(SubtitleInfo {
                index: s.index,
                codec: s.codec_name.to_ascii_lowercase(),
                language: s.tags.get("language").cloned().filter(|l| l != "und"),
            }),
            _ => {}
        }
    }
    if probe.video.is_none() && probe.audio.is_empty() {
        return Err("no playable streams".into());
    }
    Ok(probe)
}

pub(crate) fn quiet_command(program: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

pub async fn probe(url: &str, headers: &HashMap<String, String>) -> Result<MediaProbe, String> {
    let ffprobe = crate::transcode::locate_ffprobe().ok_or("ffprobe not found")?;
    let mut cmd = quiet_command(&ffprobe);
    cmd.arg("-v").arg("error");
    cmd.args(http_input_args(url, headers, false));
    cmd.args(["-analyzeduration", "10M", "-probesize", "10M", "-show_streams", "-show_format", "-of", "json"])
        .arg("-i")
        .arg(url);
    let output = crate::process_output::output(cmd, Duration::from_secs(20))
        .await
        .map_err(|e| format!("ffprobe: {e}"))?;
    parse_probe(&String::from_utf8_lossy(&output.stdout))
}

/// What the local FFmpeg build can do. Hardware encoders are listed by most builds whether or not
/// the machine has the hardware, so each one is confirmed with a tiny real encode.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegCaps {
    pub available: bool,
    pub nvenc: bool,
    pub qsv: bool,
    pub amf: bool,
    pub videotoolbox: bool,
    pub libplacebo: bool,
    pub zscale_tonemap: bool,
    pub readrate: bool,
}

impl FfmpegCaps {
    pub fn hardware_label(&self) -> Option<&'static str> {
        if self.nvenc {
            Some("NVIDIA NVENC")
        } else if self.qsv {
            Some("Intel Quick Sync")
        } else if self.amf {
            Some("AMD AMF")
        } else if self.videotoolbox {
            Some("Apple VideoToolbox")
        } else {
            None
        }
    }
}

static CAPS: OnceCell<FfmpegCaps> = OnceCell::const_new();

async fn ffmpeg_ok(ffmpeg: &std::path::Path, args: &[&str]) -> bool {
    let mut cmd = quiet_command(ffmpeg);
    cmd.args(["-hide_banner", "-v", "error", "-nostdin"]).args(args);
    matches!(
        crate::process_output::output(cmd, Duration::from_secs(12)).await,
        Ok(out) if out.status.success()
    )
}

async fn listing(ffmpeg: &std::path::Path, flag: &str) -> HashSet<String> {
    let mut cmd = quiet_command(ffmpeg);
    cmd.args(["-hide_banner", flag]);
    let Ok(out) = crate::process_output::output(cmd, Duration::from_secs(10)).await else {
        return HashSet::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1).map(str::to_string))
        .collect()
}

pub async fn caps() -> FfmpegCaps {
    CAPS.get_or_init(|| async {
        let Some(ffmpeg) = crate::transcode::locate_ffmpeg() else {
            return FfmpegCaps::default();
        };
        let (encoders, filters) = tokio::join!(listing(&ffmpeg, "-encoders"), listing(&ffmpeg, "-filters"));
        let test_encode = |encoder: &'static str| {
            let ffmpeg = ffmpeg.clone();
            let listed = encoders.contains(encoder);
            async move {
                listed
                    && ffmpeg_ok(
                        &ffmpeg,
                        &["-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=0.4", "-pix_fmt", "yuv420p", "-c:v", encoder, "-f", "null", "-"],
                    )
                    .await
            }
        };
        let nvenc = test_encode("h264_nvenc").await;
        let qsv = !nvenc && test_encode("h264_qsv").await;
        let amf = !nvenc && !qsv && test_encode("h264_amf").await;
        let videotoolbox = cfg!(target_os = "macos") && test_encode("h264_videotoolbox").await;
        let libplacebo = filters.contains("libplacebo")
            && ffmpeg_ok(
                &ffmpeg,
                &[
                    "-init_hw_device", "vulkan", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2,format=yuv420p10le",
                    "-vf", "libplacebo=w=160:h=120:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p",
                    "-f", "null", "-",
                ],
            )
            .await;
        let zscale_tonemap = filters.contains("zscale") && filters.contains("tonemap");
        let readrate = ffmpeg_ok(
            &ffmpeg,
            &["-readrate", "8", "-readrate_initial_burst", "1", "-f", "lavfi", "-i", "anullsrc=d=0.1", "-f", "null", "-"],
        )
        .await;
        let caps = FfmpegCaps { available: true, nvenc, qsv, amf, videotoolbox, libplacebo, zscale_tonemap, readrate };
        eprintln!("[harbor::cast] ffmpeg capabilities: {caps:?}");
        caps
    })
    .await
    .clone()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    /// "copy" or the encoder used.
    pub video: String,
    pub audio: String,
    pub source_video: String,
    pub source_audio: String,
    pub output_height: u32,
    pub tonemap: Option<String>,
    pub hardware: Option<String>,
    pub burned_subtitles: bool,
    pub deinterlaced: bool,
    pub reasons: Vec<String>,
}

/// Everything FFmpeg needs except the input URL and the output destination.
#[derive(Clone, Debug)]
pub struct CastPlan {
    pub pre_input: Vec<String>,
    pub output: Vec<String>,
    pub summary: PlanSummary,
    pub hls_codecs: String,
    /// H.265 sent untouched: HLS receivers (Apple TV above all) only take it in fragmented MP4
    /// segments, never in MPEG-TS.
    pub hls_fmp4: bool,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bandwidth: u64,
}

pub struct PlanInput<'a> {
    pub probe: Option<&'a MediaProbe>,
    pub options: &'a CastOptions,
    pub audio_ordinal: u32,
    /// Burned-in subtitle file and its ASS force_style.
    pub burn_sub: Option<&'a (String, String)>,
    /// Absolute index of an embedded picture subtitle stream to overlay.
    pub burn_bitmap: Option<u32>,
    /// A separate audio file opened as the second input replaces the film's own audio.
    pub external_audio: Option<&'a AudioInfo>,
    /// The caller already knows the receiver cannot take the source as it is.
    pub force_video_encode: bool,
    pub force_audio_encode: bool,
}

fn even(v: f64) -> u32 {
    ((v / 2.0).round() as u32 * 2).max(2)
}

fn ffmpeg_number(v: f64) -> String {
    format!("{v:.3}").trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Audio filters for the TV mix. Dialogue boost re-weights the centre channel while folding a
/// surround track to stereo, which is where film dialogue lives.
fn audio_filters(options: &CastOptions, channels_in: u32, stereo_out: bool) -> Vec<String> {
    let mut out = Vec::new();
    if options.dialogue_boost && stereo_out && channels_in >= 6 {
        out.push("pan=stereo|FL<0.6*FL+1.2*FC+0.4*BL+0.4*SL+0.2*LFE|FR<0.6*FR+1.2*FC+0.4*BR+0.4*SR+0.2*LFE".into());
    }
    if options.night_mode {
        out.push("dynaudnorm=f=200:g=15:p=0.9:m=10".into());
    }
    if options.volume_boost > 0 {
        let gain = 1.0 + options.volume_boost.min(200) as f64 / 100.0;
        out.push(format!("volume={}", ffmpeg_number(gain)));
        out.push("alimiter=limit=0.95:level=disabled".into());
    }
    match options.audio_delay_ms {
        d if d > 0 => out.push(format!("adelay=delays={d}:all=1")),
        d if d < 0 => out.push(format!("atrim=start={},asetpts=PTS-STARTPTS", ffmpeg_number(-d as f64 / 1000.0))),
        _ => {}
    }
    out
}

/// Crops the picture to `(w, h)` aspect when "fill" is chosen, returning the crop filter and the
/// cropped size.
fn fill_crop(src_w: u32, src_h: u32, aspect: (u32, u32)) -> Option<(String, u32, u32)> {
    if src_w == 0 || src_h == 0 {
        return None;
    }
    let target = aspect.0 as f64 / aspect.1 as f64;
    let current = src_w as f64 / src_h as f64;
    if (current - target).abs() < 0.01 {
        return None;
    }
    let (w, h) = if current > target {
        (even(src_h as f64 * target), src_h)
    } else {
        (src_w, even(src_w as f64 / target))
    };
    Some((format!("crop={w}:{h}"), w, h))
}

/// The CODECS name the HLS playlist announces: High profile, level 4.1 up to 1080p, 5.1 above.
/// Receivers check it before loading, so a 4K stream announced as 4.1 is refused.
fn h264_codec_string(height: u32) -> &'static str {
    if height > 1080 { "avc1.640033" } else { "avc1.640029" }
}

/// Main 10 for 10-bit (HDR) sources, Main for 8-bit ones; level 5.1 above 1080p, 4.1 up to it.
fn hevc_codec_string(video: &VideoInfo) -> String {
    let profile = if video.pix_fmt.contains("10") || video.pix_fmt.contains("12") || video.hdr { "2.4" } else { "1.6" };
    let level = if video.height > 1080 { 153 } else { 123 };
    format!("hvc1.{profile}.L{level}.B0")
}

pub fn build_plan(input: &PlanInput, caps: &FfmpegCaps) -> CastPlan {
    let options = input.options;
    let (max_height, target_kbps) = options.quality();
    let video = input.probe.and_then(|p| p.video.as_ref());
    let audio = match input.external_audio {
        Some(info) => Some(info),
        None => input.probe.and_then(|p| p.audio.get(input.audio_ordinal as usize)),
    };
    let mut reasons: Vec<String> = Vec::new();
    let mut pre_input: Vec<String> = Vec::new();
    let mut output: Vec<String> = Vec::new();
    let mut video_out_map: Option<String> = None;

    let forced = options.force_conversion;
    let eight_bit = video.is_some_and(|v| matches!(v.pix_fmt.as_str(), "yuv420p" | "yuvj420p"));
    let deinterlace = match options.deinterlace.as_str() {
        "always" => true,
        "none" => false,
        _ => video.is_some_and(|v| v.interlaced),
    };
    let aspect = options.aspect_ratio();
    let burning = input.burn_sub.is_some() || input.burn_bitmap.is_some();
    let mut encode_video = forced || input.force_video_encode || burning || deinterlace || aspect.is_some();
    if forced {
        reasons.push("forced conversion".into());
    }
    if let Some(v) = video {
        let native_hevc = options.hevc_native && v.codec == "hevc";
        if v.codec != "h264" && !native_hevc {
            reasons.push(format!("{} video", v.codec.to_uppercase()));
            encode_video = true;
        }
        if v.height > max_height {
            reasons.push(format!("{}p above {}p", v.height, max_height));
            encode_video = true;
        }
        if v.hdr && !native_hevc {
            reasons.push(if v.dolby_vision.is_some() { "Dolby Vision".into() } else { "HDR".into() });
            encode_video = true;
        }
        if v.codec == "h264" && !eight_bit && !v.pix_fmt.is_empty() {
            reasons.push("10-bit H.264".into());
            encode_video = true;
        }
    } else if input.probe.is_none() {
        // Without a probe there is no way to know the source is TV-safe.
        encode_video = true;
    }
    if burning {
        reasons.push("burned-in subtitles".into());
    }
    if deinterlace {
        reasons.push("interlaced".into());
    }

    let video_map = video.map(|v| format!("0:{}", v.index)).unwrap_or_else(|| "0:v:0?".into());
    // The video map is decided below: an overlaid picture subtitle maps a filter graph output.
    let audio_map = if input.external_audio.is_some() {
        "1:a:0".to_string()
    } else {
        format!("0:a:{}?", input.audio_ordinal)
    };

    let mut src_w = video.map(|v| v.width).unwrap_or(0);
    let mut src_h = video.map(|v| v.height).unwrap_or(0);
    let fps = video.map(|v| v.fps).unwrap_or(24.0).clamp(10.0, 120.0);
    let mut pre_filters: Vec<String> = Vec::new();
    if deinterlace {
        pre_filters.push(format!(
            "bwdif=mode=send_frame:deint={}",
            if options.deinterlace == "always" { "all" } else { "interlaced" }
        ));
    }
    if options.aspect == "fill" {
        if let Some((crop, w, h)) = aspect.and_then(|a| fill_crop(src_w, src_h, a)) {
            pre_filters.push(crop);
            src_w = w;
            src_h = h;
        }
    }
    // The output uses square pixels (setsar=1), so a non-square source is widened to its display
    // shape first: a 720x576 PAL DVD at 16:15 is 768 wide, not 720.
    let display_w = match video.and_then(|v| v.sar) {
        Some((n, d)) if options.aspect == "default" => src_w as f64 * n as f64 / d as f64,
        _ => src_w as f64,
    };
    let (out_w, out_h) = if src_w > 0 && src_h > 0 {
        let h = src_h.min(max_height);
        (even(display_w * h as f64 / src_h as f64), even(h as f64))
    } else {
        (1920, 1080)
    };

    let mut summary = PlanSummary {
        video: "copy".into(),
        audio: "copy".into(),
        source_video: video
            .map(|v| {
                let range = if v.dolby_vision.is_some() { " DV" } else if v.hdr { " HDR" } else { "" };
                format!("{} {}p{}", v.codec.to_uppercase(), v.height, range)
            })
            .unwrap_or_default(),
        source_audio: audio.map(|a| format!("{} {}ch", a.codec.to_uppercase(), a.channels)).unwrap_or_default(),
        output_height: if encode_video { out_h } else { src_h },
        tonemap: None,
        hardware: None,
        burned_subtitles: burning,
        deinterlaced: deinterlace,
        reasons,
    };
    let mut hls_video_codec = "avc1.640029".to_string();
    let mut hls_fmp4 = false;

    if encode_video {
        let encoder = if options.hardware_encoding && caps.nvenc {
            "h264_nvenc"
        } else if options.hardware_encoding && caps.qsv {
            "h264_qsv"
        } else if options.hardware_encoding && caps.amf {
            "h264_amf"
        } else if options.hardware_encoding && caps.videotoolbox {
            "h264_videotoolbox"
        } else {
            "libx264"
        };
        let wants_tonemap = video.is_some_and(|v| v.hdr) && options.tonemap != "off" || options.tonemap == "on";
        // libplacebo runs on the GPU; with both GPU switches off the CPU tone mapper is used.
        let placebo = wants_tonemap && caps.libplacebo && (options.hardware_decoding || options.hardware_encoding);
        if placebo {
            pre_input.extend(["-init_hw_device".into(), "vulkan".into()]);
        }
        // Frames are copied back to system memory for the filters, and FFmpeg falls back to
        // software decoding by itself when the GPU cannot decode the codec.
        let any_hw_encoder = caps.nvenc || caps.qsv || caps.amf || caps.videotoolbox;
        if options.hardware_decoding && any_hw_encoder {
            pre_input.extend(["-hwaccel".into(), if caps.nvenc { "cuda".into() } else { "auto".into() }]);
        }
        let mut vf: Vec<String> = pre_filters;
        if placebo {
            vf.push(format!(
                "libplacebo=w={out_w}:h={out_h}:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p"
            ));
            summary.tonemap = Some("libplacebo".into());
        } else if wants_tonemap && caps.zscale_tonemap {
            vf.push(format!(
                "zscale=w={out_w}:h={out_h}:filter=bilinear,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
            ));
            summary.tonemap = Some("zscale".into());
        } else if src_w > 0 && src_h > 0 {
            vf.push(format!("scale={out_w}:{out_h}"));
        } else {
            vf.push(format!("scale=-2:'min(ih,{max_height})'"));
        }
        // Square pixels: some TVs mis-scale the slightly anamorphic sizes even dimensions leave.
        vf.push("setsar=1".into());
        if let Some((n, d)) = aspect.filter(|_| options.aspect != "fill") {
            vf.push(format!("setdar={n}/{d}"));
        }
        if let Some((path, style)) = input.burn_sub {
            vf.push(crate::cast_subs::burn_filter(path, style));
        }
        let maxrate = target_kbps * 3 / 2;
        let bufsize = target_kbps * 2;
        let gop = (fps * 2.0).round() as u32;
        if let Some(sub_index) = input.burn_bitmap {
            // Picture subtitles are drawn on a canvas of their own; fit it to the output frame and
            // keep it at the bottom, where the canvas places its text.
            output.extend([
                "-filter_complex".into(),
                format!(
                    "[{video_map}]{}[base];[0:{sub_index}]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[sub];[base][sub]overlay=x=(W-w)/2:y=H-h:eof_action=pass,format=yuv420p[vout]",
                    vf.join(",")
                ),
            ]);
            video_out_map = Some("[vout]".into());
        } else {
            vf.push("format=yuv420p".into());
            output.extend(["-vf".into(), vf.join(",")]);
        }
        output.extend(["-c:v".into(), encoder.into()]);
        match encoder {
            "h264_nvenc" => output.extend(
                ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-spatial-aq", "1", "-bf", "2", "-forced-idr", "1"]
                    .map(String::from),
            ),
            "h264_qsv" => output.extend(["-preset", "faster", "-look_ahead", "0"].map(String::from)),
            "h264_amf" => output.extend(["-quality", "balanced", "-rc", "vbr_peak"].map(String::from)),
            "h264_videotoolbox" => output.extend(["-allow_sw", "1", "-realtime", "1"].map(String::from)),
            _ => output.extend(
                ["-preset", "veryfast", "-crf", "21", "-sc_threshold", "0", "-x264-params", "scenecut=0:open_gop=0"]
                    .map(String::from),
            ),
        }
        if encoder != "libx264" {
            output.extend(["-b:v".into(), format!("{target_kbps}k")]);
        }
        output.extend([
            "-maxrate".into(),
            format!("{maxrate}k"),
            "-bufsize".into(),
            format!("{bufsize}k"),
            "-profile:v".into(),
            "high".into(),
            "-g".into(),
            gop.to_string(),
            "-force_key_frames".into(),
            "expr:gte(t,n_forced*2)".into(),
        ]);
        if encoder == "libx264" {
            output.extend(["-level".into(), if out_h > 1080 { "5.1".into() } else { "4.1".into() }]);
            output.extend(["-keyint_min".into(), gop.to_string()]);
        }
        hls_video_codec = h264_codec_string(out_h).into();
        summary.video = encoder.into();
        summary.hardware = (encoder != "libx264").then(|| caps.hardware_label().unwrap_or("GPU").to_string());
        summary.output_height = out_h;
    } else {
        output.extend(["-c:v".into(), "copy".into()]);
        if let Some(v) = video.filter(|v| v.codec == "h264") {
            output.extend(["-bsf:v".into(), "h264_mp4toannexb".into()]);
            hls_video_codec = h264_codec_string(v.height).into();
        } else if let Some(v) = video.filter(|v| v.codec == "hevc") {
            output.extend(["-bsf:v".into(), "hevc_mp4toannexb".into()]);
            hls_video_codec = hevc_codec_string(v);
            hls_fmp4 = true;
        }
    }

    let channels = audio.map(|a| a.channels).unwrap_or(2);
    let codec = audio.map(|a| a.codec.as_str()).unwrap_or("");
    let ts_safe = matches!(codec, "aac" | "ac3" | "eac3" | "mp3");
    let copy_audio = !options.audio_filters_requested()
        && !input.force_audio_encode
        && !forced
        && ts_safe
        && match options.audio_mode.as_str() {
            "original" => true,
            "surround" => channels >= 6 && codec == "ac3",
            _ => channels <= 2 && codec == "aac",
        };
    let hls_audio_codec;
    if copy_audio {
        output.extend(["-c:a".into(), "copy".into()]);
        hls_audio_codec = match codec {
            "ac3" => "ac-3",
            "eac3" => "ec-3",
            "mp3" => "mp4a.40.34",
            _ => "mp4a.40.2",
        };
        summary.audio = format!("{} (original)", codec.to_uppercase());
    } else {
        let surround = matches!(options.audio_mode.as_str(), "surround" | "original") && channels >= 6;
        let filters = audio_filters(options, channels, !surround);
        if !filters.is_empty() {
            output.extend(["-af".into(), filters.join(",")]);
        }
        if surround {
            output.extend(["-c:a", "ac3", "-b:a", "640k", "-ac", "6"].map(String::from));
            hls_audio_codec = "ac-3";
            summary.audio = "AC-3 5.1".into();
        } else {
            output.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"].map(String::from));
            hls_audio_codec = "mp4a.40.2";
            summary.audio = "AAC 2.0".into();
        }
    }

    output.extend(["-map".into(), video_out_map.unwrap_or(video_map), "-map".into(), audio_map]);
    output.extend(["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"].map(String::from));

    let bandwidth = if encode_video {
        (target_kbps as u64 * 1500).max(2_500_000)
    } else {
        video.map(|v| v.bitrate).filter(|b| *b > 0).unwrap_or(8_000_000).saturating_add(640_000)
    };
    CastPlan {
        pre_input,
        output,
        summary,
        hls_codecs: format!("{hls_video_codec},{hls_audio_codec}"),
        hls_fmp4,
        width: if encode_video { out_w } else { src_w.max(2) },
        height: if encode_video { out_h } else { src_h.max(2) },
        fps,
        bandwidth,
    }
}

/// Live transcode statistics read from FFmpeg's `-progress` output.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeStats {
    pub speed: f64,
    pub out_time_sec: f64,
    pub running: bool,
    pub error: Option<String>,
}

pub type SharedStats = Arc<Mutex<TranscodeStats>>;

/// Feeds one line of FFmpeg stderr into `stats`. `-progress pipe:2` interleaves key=value lines
/// with the warnings the log level lets through. Returns whether the line was progress data.
pub fn note_progress_line(stats: &SharedStats, line: &str) -> bool {
    let Ok(mut s) = stats.lock() else { return false };
    if let Some(v) = line.strip_prefix("speed=") {
        if let Ok(speed) = v.trim().trim_end_matches('x').parse::<f64>() {
            s.speed = speed;
        }
        return true;
    }
    if let Some(v) = line.strip_prefix("out_time_us=") {
        if let Ok(us) = v.trim().parse::<f64>() {
            s.out_time_sec = (us / 1e6).max(0.0);
        }
        return true;
    }
    if line.starts_with("progress=") {
        s.running = line.trim() != "progress=end";
        return true;
    }
    let is_progress_key = line
        .split_once('=')
        .is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    if is_progress_key {
        return true;
    }
    // Only failures that stop the picture reach the viewer. FFmpeg also prints harmless notes
    // with alarming words ("UDTA parsing failed retrying raw" on many MP4 files).
    const FATAL: &[&str] = &[
        "error opening",
        "error while",
        "error initializing",
        "conversion failed",
        "invalid data found",
        "no such file",
        "server returned",
        "connection refused",
        "unable to open",
        "could not open",
        "invalid argument",
        "device creation failed",
    ];
    let lower = line.to_ascii_lowercase();
    if FATAL.iter().any(|f| lower.contains(f)) {
        s.error = Some(line.trim().chars().take(240).collect());
    }
    false
}

/// A transcode the proxy can (re)start: the source, where to start, and the plan.
#[derive(Clone, Debug)]
pub struct CastJob {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub seek_sec: f64,
    pub fast_seek: bool,
    pub plan: CastPlan,
    pub stats: SharedStats,
    /// A local audio file mapped as input 1 (see [`PlanInput::external_audio`]).
    pub external_audio: Option<String>,
}

impl CastJob {
    /// FFmpeg arguments up to and including the input.
    pub fn input_args(&self, throttle: bool, caps: &FfmpegCaps) -> Vec<String> {
        let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:2", "-stats_period", "1"]
            .map(String::from)
            .to_vec();
        args.extend(["-fflags".into(), "+genpts+discardcorrupt".into()]);
        args.extend(self.plan.pre_input.iter().cloned());
        args.extend(http_input_args(&self.url, &self.headers, true));
        if throttle && caps.readrate {
            // Stay a few minutes ahead of the receiver instead of filling the disk with the film.
            args.extend(["-readrate", "1.5", "-readrate_initial_burst", "45"].map(String::from));
        }
        if self.seek_sec > 0.5 {
            if self.fast_seek {
                args.push("-noaccurate_seek".into());
            }
            args.extend(["-ss".into(), format!("{:.3}", self.seek_sec)]);
        }
        args.extend(["-i".into(), self.url.clone()]);
        if let Some(audio) = self.external_audio.as_ref() {
            if self.seek_sec > 0.5 {
                args.extend(["-ss".into(), format!("{:.3}", self.seek_sec)]);
            }
            args.extend(["-i".into(), audio.clone()]);
        }
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mario() -> MediaProbe {
        // The 4K Dolby Vision MP4 that hung: cover art after the film, two E-AC-3 tracks.
        parse_probe(
            r#"{"streams":[
              {"index":0,"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p10le","width":3840,"height":1606,"avg_frame_rate":"24000/1001","color_transfer":"smpte2084","field_order":"progressive","side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8}]},
              {"index":1,"codec_type":"audio","codec_name":"eac3","channels":6,"tags":{"language":"eng"}},
              {"index":2,"codec_type":"audio","codec_name":"eac3","channels":6,"tags":{"language":"eng"}},
              {"index":5,"codec_type":"video","codec_name":"mjpeg","width":600,"height":900,"disposition":{"attached_pic":1}}],
              "format":{"duration":"5893.44","format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}"#,
        )
        .expect("probe")
    }

    fn plan(probe: Option<&MediaProbe>, options: &CastOptions, caps: &FfmpegCaps) -> CastPlan {
        build_plan(
            &PlanInput {
                probe,
                options,
                audio_ordinal: 1,
                burn_sub: None,
                burn_bitmap: None,
                external_audio: None,
                force_video_encode: false,
                force_audio_encode: false,
            },
            caps,
        )
    }

    #[test]
    fn an_added_audio_file_replaces_the_film_audio_as_a_second_input() {
        let probe = mario();
        let dub = AudioInfo { index: 0, codec: "ac3".into(), channels: 2, language: Some("ara".into()) };
        let options = CastOptions { audio_mode: "original".into(), ..Default::default() };
        let p = build_plan(
            &PlanInput {
                probe: Some(&probe),
                options: &options,
                audio_ordinal: 1,
                burn_sub: None,
                burn_bitmap: None,
                external_audio: Some(&dub),
                force_video_encode: false,
                force_audio_encode: false,
            },
            &FfmpegCaps::default(),
        );
        let args = p.output.join(" ");
        assert!(args.contains("-map 0:0 -map 1:a:0"), "{args}");
        assert!(args.contains("-c:a copy"), "{args}");
        let job = CastJob {
            url: "C:/Films/movie.mp4".into(),
            headers: HashMap::new(),
            seek_sec: 60.0,
            fast_seek: false,
            plan: p,
            stats: SharedStats::default(),
            external_audio: Some("C:/Temp/dub.mka".into()),
        };
        let input = job.input_args(false, &FfmpegCaps::default()).join(" ");
        assert!(input.ends_with("-ss 60.000 -i C:/Films/movie.mp4 -ss 60.000 -i C:/Temp/dub.mka"), "{input}");
    }

    #[test]
    fn picture_subtitles_are_overlaid_through_a_filter_graph() {
        let probe = parse_probe(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p10le","width":3840,"height":2076,"avg_frame_rate":"24000/1001"},
               {"index":1,"codec_type":"audio","codec_name":"truehd","channels":8},
               {"index":3,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","tags":{"language":"eng"}}],"format":{"duration":"5529.9"}}"#,
        )
        .unwrap();
        assert!(probe.subtitles[0].is_bitmap());
        let options = CastOptions::default();
        let p = build_plan(
            &PlanInput {
                probe: Some(&probe),
                options: &options,
                audio_ordinal: 0,
                burn_sub: None,
                burn_bitmap: Some(3),
                external_audio: None,
                force_video_encode: false,
                force_audio_encode: false,
            },
            &FfmpegCaps::default(),
        );
        let args = p.output.join(" ");
        assert!(args.contains("-filter_complex [0:0]scale=1998:1080,setsar=1[base];[0:3]scale=1998:1080:force_original_aspect_ratio=decrease[sub];[base][sub]overlay=x=(W-w)/2:y=H-h:eof_action=pass,format=yuv420p[vout]"), "{args}");
        assert!(args.contains("-map [vout] -map 0:a:0?"), "{args}");
        assert!(!args.contains("-vf "));
        assert!(p.summary.burned_subtitles);
    }

    #[test]
    fn hdr_hevc_is_tonemapped_and_scaled_with_the_gpu() {
        let probe = mario();
        let v = probe.video.as_ref().unwrap();
        assert_eq!((v.index, v.dolby_vision, v.hdr, v.interlaced), (0, Some(8), true, false));
        let caps = FfmpegCaps { available: true, nvenc: true, libplacebo: true, zscale_tonemap: true, ..Default::default() };
        let plan = plan(Some(&probe), &CastOptions::default(), &caps);
        let args = plan.output.join(" ");
        assert!(args.contains("-map 0:0 -map 0:a:1?"), "{args}");
        assert!(args.contains("libplacebo=w=2582:h=1080"), "{args}");
        assert!(args.contains("-c:v h264_nvenc"));
        assert!(args.contains("-b:v 14000k"), "1080p HQ is the default quality: {args}");
        assert!(args.contains("-c:a aac -b:a 192k -ac 2"));
        assert_eq!(plan.pre_input, ["-init_hw_device", "vulkan", "-hwaccel", "cuda"]);
        assert_eq!(plan.summary.tonemap.as_deref(), Some("libplacebo"));
        assert_eq!(plan.summary.source_video, "HEVC 1606p DV");
        assert_eq!(plan.hls_codecs, "avc1.640029,mp4a.40.2");
        assert_eq!((plan.width, plan.height), (2582, 1080));
    }

    #[test]
    fn hardware_switches_and_cpu_fallback() {
        let probe = mario();
        let caps = FfmpegCaps { available: true, nvenc: true, zscale_tonemap: true, ..Default::default() };
        let options = CastOptions { audio_mode: "surround".into(), hardware_encoding: false, hardware_decoding: false, ..Default::default() };
        let plan = plan(Some(&probe), &options, &caps);
        let args = plan.output.join(" ");
        assert!(args.contains("zscale=w=2582:h=1080"), "{args}");
        assert!(args.contains("-c:v libx264"));
        assert!(args.contains("-c:a ac3 -b:a 640k -ac 6"));
        assert!(plan.pre_input.is_empty());
        assert_eq!(plan.hls_codecs, "avc1.640029,ac-3");
        // Decoding on the GPU while encoding on the CPU stays available.
        let options = CastOptions { hardware_encoding: false, ..Default::default() };
        let plan = self::plan(Some(&probe), &options, &caps);
        assert_eq!(plan.pre_input, ["-hwaccel", "cuda"]);
        assert!(plan.output.join(" ").contains("-c:v libx264"));
    }

    #[test]
    fn native_hevc_sends_the_film_untouched_unless_conversion_is_forced() {
        let probe = mario();
        let caps = FfmpegCaps { available: true, nvenc: true, ..Default::default() };
        let options = CastOptions { hevc_native: true, quality: "4k".into(), audio_mode: "original".into(), ..Default::default() };
        let plan = plan(Some(&probe), &options, &caps);
        let args = plan.output.join(" ");
        assert!(args.contains("-c:v copy -bsf:v hevc_mp4toannexb"), "{args}");
        assert!(args.contains("-c:a copy"), "{args}");
        assert_eq!(plan.hls_codecs, "hvc1.2.4.L153.B0,ec-3");
        assert!(plan.hls_fmp4, "H.265 travels in fragmented MP4 over HLS");
        let forced = CastOptions { force_conversion: true, ..options };
        let args = self::plan(Some(&probe), &forced, &caps).output.join(" ");
        assert!(args.contains("-c:v h264_nvenc") && args.contains("-c:a ac3"), "{args}");
    }

    #[test]
    fn tv_safe_h264_is_copied_and_audio_filters_force_an_audio_encode() {
        let probe = parse_probe(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080,"avg_frame_rate":"24/1"},
               {"index":1,"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"duration":"100"}}"#,
        )
        .unwrap();
        let caps = FfmpegCaps::default();
        let build = |options: &CastOptions| {
            build_plan(
                &PlanInput { probe: Some(&probe), options, audio_ordinal: 0, burn_sub: None, burn_bitmap: None, external_audio: None, force_video_encode: false, force_audio_encode: false },
                &caps,
            )
        };
        let copied = build(&CastOptions::default());
        assert_eq!(copied.hls_codecs, "avc1.640029,mp4a.40.2");
        assert!(!copied.hls_fmp4);
        let args = copied.output.join(" ");
        assert!(args.contains("-c:v copy -bsf:v h264_mp4toannexb"), "{args}");
        assert!(args.contains("-c:a copy"), "{args}");
        let louder = CastOptions { volume_boost: 50, night_mode: true, audio_delay_ms: -250, ..Default::default() };
        let args = build(&louder).output.join(" ");
        assert!(
            args.contains("-af dynaudnorm=f=200:g=15:p=0.9:m=10,volume=1.5,alimiter=limit=0.95:level=disabled,atrim=start=0.25,asetpts=PTS-STARTPTS"),
            "{args}"
        );
        assert!(args.contains("-c:a aac"));
        // Aspect and deinterlacing need the picture re-encoded.
        let wide = CastOptions { aspect: "4:3".into(), deinterlace: "always".into(), ..Default::default() };
        let args = build(&wide).output.join(" ");
        assert!(args.contains("-vf bwdif=mode=send_frame:deint=all,scale=1920:1080,setsar=1,setdar=4/3,format=yuv420p"), "{args}");
        let fill = CastOptions { aspect: "fill".into(), ..Default::default() };
        let scope = parse_probe(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":800}],"format":{}}"#,
        )
        .unwrap();
        let p = build_plan(
            &PlanInput { probe: Some(&scope), options: &fill, audio_ordinal: 0, burn_sub: None, burn_bitmap: None, external_audio: None, force_video_encode: false, force_audio_encode: false },
            &caps,
        );
        assert!(p.output.join(" ").contains("-vf crop=1422:800,scale=1422:800"), "{:?}", p.output);
    }

    #[test]
    fn dialogue_boost_only_applies_when_folding_surround_to_stereo() {
        let o = CastOptions { dialogue_boost: true, ..Default::default() };
        assert!(audio_filters(&o, 6, true)[0].starts_with("pan=stereo|FL<"));
        assert!(audio_filters(&o, 2, true).is_empty());
        assert!(audio_filters(&o, 6, false).is_empty());
    }

    #[test]
    fn local_inputs_never_get_http_options_and_seek_follows_the_session() {
        let job = CastJob {
            url: "C:/Films/movie.mp4".into(),
            headers: HashMap::new(),
            seek_sec: 754.2,
            fast_seek: true,
            plan: plan(None, &CastOptions::default(), &FfmpegCaps::default()),
            stats: SharedStats::default(),
            external_audio: None,
        };
        let args = job.input_args(true, &FfmpegCaps::default()).join(" ");
        assert!(!args.contains("-user_agent") && !args.contains("-reconnect"), "{args}");
        assert!(args.ends_with("-noaccurate_seek -ss 754.200 -i C:/Films/movie.mp4"), "{args}");
        assert_eq!(http_input_args("https://a/b.mkv", &HashMap::new(), true)[0], "-user_agent");
    }

    #[test]
    fn anamorphic_sources_keep_their_display_shape() {
        let probe = parse_probe(
            r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"mpeg2video","pix_fmt":"yuv420p","width":720,"height":576,"sample_aspect_ratio":"16:15","avg_frame_rate":"25/1"},
               {"index":1,"codec_type":"audio","codec_name":"ac3","channels":2}],"format":{"duration":"100"}}"#,
        )
        .unwrap();
        assert_eq!(probe.video.as_ref().and_then(|v| v.sar), Some((16, 15)));
        let options = CastOptions::default();
        let plan = build_plan(
            &PlanInput { probe: Some(&probe), options: &options, audio_ordinal: 0, burn_sub: None, burn_bitmap: None, external_audio: None, force_video_encode: false, force_audio_encode: false },
            &FfmpegCaps::default(),
        );
        let args = plan.output.join(" ");
        // 720x576 at 16:15 shows as 4:3, so square pixels need 768x576, not 720x576 (5:4).
        assert!(args.contains("scale=768:576,setsar=1"), "{args}");
    }

    #[test]
    fn hls_announces_the_profile_and_level_actually_sent() {
        let mut v = VideoInfo { codec: "hevc".into(), pix_fmt: "yuv420p".into(), height: 1080, ..Default::default() };
        assert_eq!(hevc_codec_string(&v), "hvc1.1.6.L123.B0");
        v.pix_fmt = "yuv420p10le".into();
        v.height = 2160;
        assert_eq!(hevc_codec_string(&v), "hvc1.2.4.L153.B0");
        assert_eq!(h264_codec_string(2160), "avc1.640033");
        assert_eq!(h264_codec_string(720), "avc1.640029");
    }

    #[test]
    fn unknown_option_values_fall_back_instead_of_failing() {
        let o: CastOptions = serde_json::from_str(r#"{"quality":"8k","audioMode":"weird","volumeBoost":25}"#).unwrap();
        assert_eq!(o.quality(), (1080, 14_000));
        assert!(o.hardware_encoding && o.hardware_decoding);
        assert_eq!(o.volume_boost, 25);
    }

    #[test]
    fn progress_lines_update_stats_and_errors_are_kept() {
        let stats = SharedStats::default();
        assert!(note_progress_line(&stats, "speed=3.91x"));
        assert!(note_progress_line(&stats, "out_time_us=12500000"));
        assert!(note_progress_line(&stats, "progress=continue"));
        assert!(!note_progress_line(&stats, "[in#0 @ 0x1] UDTA parsing failed retrying raw"));
        assert!(stats.lock().unwrap().error.is_none(), "a harmless note is not an error");
        assert!(!note_progress_line(&stats, "[in#0] Error opening input file"));
        let s = stats.lock().unwrap().clone();
        assert!((s.speed - 3.91).abs() < 1e-9 && (s.out_time_sec - 12.5).abs() < 1e-9 && s.running);
        assert!(s.error.as_deref().unwrap().contains("Error opening input"));
    }
}
