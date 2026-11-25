import './style.css';
import { ButtonSynth, profiles, defaults, limits, sanitize, renderSound, encodeWav, type Parameters, type Phase, type Profile } from './synth';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const synth = new ButtonSynth();
const storageKey = 'button-synth-v1';
let selected = profiles.find(p => p.id === 'hi75-soft')!;
let params = { ...defaults };
let saved: Record<string, Parameters> = {};
let muted = false, mode: 'synth' | 'reference' = 'synth', filter = 'All', query = '';
let phase: Phase | 'pair' = 'pair', seed = 42, renderRevision = 0;
let preview: AudioBuffer | undefined;
let referenceContext: AudioContext | undefined;
let referenceRequest = 0;
const referenceCache = new Map<string, AudioBuffer>();
const referenceSources = new Set<AudioBufferSourceNode>();
try {
  const state = JSON.parse(localStorage.getItem(storageKey) || '{}');
  if (state.sounds && typeof state.sounds === 'object') {
    for (const p of profiles) if (state.sounds[p.id]) saved[p.id] = sanitize(state.sounds[p.id]);
  }
  selected = profiles.find(p => p.id === state.selected) || selected;
  params = saved[selected.id] || { ...defaults };
} catch { /* A blocked or outdated local store must not stop the instrument. */ }

const categories = ['All', 'Keyboards', 'Mice', 'Switches', 'Controllers', 'Electronic'];
function category(p: Profile) {
  if (/kbd|halo|hi75|uhk/.test(p.id)) return 'Keyboards';
  if (/mouse|ergo|master|rival/.test(p.id)) return 'Mice';
  if (/ps5|iidx|sd-/.test(p.id)) return 'Controllers';
  if (/synth|tonal|bonus|raddy/.test(p.id)) return 'Electronic';
  return 'Switches';
}
function title(p: Profile) {
  const acronyms = new Set(['asus', 'kbd', 'mx', 'ps5', 'sd', 'uhk', 'kvm', 'led', 'iidx']);
  return p.id.split('-').map(s => acronyms.has(s) ? s.toUpperCase() : s === 'hi75' ? 'Hi75' : s[0].toUpperCase() + s.slice(1)).join(' ');
}
const controls: { key: keyof Parameters; name: string; hint: string; step: number; format: (n: number) => string }[] = [
  { key: 'pitch', name: 'Pitch', hint: 'Tune the entire mechanism', step: 1, format: n => `${n > 0 ? '+' : ''}${n} st` },
  { key: 'decay', name: 'Decay', hint: 'Short tap → lingering ring', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'brightness', name: 'Brightness', hint: 'Muted felt → crisp plastic', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'body', name: 'Body', hint: 'Resonance of the housing', step: .01, format: n => `${Math.round(n * 100)}%` },
  { key: 'noise', name: 'Texture', hint: 'Amount of filtered noise', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'snap', name: 'Snap', hint: 'The initial sharp transient', step: .01, format: n => `${Math.round(n * 100)}%` },
  { key: 'bounce', name: 'Bounce', hint: 'Secondary impact timing & strength', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'variation', name: 'Variation', hint: 'Small differences on every press', step: .01, format: n => `${Math.round(n * 100)}%` },
];

$('#app').innerHTML = `
  <header class="topbar"><a class="brand" href="./"><span class="brand-icon">b<span>·</span></span> BUTTON SYNTH <span class="brand-tag">SOUND LAB / 01</span></a><button id="mute" class="quiet" aria-pressed="false">◉ <span>Sound on</span></button></header>
  <main>
    <div class="intro"><div><div class="eyebrow"><span class="status-dot"></span> PROCEDURAL AUDIO PLAYGROUND</div><h1>Small sounds.<br><span>Endless character.</span></h1></div><p>The feeling of a button, made from scratch.<br> Explore 57 starting points. Shape every detail.<br><span>No samples. Just synthesis.</span></p></div>
    <div class="workspace">
      <aside class="library panel"><div class="panel-heading"><h2>Sound library</h2><span class="badge">57</span></div><label class="search"><span>⌕</span><input id="search" type="search" placeholder="Find a sound…" aria-label="Search sounds"></label><div class="filters" role="group" aria-label="Filter sounds">${categories.map(c => `<button data-filter="${c}" class="${c === 'All' ? 'active' : ''}">${c}</button>`).join('')}</div><div class="library-count" id="result-count"></div><div id="presets" class="presets" aria-label="Sound presets"></div><div class="library-footer"><span class="small-dot"></span> Original-inspired, fully procedural</div></aside>
      <section class="instrument panel" aria-label="Sound editor"><div class="instrument-heading"><div><div class="eyebrow" id="category"></div><h2 id="sound-name"></h2></div><span class="synth-badge">WEB AUDIO</span></div>
        <div class="audition"><div class="mode-switch" role="group" aria-label="Playback source"><button id="synth-mode" class="active" aria-pressed="true">Synthesis</button><button id="reference-mode" aria-pressed="false">Original ↗</button></div><div class="test-zone"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><button id="pad" class="pad"><span class="pad-symbol">↓</span><span>PRESS ME</span></button></div><div class="audition-hint" id="audition-hint">Press & hold. Release to hear the return.</div><div class="audition-actions"><button id="play-pair" class="quiet">▶ Play press + release</button><span class="keyboard-hint">or focus & use <kbd>space</kbd></span></div><p class="reference-note" id="reference-note" hidden>Original recordings load from GitHub. Controls shape synthesis only.</p></div>
        <div class="scope"><div class="scope-heading"><span class="eyebrow">SIGNAL PREVIEW</span><div class="phase-switch" role="group" aria-label="Preview and export phase"><button data-phase="down">Press</button><button data-phase="up">Release</button><button data-phase="pair" class="active">Pair</button></div></div><canvas id="waveform" aria-label="Rendered synthesized waveform" role="img"></canvas><div class="scope-footer"><span id="duration">RENDERING…</span><span>48 kHz / MONO <span class="scope-separator">·</span> SEED <button id="seed" title="Generate a new deterministic preview seed">42 ↻</button></span></div></div>
        <div class="signal-chain"><span>EXCITATION</span><i>→</i><span>RESONANCE</span><i>→</i><span>ENVELOPE</span><i>→</i><span>OUTPUT</span></div>
      </section>
      <section class="shaping panel" aria-label="Synthesis controls"><div class="panel-heading"><h2>Shape the sound</h2><button id="reset" class="text-button">Reset ↺</button></div><p class="panel-caption">One mechanism. Your signature.</p><div class="controls">${controls.map(c => `<div class="control"><div class="control-heading"><label for="${c.key}">${c.name}</label><output for="${c.key}" id="${c.key}-value"></output></div><input id="${c.key}" type="range" min="${limits[c.key][0]}" max="${limits[c.key][1]}" step="${c.step}" aria-describedby="${c.key}-hint"><p id="${c.key}-hint">${c.hint}</p></div>`).join('')}</div><div class="volume"><label for="volume">OUTPUT LEVEL</label><output id="volume-value" for="volume"></output><input id="volume" type="range" min="0" max="1" step=".01"></div></section>
    </div>
    <section class="export-bar panel"><div><span class="export-icon">↗</span><div><h2>Make it yours. Take it with you.</h2><p>Export the sound, save your settings, or use the engine in your app.</p></div></div><div class="export-actions"><button id="import" class="quiet">Import JSON</button><button id="save" class="quiet">Save preset</button><button id="code" class="quiet">Copy code</button><button id="export" class="primary">Export WAV <span>↓</span></button></div></section>
    <div id="status" class="status" role="status" aria-live="polite">Ready to make some noise. Audio starts with your first press.</div>
    <footer><span>BUILT FROM OSCILLATORS, NOISE & A LITTLE CURIOSITY.</span><span>Inspired by <a href="https://github.com/joshwcomeau/button-sounds/tree/main/package/audio" target="_blank" rel="noreferrer">Josh Comeau’s Button Sounds ↗</a><span class="footer-divider"> / </span><a href="https://github.com/joshwcomeau/button-sounds/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT reference audio</a></span></footer>
    <input id="import-file" type="file" accept="application/json,.json" hidden>
  </main>`;

function status(message: string) { $('#status').textContent = message; }
function persist() {
  saved[selected.id] = { ...params };
  try { localStorage.setItem(storageKey, JSON.stringify({ selected: selected.id, sounds: saved })); }
  catch { status('Settings work for this session. Browser storage is unavailable.'); }
}
function list() {
  const matching = profiles.filter(p => (filter === 'All' || category(p) === filter) && title(p).toLowerCase().includes(query.toLowerCase()));
  $('#result-count').textContent = `${matching.length} SOUND${matching.length === 1 ? '' : 'S'} / SELECT A STARTING POINT`;
  $('#presets').replaceChildren(...matching.map(p => {
    const button = document.createElement('button');
    button.className = `preset ${p.id === selected.id ? 'selected' : ''}`;
    button.setAttribute('aria-pressed', String(p.id === selected.id));
    button.dataset.id = p.id;
    button.innerHTML = `<span class="preset-symbol">${category(p) === 'Electronic' ? '∿' : category(p) === 'Keyboards' ? '▦' : '⊙'}</span><span>${title(p)}<small>${category(p)}</small></span><span class="preset-arrow">↗</span>`;
    button.addEventListener('click', () => {
      clearTimeout(pairTimer); release();
      referenceRequest++;
      referenceSources.forEach(s => s.stop()); referenceSources.clear();
      selected = p; params = { ...(saved[p.id] || defaults) }; persist(); sync();
      status(`${title(p)} selected. Press the button to audition.`);
      if (mode === 'reference') void prepareReference();
    });
    return button;
  }));
  if (!matching.length) $('#presets').textContent = 'No sounds found. Try another search.';
}
function sync() {
  $('#sound-name').textContent = title(selected);
  $('#category').textContent = `${category(selected).toUpperCase()} / ${String(profiles.indexOf(selected) + 1).padStart(2, '0')}`;
  for (const c of controls) {
    $<HTMLInputElement>(`#${c.key}`).value = String(params[c.key]);
    $(`#${c.key}-value`).textContent = c.format(params[c.key]);
  }
  $<HTMLInputElement>('#volume').value = String(params.volume);
  $('#volume-value').textContent = `${Math.round(params.volume * 100)}%`;
  list(); updatePreview();
}
let previewTimer: ReturnType<typeof setTimeout>;
function updatePreview() {
  const revision = ++renderRevision;
  preview = undefined;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const buffer = await renderSound(selected, phase, params, seed);
      if (revision !== renderRevision) return;
      preview = buffer; drawWave();
      $('#duration').textContent = `${Math.round(buffer.duration * 1000)} MS / ${phase === 'pair' ? 'PRESS + RELEASE' : phase.toUpperCase()}`;
    } catch (e) { status(`Could not render audio: ${(e as Error).message}`); }
  }, 75);
}
function drawWave() {
  const canvas = $<HTMLCanvasElement>('#waveform');
  const width = canvas.clientWidth, height = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d')!; ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#263831'; ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, height/2); ctx.lineTo(width, height/2); ctx.stroke();
  if (!preview) return;
  const data = preview.getChannelData(0);
  // Fixed scale: changing output level also changes the displayed amplitude.
  ctx.strokeStyle = '#a3d5aa'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * data.length / width), to = Math.max(from+1, Math.floor((x+1) * data.length / width));
    let low = 0, high = 0;
    for (let i = from; i < to; i++) { low = Math.min(low, data[i]); high = Math.max(high, data[i]); }
    const scale = height * 2.6;
    ctx.moveTo(x, height/2 + Math.max(-height/2, low*scale)); ctx.lineTo(x, height/2 + Math.min(height/2, high*scale));
  }
  ctx.stroke();
  if (phase === 'pair') {
    const x = .205 / preview.duration * width;
    ctx.setLineDash([3, 4]); ctx.strokeStyle = '#c5a47170'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); ctx.setLineDash([]);
  }
}
new ResizeObserver(drawWave).observe($('#waveform'));

const pendingReferences = new Map<string, Promise<AudioBuffer>>();
async function loadReference(p: Profile): Promise<AudioBuffer> {
  referenceContext ||= new AudioContext();
  await referenceContext.resume();
  let buffer = referenceCache.get(p.id);
  if (buffer) return buffer;
  if (pendingReferences.has(p.id)) return pendingReferences.get(p.id)!;
  const pending = (async () => {
    const response = await fetch(`https://raw.githubusercontent.com/joshwcomeau/button-sounds/main/package/audio/${p.id}.wav`);
    if (!response.ok) throw new Error(`Reference download failed (${response.status}).`);
    buffer = await referenceContext!.decodeAudioData(await response.arrayBuffer());
    referenceCache.set(p.id, buffer);
    if (referenceCache.size > 6) referenceCache.delete(referenceCache.keys().next().value!);
    return buffer;
  })();
  pendingReferences.set(p.id, pending);
  try { return await pending; }
  finally { pendingReferences.delete(p.id); }
}
async function prepareReference() {
  const request = referenceRequest, p = selected;
  $<HTMLButtonElement>('#pad').disabled = true; $<HTMLButtonElement>('#play-pair').disabled = true;
  status(`Loading ${title(p)} reference from GitHub…`);
  try {
    await loadReference(p);
    if (request === referenceRequest) status('Original reference ready. Press to compare; switch to Synthesis to hear your edits.');
  } catch (error) { if (request === referenceRequest) status(`Could not load original: ${(error as Error).message} Synthesis is available offline.`); }
  finally {
    if (request === referenceRequest) { $<HTMLButtonElement>('#pad').disabled = false; $<HTMLButtonElement>('#play-pair').disabled = false; }
  }
}
async function reference(p: Profile, event: Phase) {
  const request = referenceRequest;
  const buffer = await loadReference(p);
  if (muted || request !== referenceRequest || mode !== 'reference') return;
  const source = referenceContext!.createBufferSource(), gain = referenceContext!.createGain();
  source.buffer = buffer; gain.gain.value = params.volume;
  source.connect(gain).connect(referenceContext!.destination);
  referenceSources.add(source);
  source.onended = () => { referenceSources.delete(source); source.disconnect(); gain.disconnect(); };
  source.start(0, event === 'down' ? 1 : 1.2, event === 'down' ? .19 : .79);
  status('Playing original reference · first recorded variant · synthesis controls do not affect it.');
}
async function trigger(event: Phase) {
  try {
    if (muted) { status('Sound is muted. Use Sound off to enable playback.'); return; }
    const p = selected;
    if (mode === 'reference') await reference(p, event);
    else { await synth.trigger(p, event, params); status(`${title(p)} · ${event === 'down' ? 'press' : 'release'} · procedural synthesis`); }
  } catch (e) { status((e as Error).message); }
}
let held = false, pairTimer: ReturnType<typeof setTimeout> | undefined;
const pad = $('#pad');
function press() { if (held) return; held = true; pad.classList.add('pressed'); void trigger('down'); }
function release() { if (!held) return; held = false; pad.classList.remove('pressed'); void trigger('up'); }
pad.addEventListener('pointerdown', e => { if (e.button !== 0) return; pad.setPointerCapture(e.pointerId); press(); });
pad.addEventListener('pointerup', release);
pad.addEventListener('pointercancel', release);
pad.addEventListener('lostpointercapture', release);
pad.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) press(); } });
pad.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
pad.addEventListener('blur', release);
// Assistive technology can activate a button without pointer or keyboard events.
pad.addEventListener('click', e => { if (e.detail === 0 && !held) playPair(); });
function playPair() {
  clearTimeout(pairTimer); release(); press();
  pairTimer = setTimeout(release, 200);
}
$('#play-pair').addEventListener('click', playPair);
window.addEventListener('blur', () => { clearTimeout(pairTimer); release(); });

for (const c of controls) $(`#${c.key}`).addEventListener('input', e => {
  params[c.key] = Number((e.target as HTMLInputElement).value);
  $(`#${c.key}-value`).textContent = c.format(params[c.key]); persist(); updatePreview();
});
$('#volume').addEventListener('input', e => {
  params.volume = Number((e.target as HTMLInputElement).value);
  $('#volume-value').textContent = `${Math.round(params.volume * 100)}%`; persist(); updatePreview();
});
$('#search').addEventListener('input', e => { query = (e.target as HTMLInputElement).value; list(); });
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(b => b.addEventListener('click', () => {
  filter = b.dataset.filter!;
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.filter === filter)); list();
}));
document.querySelectorAll<HTMLButtonElement>('[data-phase]').forEach(b => b.addEventListener('click', () => {
  phase = b.dataset.phase as Phase | 'pair';
  document.querySelectorAll('[data-phase]').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.phase === phase)); updatePreview();
}));
$('#seed').addEventListener('click', () => { seed = (seed + 1) >>> 0; $('#seed').textContent = `${seed} ↻`; updatePreview(); });
$('#reset').addEventListener('click', () => { params = { ...defaults }; persist(); sync(); status('This preset’s controls have been reset.'); });
$('#mute').addEventListener('click', () => {
  muted = !muted; synth.setMuted(muted); referenceRequest++;
  $<HTMLButtonElement>('#pad').disabled = false; $<HTMLButtonElement>('#play-pair').disabled = false;
  if (muted) { referenceSources.forEach(s => s.stop()); referenceSources.clear(); }
  $('#mute').setAttribute('aria-pressed', String(muted)); $('#mute span').textContent = muted ? 'Sound off' : 'Sound on';
  status(muted ? 'Playback muted. Exports keep your output level.' : 'Sound enabled.');
});
function changeMode(next: typeof mode) {
  clearTimeout(pairTimer); release(); referenceRequest++;
  referenceSources.forEach(s => s.stop()); referenceSources.clear();
  mode = next;
  $('#synth-mode').classList.toggle('active', mode === 'synth'); $('#reference-mode').classList.toggle('active', mode === 'reference');
  $('#synth-mode').setAttribute('aria-pressed', String(mode === 'synth')); $('#reference-mode').setAttribute('aria-pressed', String(mode === 'reference'));
  $('#reference-note').hidden = mode !== 'reference';
  $<HTMLButtonElement>('#pad').disabled = false; $<HTMLButtonElement>('#play-pair').disabled = false;
  status(mode === 'reference' ? 'Original mode. Press to load the first reference variant from GitHub.' : 'Synthesis mode. Every sound is generated locally.');
  if (mode === 'reference') void prepareReference();
}
$('#synth-mode').addEventListener('click', () => changeMode('synth'));
$('#reference-mode').addEventListener('click', () => changeMode('reference'));
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#export'); button.disabled = true;
  const p = selected, settings = { ...params }, part = phase;
  try {
    const buffer = await renderSound(p, part, settings, seed);
    download(new Blob([encodeWav(buffer)], { type: 'audio/wav' }), `${p.id}-${part}.wav`);
    status(`Exported ${title(p)} ${part} · synthesized WAV · 48 kHz / 16-bit mono.`);
  } catch (e) { status(`Export failed: ${(e as Error).message}`); }
  finally { button.disabled = false; }
});
$('#save').addEventListener('click', () => {
  download(new Blob([JSON.stringify({ version: 1, preset: selected.id, parameters: params, seed }, null, 2)], { type: 'application/json' }), `${selected.id}-preset.json`);
  status('Preset saved as JSON. Import it here to restore your settings and preview seed.');
});
$('#import').addEventListener('click', () => $<HTMLInputElement>('#import-file').click());
$('#import-file').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 100000) throw new Error('Preset file is too large.');
    const data = JSON.parse(await file.text());
    const p = profiles.find(x => x.id === data.preset);
    if (data.version !== 1 || !p) throw new Error('Unsupported preset version or unknown sound.');
    const next = sanitize(data.parameters);
    if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 4294967295) throw new Error('Invalid seed.');
    selected = p; params = next; seed = data.seed; $('#seed').textContent = `${seed} ↻`;
    filter = 'All'; query = ''; $<HTMLInputElement>('#search').value = '';
    document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.filter === 'All'));
    persist(); sync(); status(`Imported ${title(p)} settings.`);
  } catch (error) { status(`Could not import preset: ${(error as Error).message}`); }
  finally { input.value = ''; }
});
$('#code').addEventListener('click', async () => {
  const code = `import { ButtonSynth } from './src/synth';\n\nconst synth = new ButtonSynth();\nconst parameters = ${JSON.stringify(params, null, 2)};\n\n// Call from a user interaction; reuse this instance.\nawait synth.trigger('${selected.id}', 'down', parameters);\n// On release:\nawait synth.trigger('${selected.id}', 'up', parameters);\n// On teardown: await synth.dispose();\n`;
  try { await navigator.clipboard.writeText(code); status('Copied integration code. The reusable engine lives in src/synth.ts with src/profiles.json.'); }
  catch { download(new Blob([code], { type: 'text/javascript' }), 'button-synth-example.ts'); status('Clipboard unavailable. Downloaded the integration snippet.'); }
});
sync();
