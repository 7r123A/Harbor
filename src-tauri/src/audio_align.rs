//! Lines an external audio track (another release's dub, a separately saved track) up with the
//! movie that is playing.
//!
//! Both tracks are reduced to onset-strength envelopes in a dozen broad bands. Music and effects
//! are shared by every dub of a film, so their onsets line up even when the dialogue differs, and
//! broad bands survive codec, mix and small pitch differences. The external envelope is searched
//! for every reference window: a coarse global search fixes the overall speed and offset, a local
//! search then tracks the offset across the film, and the anchors are grouped into piecewise linear
//! segments. A reel change, an inserted advert or a missing scene becomes a segment boundary, and
//! clock drift inside a segment becomes its slope.

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

/// PCM handed to [`FeatureExtractor`]: mono `f32` at this rate.
pub const PCM_RATE: u32 = 8000;
const HOP: usize = 80;
const NFFT: usize = 256;
/// Feature frames per second.
pub const FPS: f64 = PCM_RATE as f64 / HOP as f64;
pub const BANDS: usize = 12;

const COARSE_POOL: usize = 4;
const COARSE_WINDOW_SEC: f64 = 45.0;
const TRACK_WINDOW_SEC: f64 = 20.0;
const TRACK_STEP_SEC: f64 = 10.0;
const TRACK_RADIUS_SEC: f64 = 4.0;
const SEGMENT_TOLERANCE_SEC: f64 = 0.035;
const LONG_SEGMENT_SEC: f64 = 300.0;

/// Onset-strength features, `frames * BANDS` values in frame order.
#[derive(Clone, Debug, Default)]
pub struct Features {
    pub data: Vec<f32>,
}

impl Features {
    pub fn frames(&self) -> usize {
        self.data.len() / BANDS
    }

    pub fn duration_sec(&self) -> f64 {
        self.frames() as f64 / FPS
    }

    fn slice(&self, start: usize, len: usize) -> &[f32] {
        &self.data[start * BANDS..(start + len) * BANDS]
    }

    /// Averages `factor` consecutive frames; the coarse search runs on this.
    fn pooled(&self, factor: usize) -> Features {
        let frames = self.frames() / factor;
        let mut data = vec![0f32; frames * BANDS];
        for f in 0..frames {
            for k in 0..factor {
                let src = (f * factor + k) * BANDS;
                for b in 0..BANDS {
                    data[f * BANDS + b] += self.data[src + b];
                }
            }
            for b in 0..BANDS {
                data[f * BANDS + b] /= factor as f32;
            }
        }
        Features { data }
    }

    /// Resamples a sequence recorded at `ratio` external seconds per reference second onto the
    /// reference clock.
    fn stretched(&self, ratio: f64) -> Features {
        if (ratio - 1.0).abs() < 1e-9 || self.frames() < 2 {
            return self.clone();
        }
        let frames_out = (self.frames() as f64 / ratio) as usize;
        let last = self.frames() - 2;
        let mut data = vec![0f32; frames_out * BANDS];
        for f in 0..frames_out {
            let src = f as f64 * ratio;
            let i0 = (src as usize).min(last);
            let frac = (src - i0 as f64).clamp(0.0, 1.0) as f32;
            for b in 0..BANDS {
                let a = self.data[i0 * BANDS + b];
                let c = self.data[(i0 + 1) * BANDS + b];
                data[f * BANDS + b] = a + (c - a) * frac;
            }
        }
        Features { data }
    }
}

/// Streams mono PCM into features without holding the whole track in memory.
pub struct FeatureExtractor {
    window: Vec<f32>,
    bins: [(usize, usize); BANDS],
    fft: std::sync::Arc<dyn realfft::RealToComplex<f32>>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    pending: Vec<f32>,
    cursor: usize,
    prev: [f32; BANDS],
    started: bool,
    raw: Vec<f32>,
}

impl Default for FeatureExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl FeatureExtractor {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(NFFT);
        let window = (0..NFFT)
            .map(|i| {
                let x = std::f32::consts::PI * 2.0 * i as f32 / (NFFT - 1) as f32;
                0.5 - 0.5 * x.cos()
            })
            .collect();
        let bin_hz = PCM_RATE as f64 / NFFT as f64;
        let (lo, hi) = (100f64, 3600f64);
        let mut bins = [(0usize, 0usize); BANDS];
        for (i, slot) in bins.iter_mut().enumerate() {
            let f0 = lo * (hi / lo).powf(i as f64 / BANDS as f64);
            let f1 = lo * (hi / lo).powf((i + 1) as f64 / BANDS as f64);
            let b0 = (f0 / bin_hz).round() as usize;
            let b1 = ((f1 / bin_hz).round() as usize).max(b0 + 1);
            *slot = (b0, b1.min(NFFT / 2));
        }
        FeatureExtractor {
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            fft,
            window,
            bins,
            pending: Vec::new(),
            cursor: 0,
            prev: [0f32; BANDS],
            started: false,
            raw: Vec::new(),
        }
    }

    pub fn push(&mut self, pcm: &[f32]) {
        self.pending.extend_from_slice(pcm);
        while self.pending.len() - self.cursor >= NFFT {
            let frame = &self.pending[self.cursor..self.cursor + NFFT];
            for (dst, (&s, &w)) in self.input.iter_mut().zip(frame.iter().zip(&self.window)) {
                *dst = s * w;
            }
            if self.fft.process(&mut self.input, &mut self.spectrum).is_ok() {
                for (b, &(b0, b1)) in self.bins.iter().enumerate() {
                    let energy: f32 = self.spectrum[b0..b1].iter().map(|c| c.norm_sqr()).sum();
                    let level = (energy + 1e-7).ln();
                    let onset = if self.started { (level - self.prev[b]).max(0.0) } else { 0.0 };
                    self.prev[b] = level;
                    self.raw.push(onset);
                }
                self.started = true;
            }
            self.cursor += HOP;
        }
        if self.cursor > 1 << 16 {
            self.pending.drain(..self.cursor);
            self.cursor = 0;
        }
    }

    /// Normalises each band to zero mean and unit variance so loud bands do not dominate.
    pub fn finish(self) -> Features {
        let mut data = self.raw;
        let frames = data.len() / BANDS;
        data.truncate(frames * BANDS);
        if frames == 0 {
            return Features { data };
        }
        for b in 0..BANDS {
            let mut sum = 0f64;
            let mut sq = 0f64;
            for f in 0..frames {
                let v = data[f * BANDS + b] as f64;
                sum += v;
                sq += v * v;
            }
            let mean = sum / frames as f64;
            let std = (sq / frames as f64 - mean * mean).max(0.0).sqrt().max(1e-9);
            for f in 0..frames {
                let v = &mut data[f * BANDS + b];
                *v = ((*v as f64 - mean) / std) as f32;
            }
        }
        Features { data }
    }
}

#[cfg(test)]
fn features_from_pcm(pcm: &[f32]) -> Features {
    let mut extractor = FeatureExtractor::new();
    extractor.push(pcm);
    extractor.finish()
}

/// Cross-correlates reference windows against one whole external sequence.
struct GlobalCorrelator {
    n: usize,
    frames: usize,
    spectra: Vec<Vec<Complex<f32>>>,
    energy: Vec<f64>,
    planner: RealFftPlanner<f32>,
}

impl GlobalCorrelator {
    fn new(ext: &Features, max_window: usize) -> Self {
        let frames = ext.frames();
        let n = (frames + max_window + 1).next_power_of_two();
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let mut spectra = Vec::with_capacity(BANDS);
        let mut input = fwd.make_input_vec();
        for b in 0..BANDS {
            input.iter_mut().for_each(|v| *v = 0.0);
            for f in 0..frames {
                input[f] = ext.data[f * BANDS + b];
            }
            let mut out = fwd.make_output_vec();
            let _ = fwd.process(&mut input, &mut out);
            spectra.push(out);
        }
        GlobalCorrelator { n, frames, spectra, energy: energy_prefix(ext), planner }
    }

    /// Normalised correlation for every lag at which the window fits inside the sequence.
    fn ncc(&mut self, window: &[f32]) -> Vec<f32> {
        let w = window.len() / BANDS;
        if w == 0 || w > self.frames {
            return Vec::new();
        }
        let fwd = self.planner.plan_fft_forward(self.n);
        let inv = self.planner.plan_fft_inverse(self.n);
        let mut acc = vec![Complex::new(0f32, 0f32); self.n / 2 + 1];
        let mut input = fwd.make_input_vec();
        let mut out = fwd.make_output_vec();
        for b in 0..BANDS {
            input.iter_mut().for_each(|v| *v = 0.0);
            for t in 0..w {
                input[t] = window[t * BANDS + b];
            }
            if fwd.process(&mut input, &mut out).is_err() {
                return Vec::new();
            }
            for (a, (e, x)) in acc.iter_mut().zip(self.spectra[b].iter().zip(&out)) {
                *a += e * x.conj();
            }
        }
        acc[0].im = 0.0;
        if let Some(last) = acc.last_mut() {
            last.im = 0.0;
        }
        let mut corr = inv.make_output_vec();
        if inv.process(&mut acc, &mut corr).is_err() {
            return Vec::new();
        }
        normalise(&corr[..self.frames - w + 1], &self.energy, window, self.n as f32)
    }
}

fn energy_prefix(features: &Features) -> Vec<f64> {
    let frames = features.frames();
    let mut prefix = Vec::with_capacity(frames + 1);
    prefix.push(0.0);
    let mut acc = 0f64;
    for f in 0..frames {
        acc += features.data[f * BANDS..(f + 1) * BANDS]
            .iter()
            .map(|&v| (v as f64) * (v as f64))
            .sum::<f64>();
        prefix.push(acc);
    }
    prefix
}

fn normalise(corr: &[f32], energy: &[f64], window: &[f32], fft_len: f32) -> Vec<f32> {
    let w = window.len() / BANDS;
    let wn = window.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>().sqrt();
    corr.iter()
        .enumerate()
        .map(|(lag, &c)| {
            let local = (energy[lag + w] - energy[lag]).max(1e-9).sqrt();
            ((c / fft_len) as f64 / (local * wn).max(1e-9)) as f32
        })
        .collect()
}

/// Normalised correlation for lags `center - radius ..= center + radius` only.
fn local_ncc(
    ext: &Features,
    energy: &[f64],
    window: &[f32],
    center: isize,
    radius: usize,
    planner: &mut RealFftPlanner<f32>,
) -> Option<(Vec<f32>, usize)> {
    let w = window.len() / BANDS;
    let frames = ext.frames();
    if w == 0 || frames < w {
        return None;
    }
    let lo = (center - radius as isize).max(0) as usize;
    let hi = (center + radius as isize).min((frames - w) as isize);
    if hi < lo as isize {
        return None;
    }
    let hi = hi as usize;
    let seg_len = hi - lo + w;
    let n = (seg_len + w).next_power_of_two();
    let fwd = planner.plan_fft_forward(n);
    let inv = planner.plan_fft_inverse(n);
    let mut acc = vec![Complex::new(0f32, 0f32); n / 2 + 1];
    let mut a_in = fwd.make_input_vec();
    let mut b_in = fwd.make_input_vec();
    let mut a_out = fwd.make_output_vec();
    let mut b_out = fwd.make_output_vec();
    for b in 0..BANDS {
        a_in.iter_mut().for_each(|v| *v = 0.0);
        b_in.iter_mut().for_each(|v| *v = 0.0);
        for t in 0..seg_len {
            a_in[t] = ext.data[(lo + t) * BANDS + b];
        }
        for t in 0..w {
            b_in[t] = window[t * BANDS + b];
        }
        if fwd.process(&mut a_in, &mut a_out).is_err() || fwd.process(&mut b_in, &mut b_out).is_err() {
            return None;
        }
        for (a, (x, y)) in acc.iter_mut().zip(a_out.iter().zip(&b_out)) {
            *a += x * y.conj();
        }
    }
    acc[0].im = 0.0;
    if let Some(last) = acc.last_mut() {
        last.im = 0.0;
    }
    let mut corr = inv.make_output_vec();
    inv.process(&mut acc, &mut corr).ok()?;
    let local_energy = &energy[lo..];
    Some((normalise(&corr[..hi - lo + 1], local_energy, window, n as f32), lo))
}

#[derive(Clone, Copy, Debug)]
struct Peak {
    lag: f64,
    best: f32,
    second: f32,
    z: f32,
}

fn peak(ncc: &[f32], exclusion: usize) -> Option<Peak> {
    if ncc.len() < 3 {
        return None;
    }
    let (k, &best) = ncc
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    let n = ncc.len() as f64;
    let mean = ncc.iter().map(|&v| v as f64).sum::<f64>() / n;
    let var = ncc.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n;
    let z = ((best as f64 - mean) / var.sqrt().max(1e-12)) as f32;
    let second = ncc
        .iter()
        .enumerate()
        .filter(|(i, _)| i.abs_diff(k) > exclusion)
        .map(|(_, &v)| v)
        .fold(f32::MIN, f32::max);
    let mut lag = k as f64;
    if k > 0 && k + 1 < ncc.len() {
        let (a, b, c) = (ncc[k - 1] as f64, best as f64, ncc[k + 1] as f64);
        let den = a - 2.0 * b + c;
        if den < 0.0 {
            lag += (0.5 * (a - c) / den).clamp(-0.5, 0.5);
        }
    }
    Some(Peak { lag, best, second: second.max(0.0), z })
}

/// A decoded stretch of the reference. A local file is one clip covering the whole film; a
/// network source contributes evenly spaced clips.
pub struct RefClip {
    pub start_sec: f64,
    pub features: Features,
}

impl RefClip {
    fn window_at(&self, sec: f64, len_frames: usize) -> Option<&[f32]> {
        let start = ((sec - self.start_sec) * FPS).round();
        if start < 0.0 {
            return None;
        }
        let start = start as usize;
        (start + len_frames <= self.features.frames()).then(|| self.features.slice(start, len_frames))
    }
}

fn window_at(clips: &[RefClip], sec: f64, len_frames: usize) -> Option<&[f32]> {
    clips.iter().find_map(|clip| clip.window_at(sec, len_frames))
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Centre of the reference window.
    pub ref_sec: f64,
    /// External time (on the stretched clock) minus reference time.
    pub offset: f64,
    pub ncc: f32,
    pub z: f32,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start_sec: f64,
    pub end_sec: f64,
    /// External seconds per reference second.
    pub speed: f64,
    /// External time at reference time zero: `ext = speed * ref + intercept`.
    pub intercept: f64,
    pub anchors: usize,
    pub rms_ms: f64,
}

impl Segment {
    pub fn ext_at(&self, ref_sec: f64) -> f64 {
        self.speed * ref_sec + self.intercept
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// The external track is this film; it was synced throughout.
    Match,
    /// The film matches in places only, typically a different cut.
    Partial,
    /// Nothing reliable matched: it is probably another film.
    Mismatch,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alignment {
    pub ratio: f64,
    pub segments: Vec<Segment>,
    pub windows: usize,
    pub matched: usize,
    pub median_z: f32,
    pub verdict: Verdict,
}

impl Alignment {
    /// Overall offset at the film's midpoint, in seconds (positive: the external audio runs late).
    pub fn headline_offset(&self, ref_duration: f64) -> f64 {
        let mid = ref_duration / 2.0;
        self.segments
            .iter()
            .find(|s| s.start_sec <= mid && mid < s.end_sec)
            .or_else(|| self.segments.iter().max_by_key(|s| s.anchors))
            .map(|s| s.ext_at(mid) - mid)
            .unwrap_or(0.0)
    }
}

fn speed_candidates() -> [f64; 7] {
    let film = 24000.0 / 1001.0;
    [1.0, 25.0 / film, film / 25.0, 25.0 / 24.0, 24.0 / 25.0, 24.0 / film, film / 24.0]
}

fn coarse_probes(clips: &[RefClip], ref_duration: f64, window_sec: f64) -> Vec<f64> {
    let mut probes: Vec<f64> = [0.15, 0.35, 0.55, 0.75]
        .iter()
        .map(|f| ref_duration * f)
        .filter(|&t| window_at(clips, t, (window_sec * FPS) as usize).is_some())
        .collect();
    if probes.len() < 2 {
        // Network clips may be shorter than the coarse window; probe the start of each clip instead.
        probes = clips
            .iter()
            .filter(|c| c.features.duration_sec() >= window_sec)
            .map(|c| c.start_sec)
            .collect();
    }
    probes
}

struct Coarse {
    ratio: f64,
    offset: f64,
    score: f32,
    ext: Features,
}

fn coarse(clips: &[RefClip], ref_duration: f64, ext_raw: &Features, progress: &mut dyn FnMut(f32)) -> Option<Coarse> {
    let window_sec = clips
        .iter()
        .map(|c| c.features.duration_sec())
        .fold(0.0, f64::max)
        .min(COARSE_WINDOW_SEC);
    if window_sec < 8.0 {
        return None;
    }
    let probes = coarse_probes(clips, ref_duration, window_sec);
    if probes.is_empty() {
        return None;
    }
    let pooled_fps = FPS / COARSE_POOL as f64;
    let w_full = (window_sec * FPS) as usize;
    let w_pooled = w_full / COARSE_POOL;
    let mut best: Option<Coarse> = None;
    let candidates = speed_candidates();
    for (ci, &ratio) in candidates.iter().enumerate() {
        progress(ci as f32 / candidates.len() as f32);
        let ext = ext_raw.stretched(ratio);
        let pooled = ext.pooled(COARSE_POOL);
        if pooled.frames() <= w_pooled {
            continue;
        }
        let mut correlator = GlobalCorrelator::new(&pooled, w_pooled);
        let mut hits = Vec::new();
        for &p in &probes {
            let Some(window) = window_at(clips, p, w_full) else { continue };
            let window = Features { data: window.to_vec() }.pooled(COARSE_POOL);
            let ncc = correlator.ncc(&window.data);
            if let Some(pk) = peak(&ncc, (2.0 * pooled_fps) as usize) {
                hits.push((p, pk.lag / pooled_fps - p, pk.z));
            }
        }
        let Some((score, offset)) = consistent_offset(&hits) else { continue };
        if best.as_ref().is_none_or(|b| score > b.score) {
            best = Some(Coarse { ratio, offset, score, ext });
        }
        // A clear same-speed match makes the speed-changed alternatives pointless.
        if ratio == 1.0 && hits.len() >= 3 && score > 25.0 * (hits.len() as f32 * 0.6) {
            break;
        }
    }
    best
}

/// The right speed puts every probe at (nearly) the same offset, while a neighbouring speed still
/// correlates inside short windows but walks the offset steadily away. The score is the summed
/// strength of the largest group of probes that agree, allowing a little clock drift between them.
fn consistent_offset(hits: &[(f64, f64, f32)]) -> Option<(f32, f64)> {
    let mut best: Option<(f32, f64)> = None;
    for &(ti, oi, _) in hits {
        let members: Vec<&(f64, f64, f32)> = hits
            .iter()
            .filter(|&&(tj, oj, _)| (oi - oj).abs() <= 0.12 + 3e-4 * (ti - tj).abs())
            .collect();
        let score: f32 = members.iter().map(|m| m.2).sum();
        if best.is_none_or(|b| score > b.0) {
            let mut offsets: Vec<f64> = members.iter().map(|m| m.1).collect();
            best = Some((score, median_f64(&mut offsets)));
        }
    }
    best
}

fn median_f32(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

fn median_f64(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// Reference windows tracked across the film: every [`TRACK_STEP_SEC`] inside each clip, as
/// `(start second, window frames, clip)`.
fn track_positions(clips: &[RefClip]) -> Vec<(f64, usize, usize)> {
    let full = (TRACK_WINDOW_SEC * FPS) as usize;
    let min = (8.0 * FPS) as usize;
    let mut out = Vec::new();
    for (ci, clip) in clips.iter().enumerate() {
        let frames = clip.features.frames();
        if frames < min {
            continue;
        }
        let len = full.min(frames);
        let mut start = 0usize;
        while start + len <= frames {
            out.push((clip.start_sec + start as f64 / FPS, len, ci));
            start += (TRACK_STEP_SEC * FPS) as usize;
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn track(
    clips: &[RefClip],
    ext: &Features,
    start_offset: f64,
    progress: &mut dyn FnMut(f32),
) -> (Vec<Anchor>, usize) {
    let positions = track_positions(clips);
    let energy = energy_prefix(ext);
    let mut planner = RealFftPlanner::<f32>::new();
    let pooled = ext.pooled(COARSE_POOL);
    let mut global: Option<GlobalCorrelator> = None;
    let pooled_fps = FPS / COARSE_POOL as f64;
    let mut anchors = Vec::new();
    let mut estimate = start_offset;
    let total = positions.len();
    for (i, &(pos, len, ci)) in positions.iter().enumerate() {
        if i % 16 == 0 {
            progress(i as f32 / total.max(1) as f32);
        }
        let Some(window) = clips[ci].window_at(pos, len) else { continue };
        let centre = ((pos + estimate) * FPS).round() as isize;
        let mut found = None;
        if let Some((ncc, lo)) =
            local_ncc(ext, &energy, window, centre, (TRACK_RADIUS_SEC * FPS) as usize, &mut planner)
        {
            if ncc.len() > 50 {
                if let Some(pk) = peak(&ncc, (1.5 * FPS) as usize) {
                    if pk.z > 7.0 && pk.best > 0.06 && pk.best > 1.25 * pk.second {
                        found = Some(((lo as f64 + pk.lag) / FPS - pos, pk));
                    }
                }
            }
        }
        if found.is_none() {
            // Lost the track (an advert, a cut scene): search the whole external sequence.
            let correlator = global.get_or_insert_with(|| {
                GlobalCorrelator::new(&pooled, (TRACK_WINDOW_SEC * pooled_fps) as usize + 1)
            });
            let pooled_window = Features { data: window.to_vec() }.pooled(COARSE_POOL);
            let ncc = correlator.ncc(&pooled_window.data);
            if let Some(pk) = peak(&ncc, (2.0 * pooled_fps) as usize) {
                if pk.z > 9.0 && pk.best > 0.08 && pk.best > 1.5 * pk.second {
                    // Refine at full resolution around the coarse hit.
                    let centre = (pk.lag * COARSE_POOL as f64).round() as isize;
                    if let Some((ncc, lo)) =
                        local_ncc(ext, &energy, window, centre, (0.5 * FPS) as usize, &mut planner)
                    {
                        if let Some(fine) = peak(&ncc, (0.25 * FPS) as usize) {
                            found = Some(((lo as f64 + fine.lag) / FPS - pos, Peak { z: pk.z, ..fine }));
                        }
                    }
                }
            }
        }
        if let Some((offset, pk)) = found {
            let half = len as f64 / FPS / 2.0;
            anchors.push(Anchor { ref_sec: pos + half, offset, ncc: pk.best, z: pk.z });
            estimate = offset;
        }
    }
    (anchors, total)
}

/// Weighted least squares `offset = c0 + c1 * (t - tm)`; returns (c0, c1, tm).
fn fit(points: &[Anchor], fixed_slope: Option<f64>) -> (f64, f64, f64) {
    let wsum: f64 = points.iter().map(|p| p.z as f64).sum::<f64>().max(1e-9);
    let tm = points.iter().map(|p| p.ref_sec * p.z as f64).sum::<f64>() / wsum;
    let om = points.iter().map(|p| p.offset * p.z as f64).sum::<f64>() / wsum;
    if let Some(slope) = fixed_slope {
        return (om, slope, tm);
    }
    if points.len() < 3 {
        return (om, 0.0, tm);
    }
    let mut num = 0.0;
    let mut den = 0.0;
    for p in points {
        let w = p.z as f64;
        num += w * (p.ref_sec - tm) * (p.offset - om);
        den += w * (p.ref_sec - tm).powi(2);
    }
    let slope = if den > 1e-9 { num / den } else { 0.0 };
    (om, slope, tm)
}

fn predict(points: &[Anchor], t: f64) -> f64 {
    let (c0, c1, tm) = fit(points, None);
    c0 + c1 * (t - tm)
}

/// Groups consecutive anchors that agree on one linear mapping.
///
/// Dense anchors (a whole local file) resolve reel-change steps of a few tens of milliseconds.
/// Sparse anchors (network clips minutes apart) cannot tell such a step from drift, so only real
/// cuts split them.
fn group(anchors: &[Anchor]) -> Vec<Vec<Anchor>> {
    let mut gaps: Vec<f64> = anchors.windows(2).map(|w| w[1].ref_sec - w[0].ref_sec).collect();
    let tolerance = if median_f64(&mut gaps) > 60.0 { 0.15 } else { SEGMENT_TOLERANCE_SEC };
    let mut groups: Vec<Vec<Anchor>> = Vec::new();
    let mut current: Vec<Anchor> = Vec::new();
    let mut pending: Vec<Anchor> = Vec::new();
    for &a in anchors {
        if current.is_empty() {
            current.push(a);
            continue;
        }
        if (a.offset - predict(&current, a.ref_sec)).abs() <= tolerance {
            current.push(a);
            pending.clear();
            continue;
        }
        pending.push(a);
        let agree = pending.len() >= 2
            && (pending[pending.len() - 1].offset - pending[pending.len() - 2].offset).abs() <= tolerance;
        if agree {
            if current.len() >= 2 {
                groups.push(std::mem::take(&mut current));
            }
            current = std::mem::take(&mut pending);
        } else if pending.len() > 3 {
            pending.drain(..pending.len() - 2);
        }
    }
    if current.len() >= 2 {
        groups.push(current);
    }
    groups
}

fn span(points: &[Anchor]) -> f64 {
    match (points.first(), points.last()) {
        (Some(a), Some(b)) => b.ref_sec - a.ref_sec,
        _ => 0.0,
    }
}

struct Fitted {
    points: Vec<Anchor>,
    c0: f64,
    c1: f64,
    tm: f64,
}

impl Fitted {
    fn offset_at(&self, t: f64) -> f64 {
        self.c0 + self.c1 * (t - self.tm)
    }
}

fn clean_groups(groups: Vec<Vec<Anchor>>) -> Vec<Fitted> {
    // Drop groups too small to trust, and groups whose slope is not a plausible clock drift.
    let mut kept: Vec<Vec<Anchor>> = groups
        .into_iter()
        .filter(|g| g.len() >= 3 && (g.len() >= 5 || span(g) >= 30.0))
        .filter(|g| {
            let (_, slope, _) = fit(g, None);
            slope.abs() < 2e-3
        })
        .collect();
    // A segment must not jump backwards through the external track unless it is substantial:
    // credits music that also plays under the opening is the usual impostor.
    let mut monotonic: Vec<Vec<Anchor>> = Vec::new();
    for g in kept.drain(..) {
        if let Some(prev) = monotonic.last() {
            let prev_end = prev.last().map(|a| a.ref_sec + a.offset).unwrap_or(0.0);
            let this_start = g.first().map(|a| a.ref_sec + a.offset).unwrap_or(0.0);
            if this_start < prev_end - 5.0 && g.len() < 10 {
                continue;
            }
        }
        monotonic.push(g);
    }
    // Long segments reveal the real clock drift; short ones borrow it instead of fitting noise.
    let mut slopes: Vec<(f64, f64)> = monotonic
        .iter()
        .filter(|g| span(g) >= LONG_SEGMENT_SEC)
        .map(|g| (fit(g, None).1, g.len() as f64))
        .collect();
    let prior = weighted_median(&mut slopes).unwrap_or(0.0);
    let mut fitted: Vec<Fitted> = monotonic
        .into_iter()
        .map(|g| {
            let fixed = (span(&g) < LONG_SEGMENT_SEC).then_some(prior);
            let (c0, c1, tm) = fit(&g, fixed);
            Fitted { points: g, c0, c1, tm }
        })
        .collect();
    // Neighbours that meet without a step are one segment.
    let mut merged: Vec<Fitted> = Vec::new();
    for f in fitted.drain(..) {
        if let Some(prev) = merged.last_mut() {
            let boundary = (prev.points.last().map(|a| a.ref_sec).unwrap_or(0.0)
                + f.points.first().map(|a| a.ref_sec).unwrap_or(0.0))
                / 2.0;
            if (prev.offset_at(boundary) - f.offset_at(boundary)).abs() < 0.015
                && (prev.c1 - f.c1).abs() < 3e-5
            {
                prev.points.extend(f.points);
                let fixed = (span(&prev.points) < LONG_SEGMENT_SEC).then_some(prior);
                let (c0, c1, tm) = fit(&prev.points, fixed);
                prev.c0 = c0;
                prev.c1 = c1;
                prev.tm = tm;
                continue;
            }
        }
        merged.push(f);
    }
    merged
}

fn weighted_median(values: &mut [(f64, f64)]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = values.iter().map(|v| v.1).sum();
    let mut acc = 0.0;
    for v in values.iter() {
        acc += v.1;
        if acc >= total / 2.0 {
            return Some(v.0);
        }
    }
    values.last().map(|v| v.0)
}

/// Where mapping `a` hands over to mapping `b`, as `(end of a, start of b)`.
///
/// When the second mapping runs earlier through the external track, the external release lacks
/// that much of the film (a cut scene); the hand-over then leaves exactly that much silence rather
/// than replaying audio already heard. Short windows between the outermost anchors place the cut.
fn boundary(clips: &[RefClip], ext: &Features, a: &Fitted, b: &Fitted) -> (f64, f64) {
    let lo = a.points.last().map(|p| p.ref_sec).unwrap_or(0.0);
    let hi = b.points.first().map(|p| p.ref_sec).unwrap_or(lo);
    let mid = (lo + hi) / 2.0;
    let missing = (a.offset_at(mid) - b.offset_at(mid)).max(0.0);
    let fallback = (mid - missing / 2.0, mid + missing / 2.0);
    const STEP: f64 = 0.25;
    let w = (3.0 * FPS) as usize;
    let mut scores: Vec<(f64, f64, f64)> = Vec::new();
    let mut t = lo - 10.0;
    while t <= hi + 10.0 {
        if let Some(window) = window_at(clips, t - 1.5, w) {
            let score = |f: &Fitted| -> f64 {
                let e = ((t - 1.5 + f.offset_at(t)) * FPS).round();
                if e < 0.0 || e as usize + w > ext.frames() {
                    return -1.0;
                }
                let seg = ext.slice(e as usize, w);
                let (mut xy, mut xx, mut yy) = (0f64, 0f64, 0f64);
                for (&x, &y) in window.iter().zip(seg) {
                    xy += x as f64 * y as f64;
                    xx += x as f64 * x as f64;
                    yy += y as f64 * y as f64;
                }
                xy / (xx * yy).sqrt().max(1e-9)
            };
            scores.push((t, score(a), score(b)));
        }
        t += STEP;
    }
    if scores.len() < 4 {
        return fallback;
    }
    let skip = (missing / STEP).round() as usize;
    let mut best = (f64::MIN, fallback);
    for split in 0..scores.len() {
        let before: f64 = scores[..=split].iter().map(|s| s.1).sum();
        let resume = (split + 1 + skip).min(scores.len());
        let after: f64 = scores[resume..].iter().map(|s| s.2).sum();
        if before + after > best.0 {
            let end = scores[split].0 + STEP / 2.0;
            best = (before + after, (end, end + missing));
        }
    }
    best.1
}

/// Runs the whole analysis. `progress` receives 0..1.
pub fn analyze(
    clips: &[RefClip],
    ref_duration: f64,
    ext_raw: &Features,
    progress: &mut dyn FnMut(f32),
) -> Alignment {
    let empty = |ratio, windows| Alignment {
        ratio,
        segments: Vec::new(),
        windows,
        matched: 0,
        median_z: 0.0,
        verdict: Verdict::Mismatch,
    };
    let Some(coarse) = coarse(clips, ref_duration, ext_raw, &mut |p| progress(p * 0.3)) else {
        return empty(1.0, 0);
    };
    let (anchors, windows) = track(clips, &coarse.ext, coarse.offset, &mut |p| progress(0.3 + p * 0.6));
    let fitted = clean_groups(group(&anchors));
    if fitted.is_empty() {
        return empty(coarse.ratio, windows);
    }
    // Segment i covers [starts[i], ends[i]); a gap between them stays silent.
    let mut starts = vec![0.0];
    let mut ends = Vec::with_capacity(fitted.len());
    for pair in fitted.windows(2) {
        let (end, start) = boundary(clips, &coarse.ext, &pair[0], &pair[1]);
        ends.push(end);
        starts.push(start);
    }
    ends.push(ref_duration);
    progress(0.95);
    let mut segments = Vec::with_capacity(fitted.len());
    let mut matched = 0usize;
    let mut zs: Vec<f32> = Vec::new();
    for (i, f) in fitted.iter().enumerate() {
        // ext_stretched = t + c0 + c1 (t - tm); raw external time is that times the base ratio.
        let speed = coarse.ratio * (1.0 + f.c1);
        let intercept = coarse.ratio * (f.c0 - f.c1 * f.tm);
        let residuals: Vec<f64> = f.points.iter().map(|p| p.offset - f.offset_at(p.ref_sec)).collect();
        let rms = (residuals.iter().map(|r| r * r).sum::<f64>() / residuals.len().max(1) as f64).sqrt();
        matched += f.points.len();
        zs.extend(f.points.iter().map(|p| p.z));
        segments.push(Segment {
            start_sec: starts[i],
            end_sec: ends[i],
            speed,
            intercept,
            anchors: f.points.len(),
            rms_ms: rms * 1000.0,
        });
    }
    let median_z = median_f32(&mut zs);
    let coverage = matched as f64 / windows.max(1) as f64;
    let verdict = if coverage >= 0.45 && median_z >= 12.0 {
        Verdict::Match
    } else if matched >= 6 && coverage >= 0.12 && median_z >= 10.0 {
        Verdict::Partial
    } else {
        Verdict::Mismatch
    };
    progress(1.0);
    Alignment { ratio: coarse.ratio, segments, windows, matched, median_z, verdict }
}

/// One stretch of the output: reference `[ref_start, ref_end)` is filled from the external track
/// starting at `ext_start`, played at `speed` external seconds per reference second.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Piece {
    pub ref_start: f64,
    pub ref_end: f64,
    pub ext_start: f64,
    pub speed: f64,
}

/// Clips every segment to the external track's extent. Reference time no segment can fill stays
/// silent in the output.
pub fn pieces(alignment: &Alignment, ref_duration: f64, ext_duration: f64) -> Vec<Piece> {
    let mut out = Vec::new();
    for s in &alignment.segments {
        let mut t0 = s.start_sec.max(0.0);
        let mut t1 = s.end_sec.min(ref_duration);
        t0 = t0.max(-s.intercept / s.speed);
        t1 = t1.min((ext_duration - s.intercept) / s.speed);
        if t1 - t0 > 0.05 {
            out.push(Piece { ref_start: t0, ref_end: t1, ext_start: s.ext_at(t0), speed: s.speed });
        }
    }
    out
}

/// The ffmpeg `-filter_complex` graph and per-input seek arguments that render `pieces` from the
/// external file into one track on the reference clock. Input `i` must be opened with
/// `inputs[i]` = (`-ss`, `-t`) before `-i <external file>`.
pub struct RenderGraph {
    pub inputs: Vec<(f64, f64)>,
    pub filter: String,
    pub duration: f64,
}

pub fn render_graph(
    pieces: &[Piece],
    stream_ordinal: u32,
    layout: &str,
    sample_rate: u32,
    keep_pitch: bool,
) -> Option<RenderGraph> {
    if pieces.is_empty() {
        return None;
    }
    let mut inputs = Vec::new();
    let mut chains = Vec::new();
    let mut labels = String::new();
    let mut cursor = 0.0;
    for (i, p) in pieces.iter().enumerate() {
        if p.ref_start - cursor > 0.0005 {
            let gap = p.ref_start - cursor;
            chains.push(format!(
                "anullsrc=r={sample_rate}:cl={layout},atrim=duration={gap:.6}[g{i}]"
            ));
            labels.push_str(&format!("[g{i}]"));
        }
        let length = p.ref_end - p.ref_start;
        let ext_len = length * p.speed;
        inputs.push((p.ext_start.max(0.0), ext_len + 0.5));
        let mut chain = format!("[{i}:a:{stream_ordinal}]aresample={sample_rate}");
        if (p.speed - 1.0).abs() > 1e-7 {
            if keep_pitch {
                chain.push_str(&format!(",atempo={:.9}", p.speed));
            } else {
                chain.push_str(&format!(
                    ",asetrate={:.6},aresample={sample_rate}",
                    sample_rate as f64 * p.speed
                ));
            }
        }
        chain.push_str(&format!(
            ",aformat=sample_fmts=fltp:channel_layouts={layout},apad=whole_dur={length:.6},atrim=duration={length:.6}[p{i}]"
        ));
        chains.push(chain);
        labels.push_str(&format!("[p{i}]"));
        cursor = p.ref_end;
    }
    let count = labels.matches('[').count();
    chains.push(format!("{labels}concat=n={count}:v=0:a=1[out]"));
    Some(RenderGraph { inputs, filter: chains.join(";"), duration: cursor })
}

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyStats {
    pub windows: usize,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Measures the remaining offset between the reference and a rendered track that should now be
/// on the same clock.
pub fn verify(clips: &[RefClip], ref_duration: f64, rendered: &Features) -> VerifyStats {
    let energy = energy_prefix(rendered);
    let mut planner = RealFftPlanner::<f32>::new();
    let w = (TRACK_WINDOW_SEC * FPS) as usize;
    let mut errors = Vec::new();
    let step = (ref_duration / 40.0).max(30.0);
    let mut pos = 20.0;
    let mut positions = Vec::new();
    while pos + TRACK_WINDOW_SEC < ref_duration {
        positions.push(pos);
        pos += step;
    }
    for clip in clips {
        positions.push(clip.start_sec);
    }
    for pos in positions {
        let Some(window) = window_at(clips, pos, w) else { continue };
        let centre = (pos * FPS).round() as isize;
        let Some((ncc, lo)) = local_ncc(rendered, &energy, window, centre, (1.5 * FPS) as usize, &mut planner)
        else {
            continue;
        };
        if let Some(pk) = peak(&ncc, (0.5 * FPS) as usize) {
            if pk.z > 7.0 && pk.best > 0.06 {
                errors.push(((lo as f64 + pk.lag) / FPS - pos) * 1000.0);
            }
        }
    }
    if errors.is_empty() {
        return VerifyStats::default();
    }
    let mut abs: Vec<f64> = errors.iter().map(|e| e.abs()).collect();
    let median = median_f64(&mut errors.clone());
    abs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p95 = abs[((abs.len() as f64 * 0.95) as usize).min(abs.len() - 1)];
    VerifyStats { windows: errors.len(), median_ms: median, p95_ms: p95, max_ms: *abs.last().unwrap_or(&0.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-random "film": sparse onsets with music-like repetition.
    fn film(seconds: f64, seed: u64) -> Features {
        let frames = (seconds * FPS) as usize;
        let mut state = seed;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % 10_000) as f32 / 10_000.0
        };
        let mut data = vec![0f32; frames * BANDS];
        for f in 0..frames {
            for b in 0..BANDS {
                let r = next();
                data[f * BANDS + b] = if r > 0.93 { r * 4.0 } else { r * 0.2 };
            }
        }
        Features { data }
    }

    fn take(src: &Features, start_sec: f64, len_sec: f64) -> Features {
        let s = (start_sec * FPS) as usize;
        let n = ((len_sec * FPS) as usize).min(src.frames() - s);
        Features { data: src.slice(s, n).to_vec() }
    }

    fn concat(parts: &[Features]) -> Features {
        Features { data: parts.iter().flat_map(|p| p.data.iter().copied()).collect() }
    }

    fn noisy(src: &Features, seed: u64) -> Features {
        let noise = film(src.duration_sec() + 1.0, seed);
        Features {
            data: src.data.iter().zip(&noise.data).map(|(&a, &n)| a * 0.8 + n * 0.5).collect(),
        }
    }

    #[test]
    fn finds_a_constant_offset_and_verifies_the_render_plan() {
        let reference = film(1800.0, 7);
        // External release starts 2.37 s later: it has extra audio before the film begins.
        let lead = film(2.37, 99);
        let ext = noisy(&concat(&[lead, take(&reference, 0.0, 1800.0)]), 3);
        let clips = [RefClip { start_sec: 0.0, features: reference.clone() }];
        let al = analyze(&clips, 1800.0, &ext, &mut |_| {});
        assert_eq!(al.verdict, Verdict::Match);
        assert_eq!(al.segments.len(), 1, "{:?}", al.segments);
        let seg = &al.segments[0];
        assert!((seg.ext_at(900.0) - 902.37).abs() < 0.012, "{seg:?}");
        assert!((seg.speed - 1.0).abs() < 1e-4);
        let pieces = pieces(&al, 1800.0, ext.duration_sec());
        assert_eq!(pieces.len(), 1);
        assert!((pieces[0].ext_start - 2.37).abs() < 0.012, "{pieces:?}");
    }

    #[test]
    fn detects_pal_speed_and_cut_segments() {
        let reference = film(2400.0, 11);
        let film_rate = 24000.0 / 1001.0;
        let pal = 25.0 / film_rate;
        // External: an advert inserted at 1000 s, and the whole thing sped up to PAL.
        let advert = film(95.0, 5);
        let ext_film = concat(&[take(&reference, 0.0, 1000.0), advert, take(&reference, 1000.0, 1400.0)]);
        let ext = noisy(&ext_film.stretched(pal), 21);
        let clips = [RefClip { start_sec: 0.0, features: reference }];
        let al = analyze(&clips, 2400.0, &ext, &mut |_| {});
        assert_eq!(al.verdict, Verdict::Match, "{al:?}");
        assert!((al.ratio - 1.0 / pal).abs() < 1e-6, "ratio {}", al.ratio);
        assert_eq!(al.segments.len(), 2, "{:?}", al.segments);
        let (a, b) = (&al.segments[0], &al.segments[1]);
        assert!((a.end_sec - 1000.0).abs() < 3.0, "boundary at {}", a.end_sec);
        // Before the advert: external time = t / pal; after it the advert adds 95 s / pal.
        assert!((a.ext_at(500.0) - 500.0 / pal).abs() < 0.03, "{a:?}");
        assert!((b.ext_at(1500.0) - (1500.0 + 95.0) / pal).abs() < 0.03, "{b:?}");
    }

    #[test]
    fn rejects_a_different_film() {
        let reference = film(1200.0, 1);
        let other = film(1200.0, 2);
        let clips = [RefClip { start_sec: 0.0, features: reference }];
        let al = analyze(&clips, 1200.0, &other, &mut |_| {});
        assert_eq!(al.verdict, Verdict::Mismatch, "{al:?}");
    }

    #[test]
    fn network_clips_still_align() {
        let reference = film(3600.0, 4);
        let ext = noisy(&concat(&[film(0.8, 8), take(&reference, 0.0, 3600.0)]), 12);
        let clips: Vec<RefClip> = (0..12)
            .map(|i| {
                let start = 120.0 + i as f64 * 280.0;
                RefClip { start_sec: start, features: take(&reference, start, 30.0) }
            })
            .collect();
        let al = analyze(&clips, 3600.0, &ext, &mut |_| {});
        assert_eq!(al.verdict, Verdict::Match, "{al:?}");
        assert!((al.headline_offset(3600.0) - 0.8).abs() < 0.015, "{al:?}");
    }

    #[test]
    fn render_graph_fills_gaps_and_keeps_the_reference_clock() {
        let pieces = [
            Piece { ref_start: 0.6, ref_end: 100.0, ext_start: 0.0, speed: 1.0 },
            Piece { ref_start: 100.0, ref_end: 200.0, ext_start: 150.0, speed: 1.00007 },
        ];
        assert!(render_graph(&[], 0, "stereo", 48000, false).is_none());
        let graph = render_graph(&pieces, 1, "stereo", 48000, false).expect("graph");
        assert_eq!(graph.inputs.len(), 2);
        assert!(graph.filter.starts_with("anullsrc=r=48000:cl=stereo,atrim=duration=0.600000[g0]"));
        assert!(graph.filter.contains("[0:a:1]aresample=48000,aformat"));
        assert!(graph.filter.contains("asetrate=48003.360000,aresample=48000"));
        assert!(graph.filter.ends_with("[g0][p0][p1]concat=n=3:v=0:a=1[out]"));
        assert!((graph.duration - 200.0).abs() < 1e-9);
    }

    #[test]
    fn extractor_matches_one_shot_features() {
        let pcm: Vec<f32> = (0..PCM_RATE as usize * 3)
            .map(|i| (i as f32 * 0.37).sin() * ((i / 400) % 3) as f32)
            .collect();
        let whole = features_from_pcm(&pcm);
        let mut streamed = FeatureExtractor::new();
        for chunk in pcm.chunks(1234) {
            streamed.push(chunk);
        }
        let streamed = streamed.finish();
        assert_eq!(whole.frames(), streamed.frames());
        assert!(whole.data.iter().zip(&streamed.data).all(|(a, b)| (a - b).abs() < 1e-4));
    }
}
