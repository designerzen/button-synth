"""Derive editable modal-synthesis profiles, never embed reference sample data.

Requires Python 3 and ffmpeg on PATH. Downloads are cached in .cache/reference.
Uses the upstream sprite offsets: down at n seconds, up at n + .2 seconds.
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
BASE = 'https://raw.githubusercontent.com/joshwcomeau/button-sounds/main/'


def fft(values):
    n = len(values)
    if n <= 1:
        return values
    even, odd = fft(values[::2]), fft(values[1::2])
    twiddled = [cmath.exp(-2j * math.pi * k / n) * odd[k] for k in range(n // 2)]
    return [even[k] + twiddled[k] for k in range(n // 2)] + [even[k] - twiddled[k] for k in range(n // 2)]


def features(samples):
    # Align each event at the first significant transient, leaving sprite silence out.
    peak = max(map(abs, samples), default=0)
    if peak < .0001:
        return None
    start = next(i for i, x in enumerate(samples) if abs(x) > peak * .06)
    samples = samples[start:]
    energy = [sum(x*x for x in samples[i:i+32]) for i in range(0, len(samples), 32)]
    total = sum(energy)
    running, end = 0, 1
    for i, e in enumerate(energy):
        running += e
        if running >= total * .97:
            end = i + 1
            break
    duration = max(.012, min(.5, end * .002))
    n = 2048
    # Average spectra from overlapping windows to retain short transients and tails.
    spectrum = [0.] * (n // 2)
    for offset in (0, 64, 192):
        frame = samples[offset:offset+n]
        frame += [0.] * (n - len(frame))
        transformed = fft([x * (.5 - .5 * math.cos(2*math.pi*i/(n-1))) for i, x in enumerate(frame)])
        for i in range(n // 2):
            spectrum[i] += abs(transformed[i]) ** 2
    bins = range(10, 960)
    weight = sum(spectrum[i] for i in bins) or 1
    centroid = sum(i * 16000 / n * spectrum[i] for i in bins) / weight
    peaks = sorted((i for i in bins if spectrum[i] > spectrum[i-1] and spectrum[i] > spectrum[i+1]), key=lambda i: spectrum[i], reverse=True)
    modes = []
    for i in peaks:
        hz = i * 16000 / n
        if all(abs(hz - m[0]) > max(100, hz * .065) for m in modes):
            modes.append([round(hz, 1), round(math.sqrt(spectrum[i] / (spectrum[peaks[0]] or 1)), 3)])
        if len(modes) == 6:
            break
    concentration = sum(spectrum[j] for i in peaks[:6] for j in range(max(0, i-2), min(n//2, i+3))) / weight
    # Find secondary impacts in 2ms RMS bins (relative to primary impact).
    first = max(range(min(12, len(energy))), key=lambda i: energy[i])
    secondary = [i for i in range(first+5, min(len(energy)-1, first+50)) if energy[i] > energy[i-1] and energy[i] > energy[i+1] and energy[i] > max(energy)*.15]
    bounce = secondary[0] * .002 if secondary else 0
    return dict(modes=modes, decay=round(max(.008, duration / 3), 4), brightness=round(max(500, min(11000, centroid*2.1))), noise=round(max(.08, min(.85, 1-concentration)), 3), bounce=round(bounce, 4), level=round(min(.9, max(.1, peak * 1.2)), 3))


def analyze(item):
    name = item['name'][:-4]
    path = CACHE / item['name']
    if not path.exists():
        urllib.request.urlretrieve(item['download_url'], path)
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'])
    data = array.array('f')
    data.frombytes(raw)
    count = min(8, max(1, math.ceil(len(data)/16000)-1))
    result = dict(id=name, name=name.replace('-', ' ').upper(), samples=count)
    for phase, offset, length in [('down', 0, .19), ('up', .2, .79)]:
        variants = [features(list(data[int((i+offset)*16000):int((i+offset+length)*16000)])) for i in range(1, count+1)]
        variants = [v for v in variants if v]
        # Representative actual variant; quiet releases remain quiet.
        result[phase] = variants[len(variants)//2] if variants else dict(modes=[[800, 1]], decay=.01, brightness=2000, noise=.3, bounce=0, level=0)
    return result


if __name__ == '__main__':
    items = json.load(urllib.request.urlopen('https://api.github.com/repos/joshwcomeau/button-sounds/contents/package/audio'))
    items = [x for x in items if x['name'].endswith('.wav')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        profiles = list(pool.map(analyze, items))
    (ROOT / 'src' / 'profiles.json').write_text(json.dumps(profiles, indent=2) + '\n')
    print(f'Analyzed {len(profiles)} sounds; profiles saved to src/profiles.json')
