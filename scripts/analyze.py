"""Derive editable modal + sub-band procedural synthesis profiles from reference WAVs.

Requires Python 3 and ffmpeg on PATH. Downloads are cached in .cache/reference.
Uses the upstream sprite offsets: down at n seconds, up at n + .2 seconds.
No PCM audio is embedded in src/profiles.json.
"""
import array
import cmath
import concurrent.futures
import json
import math
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'reference'
CACHE.mkdir(parents=True, exist_ok=True)
SR = 48000

# 7 perceptual sub-bands spanning 35 Hz - 19.5 kHz: (low_hz, high_hz, nominal_hz, Q)
BAND_DEFS = [
    (35, 140, 80, 1.0),
    (140, 380, 230, 1.2),
    (380, 950, 600, 1.3),
    (950, 2300, 1500, 1.4),
    (2300, 5400, 3500, 1.4),
    (5400, 11000, 7800, 1.4),
    (11000, 19500, 14500, 1.2),
]

# Precompute Hann windows and twiddle tables for fast pure-Python radix-2 FFT.
_HANN = {}
_TWIDDLE = {}


def _hann(n):
    w = _HANN.get(n)
    if w is None:
        w = [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]
        _HANN[n] = w
    return w


def fft(values):
    n = len(values)
    if n <= 1:
        return values
    # Iterative Cooley-Tukey radix-2 FFT (much faster than recursive in CPython).
    bits = n.bit_length() - 1
    out = [0j] * n
    for i in range(n):
        j = int(f'{i:0{bits}b}'[::-1], 2)
        out[j] = values[i]
    size = 2
    while size <= n:
        half = size // 2
        tw = _TWIDDLE.get(size)
        if tw is None:
            step = -2j * math.pi / size
            tw = [cmath.exp(step * k) for k in range(half)]
            _TWIDDLE[size] = tw
        for start in range(0, n, size):
            for k in range(half):
                u = out[start + k]
                v = tw[k] * out[start + k + half]
                out[start + k] = u + v
                out[start + k + half] = u - v
        size *= 2
    return out


def _taper_window(n):
    """Flat-top start (weight 1.0 at t=0 so short transients are never attenuated), half-Hann fade on last 25%."""
    w = _HANN.get(('taper', n))
    if w is None:
        fade = n // 4
        w = [1.0] * (n - fade) + [0.5 + 0.5 * math.cos(math.pi * i / max(1, fade - 1)) for i in range(fade)]
        _HANN[('taper', n)] = w
    return w


def power_spectrum(samples, n, taper=False):
    frame = samples[:n]
    if len(frame) < n:
        frame = frame + [0.0] * (n - len(frame))
    w = _taper_window(n) if taper else _hann(n)
    scale = 2.0 / n
    spec = fft([frame[i] * w[i] for i in range(n)])
    return [(spec[k].real * spec[k].real + spec[k].imag * spec[k].imag) * (scale * scale) for k in range(n // 2)]


def detect_events(samples):
    """Detect up to 4 distinct sub-impact bursts from a 1.5ms RMS envelope."""
    hop = int(0.0015 * SR)  # 72 samples = 1.5ms
    win = hop * 2
    max_samples = min(len(samples), int(0.35 * SR))
    if max_samples < win:
        return [(0, 1.0)]
    env = []
    for i in range(0, max_samples - win + 1, hop):
        seg = samples[i:i + win]
        env.append(math.sqrt(sum(x * x for x in seg) / win))
    emax = max(env, default=0.0)
    if emax <= 1e-6:
        return [(0, 1.0)]

    # Find local maxima above 16% of strongest burst, separated by >= 6ms (4 hops).
    candidates = []
    for i in range(len(env)):
        left = env[i - 1] if i > 0 else 0.0
        right = env[i + 1] if i + 1 < len(env) else 0.0
        if env[i] >= left and env[i] >= right and env[i] >= emax * 0.16:
            # Must stand out from the local valley before it (avoid catching smooth decay tails).
            if i == 0:
                candidates.append((i, env[i]))
            else:
                valley = min(env[max(0, i - 4):i])
                if env[i] > valley * 1.35 or env[i] == emax:
                    candidates.append((i, env[i]))

    # Non-maximum suppression within 7.5ms (5 hops) to keep distinct mechanical hits.
    candidates.sort(key=lambda item: item[1], reverse=True)
    selected = []
    for idx, val in candidates:
        if all(abs(idx - s_idx) >= 5 for s_idx, _ in selected):
            selected.append((idx, val))
        if len(selected) == 4:
            break
    selected.sort(key=lambda item: item[0])
    if not selected:
        return [(0, 1.0)]
    return [(idx * hop, val / emax) for idx, val in selected]


def burst_spectral_stats(samples, center_sample):
    """Return (centroid_hz, dom_freq_hz) for a short window around a sub-event."""
    n = 512
    start = max(0, center_sample - 64)
    p = power_spectrum(samples[start:start + n], n)
    lo, hi = 2, n // 2 - 1
    tot = sum(p[lo:hi]) + 1e-12
    centroid = sum(k * (SR / n) * p[k] for k in range(lo, hi)) / tot
    k_max = max(range(lo, hi), key=lambda k: p[k])
    return centroid, k_max * (SR / n)


def features(samples):
    peak = max((abs(x) for x in samples), default=0.0)
    if peak < 0.001:
        return None

    # Trim leading silence before the first real acoustic onset.
    thresh = max(peak * 0.04, 0.003)
    start = next((i for i, x in enumerate(samples) if abs(x) >= thresh), 0)
    samples = samples[start:]
    if len(samples) < 64:
        return None

    # Detect multi-hit structure (e.g. lock-open pre-tick + main clack, ps5-double, bonus trills).
    raw_events = detect_events(samples)
    main_idx = max(range(len(raw_events)), key=lambda i: raw_events[i][1])
    main_sample = raw_events[main_idx][0]
    main_centroid, main_dom = burst_spectral_stats(samples, main_sample)

    events = []
    if len(raw_events) > 1:
        t0 = raw_events[0][0]
        for ev_sample, ev_gain in raw_events:
            at = round((ev_sample - t0) / SR, 4)
            c, d = burst_spectral_stats(samples, ev_sample)
            p_ratio = round(max(0.4, min(2.5, d / max(60.0, main_dom))), 3) if main_dom > 80 else 1.0
            b_ratio = round(max(0.35, min(2.8, c / max(120.0, main_centroid))), 3)
            events.append([at, round(ev_gain, 3), p_ratio, b_ratio])

    # Analyze the main burst window (starting just before its peak).
    burst_start = max(0, main_sample - int(0.0015 * SR))
    # Stop before a later stronger/equal burst if one exists, else up to 220ms.
    next_burst_limit = int(0.22 * SR)
    if main_idx + 1 < len(raw_events):
        gap = raw_events[main_idx + 1][0] - burst_start
        if gap > int(0.012 * SR):
            next_burst_limit = min(next_burst_limit, gap)
    burst = samples[burst_start:burst_start + next_burst_limit]
    if len(burst) < 128:
        burst = samples[:int(0.22 * SR)]

    # Measure attack time (time from 10% to 90% of burst peak).
    b_peak = max((abs(x) for x in burst), default=peak)
    i10 = next((i for i, x in enumerate(burst) if abs(x) >= b_peak * 0.1), 0)
    i90 = next((i for i, x in enumerate(burst[i10:]) if abs(x) >= b_peak * 0.9), 0)
    attack = max(0.00015, min(0.012, i90 / SR))

    # --- 1. High-resolution tonal mode extraction (N=2048 -> 23.4 Hz bins) ---
    n_hi = 2048
    # Use flat-start taper window so t=0..3ms click transients retain 100% of their true energy!
    p_hi = power_spectrum(burst[:n_hi], n_hi, taper=True)

    # STFT for per-mode and low-band decay measurement (N=1024, hop=192 = 4ms).
    n_mid = 1024
    hop_mid = 192
    frames_mid = []
    for off in range(0, min(len(burst), int(0.18 * SR)), hop_mid):
        if off + 64 > len(burst):
            break
        frames_mid.append(power_spectrum(burst[off:off + n_mid], n_mid, taper=(off == 0)))

    # Fast STFT for high-band decay measurement (N=256, hop=48 = 1ms).
    n_fast = 256
    hop_fast = 48
    frames_fast = []
    for off in range(0, min(len(burst), int(0.12 * SR)), hop_fast):
        if off + 32 > len(burst):
            break
        frames_fast.append(power_spectrum(burst[off:off + n_fast], n_fast, taper=(off == 0)))

    # Identify genuinely tonal peaks by local prominence over median spectral floor.
    bin_hz = SR / n_hi
    k_lo = max(3, int(65 / bin_hz))
    k_hi = min(n_hi // 2 - 3, int(14000 / bin_hz))
    candidates = []
    for k in range(k_lo, k_hi):
        val = p_hi[k]
        if val <= p_hi[k - 1] or val <= p_hi[k + 1]:
            continue
        # Local neighborhood excluding the peak itself.
        neigh = p_hi[max(1, k - 14):max(1, k - 2)] + p_hi[min(n_hi // 2, k + 3):min(n_hi // 2, k + 15)]
        if not neigh:
            continue
        neigh.sort()
        floor = neigh[len(neigh) // 2] + 1e-12
        prom = val / floor
        # Require stronger prominence at very low bins (<160 Hz) where Hann lobes are wide.
        min_prom = 22.0 if k * bin_hz < 160.0 else 9.0
        if prom >= min_prom:
            # Parabolic interpolation for exact frequency.
            a, b, c = math.log(p_hi[k - 1] + 1e-15), math.log(val + 1e-15), math.log(p_hi[k + 1] + 1e-15)
            denom = (a - 2.0 * b + c)
            delta = 0.5 * (a - c) / denom if abs(denom) > 1e-9 else 0.0
            delta = max(-0.5, min(0.5, delta))
            hz = (k + delta) * bin_hz
            tonal = min(1.0, (prom - min_prom) / 20.0)
            # Initial RMS estimate for this tonal peak.
            amp = math.sqrt(val) * tonal
            candidates.append((amp * amp, hz, amp, k, prom))

    candidates.sort(key=lambda item: item[0], reverse=True)
    modes = []
    mode_bins_hi = []
    for _, hz, amp, k_peak, prom in candidates:
        if all(abs(hz - m[0]) > max(55.0, hz * 0.065) for m in modes):
            # Measure this mode's decay constant tau_a from STFT frames.
            if hz < 500 or not frames_fast:
                stft, n_s, hop_s = frames_mid, n_mid, hop_mid
            else:
                stft, n_s, hop_s = frames_fast, n_fast, hop_fast
            ks = max(1, min(n_s // 2 - 2, round(hz * n_s / SR)))
            energies = [max(fr[ks - 1], fr[ks], fr[ks + 1]) for fr in stft]
            e_tot = sum(energies)
            if e_tot > 1e-12:
                # First moment of energy -> tau_a = 2 * sum(t * E) / sum(E).
                tau = 2.0 * sum((i * hop_s / SR) * e for i, e in enumerate(energies)) / e_tot
            else:
                tau = 0.008
            tau = max(0.0018, min(0.18, tau))

            # Check for genuine pitch sweep on strong tonal modes.
            ef = None
            if prom > 18 and len(frames_mid) >= 3:
                k_m = max(2, min(n_mid // 2 - 3, round(hz * n_mid / SR)))
                search_r = max(2, min(8, int(k_m * 0.25)))
                fr0 = frames_mid[0]
                e0 = max(fr0[max(1, k_m - search_r):min(n_mid // 2, k_m + search_r + 1)])
                # Find a later frame that still has >= 15% of early energy.
                late_idx = None
                for fi in range(2, min(len(frames_mid), 7)):
                    fr_l = frames_mid[fi]
                    el = max(fr_l[max(1, k_m - search_r):min(n_mid // 2, k_m + search_r + 1)])
                    if el >= e0 * 0.12:
                        late_idx = fi
                if late_idx is not None:
                    lo_s = max(1, k_m - search_r)
                    hi_s = min(n_mid // 2, k_m + search_r + 1)
                    k_early = max(range(lo_s, hi_s), key=lambda j: fr0[j])
                    k_late = max(range(lo_s, hi_s), key=lambda j: frames_mid[late_idx][j])
                    f_early = k_early * (SR / n_mid)
                    f_late = k_late * (SR / n_mid)
                    ratio = f_late / max(30.0, f_early)
                    if 0.6 <= ratio <= 1.6 and abs(ratio - 1.0) >= 0.07:
                        ef = round(hz * ratio, 1)

            entry = [round(hz, 1), round(amp, 4), round(tau, 4)]
            if ef is not None:
                entry.append(ef)
            modes.append(entry)
            mode_bins_hi.append((hz, amp))
        if len(modes) == 8:
            break

    # --- 2. Multi-band broadband noise analysis (7 perceptual bands, 35 Hz - 19.5 kHz) ---
    # Compute residual broadband energy & decay in each band, subtracting tonal mode energy
    # so tonal sounds (tonal-on, synth-on) stay clean and broadband clicks stay rich & crisp.
    bands = []

    # Full-burst Parseval energy for accurate absolute calibration.
    burst_energy = sum(x * x for x in burst) / SR  # integral of x(t)^2 dt
    # Spectrum of burst over first 2048 samples with flat-start taper (preserves t=0 click!).
    p_full = power_spectrum(burst[:n_hi], n_hi, taper=True)
    # Subtract sharp tonal mode peaks (+ Hann main lobe skirt) from p_full to get residual spectrum.
    p_res = list(p_full)
    for hz, _ in mode_bins_hi:
        km = round(hz / bin_hz)
        neigh = p_full[max(1, km - 12):max(1, km - 4)] + p_full[min(n_hi // 2, km + 5):min(n_hi // 2, km + 13)]
        floor = sorted(neigh)[len(neigh) // 2] if neigh else 0.0
        for j in range(max(1, km - 4), min(n_hi // 2, km + 5)):
            p_res[j] = min(p_res[j], floor)

    res_sum = sum(p_res[1:]) + 1e-12
    full_sum = sum(p_full[1:]) + 1e-12
    residual_ratio = max(0.0, min(1.0, res_sum / full_sum))
    residual_energy = burst_energy * residual_ratio

    for b_idx, (f_lo, f_hi, f_nom, q) in enumerate(BAND_DEFS):
        k0 = max(1, int(f_lo / bin_hz))
        k1 = min(n_hi // 2, int(f_hi / bin_hz))
        if k1 <= k0:
            continue
        b_pow = sum(p_res[k0:k1])
        b_frac = b_pow / res_sum
        if b_frac < 0.008:
            continue

        # Spectral centroid within this band -> puts the Web Audio bandpass right on the formant!
        b_centroid = sum(k * bin_hz * p_res[k] for k in range(k0, k1)) / (b_pow + 1e-12)
        b_freq = max(f_lo * 1.05, min(f_hi * 0.95, b_centroid))

        # Per-band decay constant from STFT.
        if b_idx <= 1:
            stft, n_s, hop_s = frames_mid, n_mid, hop_mid
        else:
            stft, n_s, hop_s = frames_fast, n_fast, hop_fast
        ks0 = max(1, int(f_lo * n_s / SR))
        ks1 = min(n_s // 2, max(ks0 + 1, int(f_hi * n_s / SR)))
        b_env = [sum(fr[ks0:ks1]) for fr in stft]
        e_sum = sum(b_env)
        if e_sum > 1e-12:
            b_tau = 2.0 * sum((i * hop_s / SR) * e for i, e in enumerate(b_env)) / e_sum
        else:
            b_tau = 0.004
        b_tau = max(0.0012, min(0.12, b_tau))

        # Target RMS amplitude at t=0 such that integral of (A * exp(-t/tau))^2 dt = A^2 * tau / 2 = band_energy.
        band_energy = residual_energy * b_frac
        b_rms = math.sqrt(max(0.0, 2.0 * band_energy / b_tau))
        bands.append([round(b_freq, 1), round(b_rms, 4), round(b_tau, 4), q])

    # Calibrate mode RMS amplitudes on the EXACT same energy scale (A^2 * tau / 2 = mode_energy).
    tonal_energy = burst_energy * (1.0 - residual_ratio)
    if modes and tonal_energy > 1e-12:
        raw_mode_e = sum((m[1] ** 2) * m[2] * 0.5 for m in modes)
        if raw_mode_e > 1e-12:
            scale = math.sqrt(tonal_energy / raw_mode_e)
            for m in modes:
                m[1] = round(m[1] * scale, 4)

    # Filter out negligible modes/bands.
    max_comp = max([m[1] for m in modes] + [b[1] for b in bands] + [1e-6])
    modes = [m for m in modes if m[1] >= max_comp * 0.04]
    bands = [b for b in bands if b[1] >= max_comp * 0.03]

    # Overall summary fields (used by duration, UI metadata, and legacy fallback).
    all_taus = [m[2] for m in modes] + [b[2] for b in bands]
    overall_decay = max(all_taus) if all_taus else 0.008
    # Global spectral centroid across full audible range.
    full_centroid = sum(k * bin_hz * p_full[k] for k in range(2, n_hi // 2)) / full_sum
    # Transient sharpness (0 for soft/tonal, up to 1 for razor-sharp broadband clicks).
    snap = round(max(0.0, min(1.0, residual_ratio * (1.0 - min(1.0, attack / 0.004)))), 3)
    bounce = round(events[-1][0] - events[0][0], 4) if len(events) > 1 else 0

    # Normalize component amplitudes relative to overall level so level carries the loudness.
    norm = max([m[1] for m in modes] + [b[1] for b in bands] + [1e-6])
    for m in modes:
        m[1] = round(m[1] / norm, 4)
    for b in bands:
        b[1] = round(b[1] / norm, 4)

    # Calibrate level so synthesized energy matches reference recording energy (~0 dB).
    level = round(max(0.03, min(1.35, norm * 1.05)), 4)

    result = dict(
        modes=modes,
        bands=bands,
        attack=round(attack, 5),
        snap=snap,
        decay=round(overall_decay, 4),
        brightness=round(max(300, min(16000, full_centroid))),
        noise=round(residual_ratio, 3),
        bounce=bounce,
        level=level,
    )
    if events:
        result['events'] = events
    return result


def analyze(item):
    name = item['name'][:-4]
    path = CACHE / item['name']
    if not path.exists():
        urllib.request.urlretrieve(item['download_url'], path)
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'])
    data = array.array('f')
    data.frombytes(raw)
    count = min(8, max(1, math.ceil(len(data) / SR) - 1))
    result = dict(id=name, name=name.replace('-', ' ').upper(), samples=count)
    for phase, offset, length in [('down', 0.0, 0.19), ('up', 0.2, 0.79)]:
        # Match variant 1 first (what Original mode auditions in the UI), falling back if silent.
        chosen = None
        for i in range(1, count + 1):
            seg = list(data[int((i + offset) * SR):int((i + offset + length) * SR)])
            feat = features(seg)
            if feat is not None:
                chosen = feat
                break
        result[phase] = chosen if chosen is not None else dict(
            modes=[], bands=[], attack=0.0005, snap=0.0, decay=0.008, brightness=2000, noise=0.3, bounce=0, level=0
        )
    return result


def get_items():
    cached = sorted(CACHE.glob('*.wav'))
    if len(cached) >= 57:
        return [{'name': p.name, 'download_url': f'https://raw.githubusercontent.com/joshwcomeau/button-sounds/main/package/audio/{p.name}'} for p in cached]
    items = json.load(urllib.request.urlopen('https://api.github.com/repos/joshwcomeau/button-sounds/contents/package/audio'))
    return [x for x in items if x['name'].endswith('.wav')]


if __name__ == '__main__':
    items = get_items()
    with concurrent.futures.ProcessPoolExecutor(max_workers=6) as pool:
        profiles = list(pool.map(analyze, items))
    out = ROOT / 'src' / 'profiles.json'
    out.write_text(json.dumps(profiles, separators=(',', ':')) + '\n')
    print(f'Analyzed {len(profiles)} sounds; saved to {out} ({out.stat().st_size // 1024} KB)')
