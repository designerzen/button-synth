import './style.css';
import { profiles, defaults, limits, sanitize, duration, renderSound, encodeWav, type Parameters, type Phase, type Profile } from './synth';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const storageKey = 'button-synth-v1';
let selected = profiles.find(p => p.id === 'hi75-soft')!;
let params = { ...defaults };
let saved: Record<string, Parameters> = {};
let muted = false, filter = 'All', query = '';
let phase: Phase | 'pair' = 'pair', seed = 42;
let audio: AudioContext | undefined, source: AudioBufferSourceNode | undefined;
let rendered: Promise<AudioBuffer> | undefined, playRevision = 0, playing = false;

try {
  const state = JSON.parse(localStorage.getItem(storageKey) || '{}');
  if (state.sounds && typeof state.sounds === 'object') {
    for (const p of profiles) if (state.sounds[p.id]) saved[p.id] = sanitize(state.sounds[p.id]);
  }
  selected = profiles.find(p => p.id === state.selected) || selected;
  params = { ...(saved[selected.id] || defaults) };
} catch { /* Storage is optional; the instrument still works without it. */ }

const categories = ['All', 'Game sounds', 'Keyboards', 'Mice', 'Switches', 'Controllers', 'Electronic'];
function category(p: Profile) {
  if (p.down.notes) return 'Game sounds';
  if (/kbd|halo|hi75|uhk/.test(p.id)) return 'Keyboards';
  if (/mouse|ergo|master|rival/.test(p.id)) return 'Mice';
  if (/ps5|iidx|sd-/.test(p.id)) return 'Controllers';
  if (/synth|tonal|bonus|raddy/.test(p.id)) return 'Electronic';
  return 'Switches';
}
function title(p: Profile) {
  if (p.down.notes) return p.name;
  const acronyms = new Set(['asus', 'kbd', 'mx', 'ps5', 'sd', 'uhk', 'kvm', 'led', 'iidx']);
  return p.id.split('-').map(s => acronyms.has(s) ? s.toUpperCase() : s === 'hi75' ? 'Hi75' : s[0].toUpperCase() + s.slice(1)).join(' ');
}
const icon = (path: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const playIcon = icon('<path d="m9 5 10 7-10 7Z" fill="currentColor" stroke="none"/>');
const stopIcon = icon('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>');
const checkIcon = icon('<path d="m5 12 4 4L19 6"/>');
const controls: { key: keyof Parameters; name: string; hint: string; step: number; format: (n: number) => string }[] = [
  { key: 'pitch', name: 'Pitch', hint: 'Lower or higher', step: 1, format: n => `${n > 0 ? '+' : ''}${n} st` },
  { key: 'decay', name: 'Length', hint: 'Shorter or longer decay', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'brightness', name: 'Brightness', hint: 'Softer or sharper tone', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'volume', name: 'Volume', hint: 'Playback and download level', step: .01, format: n => `${Math.round(n * 100)}%` },
  { key: 'body', name: 'Body', hint: 'Resonance or melody level', step: .01, format: n => `${Math.round(n * 100)}%` },
  { key: 'noise', name: 'Texture', hint: 'Amount of filtered noise', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'snap', name: 'Snap', hint: 'Sharpness of the initial attack', step: .01, format: n => `${Math.round(n * 100)}%` },
  { key: 'bounce', name: 'Bounce', hint: 'Secondary impact or echo', step: .01, format: n => `${n.toFixed(2)}×` },
  { key: 'variation', name: 'Variation', hint: 'Differences when creating a new variation', step: .01, format: n => `${Math.round(n * 100)}%` },
];
function controlMarkup(c: typeof controls[number]) {
  return `<div class="control"><div class="control-label"><label for="${c.key}" title="${c.hint}">${c.name}</label><output for="${c.key}" id="${c.key}-value"></output></div><input id="${c.key}" type="range" min="${limits[c.key][0]}" max="${limits[c.key][1]}" step="${c.step}" aria-describedby="${c.key}-hint"><span class="sr-only" id="${c.key}-hint">${c.hint}</span></div>`;
}

$('#app').innerHTML = `
  <header class="app-header"><h1>Button Synth</h1><button id="mute" class="text-button" aria-pressed="false">Mute</button></header>
  <main class="workspace">
    <aside class="library" aria-label="Choose a sound">
      <label class="sr-only" for="search">Search sounds</label><input id="search" type="search" placeholder="Search sounds" autocomplete="off">
      <label class="sr-only" for="category-filter">Category</label><select id="category-filter">${categories.map(c => `<option value="${c}">${c === 'All' ? 'All sounds' : c}</option>`).join('')}</select>
      <div id="presets" class="presets" role="group" aria-label="Sounds"></div><p id="result-count" class="result-count"></p>
    </aside>
    <section class="editor" aria-labelledby="sound-name">
      <div class="selection"><div><p id="category" class="category"></p><h2 id="sound-name"></h2></div><button id="reset" class="text-button">Reset</button></div>
      <div class="playback"><button id="pad" class="play-button" aria-label="Play sound">${playIcon}<span>Play sound</span></button><div class="phase-switch" role="group" aria-label="Sound part">${([['down', 'Press'], ['up', 'Release'], ['pair', 'Both']] as const).map(([value, label]) => `<button data-phase="${value}" aria-pressed="${value === phase}">${label}</button>`).join('')}</div></div>
      <div class="controls">${controls.slice(0, 4).map(controlMarkup).join('')}</div>
      <details class="advanced"><summary>More controls</summary><div class="controls">${controls.slice(4).map(controlMarkup).join('')}</div><button id="seed" class="secondary-button">New variation</button></details>
      <div class="export-row"><button id="export" class="download-button">${icon('<path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/>')}Download WAV</button><span id="duration" class="duration"></span><details class="tools"><summary>Preset & code</summary><div class="tool-menu"><button id="save">Save preset</button><button id="import">Import preset</button><button id="code">Copy code</button></div></details></div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>
  </main>
  <footer><a href="https://github.com/designerzen/button-synth" target="_blank" rel="noreferrer">Source & documentation</a><a href="https://github.com/joshwcomeau/button-sounds" target="_blank" rel="noreferrer">Sounds inspired by Josh Comeau</a></footer>
  <input id="import-file" type="file" accept="application/json,.json" hidden>`;

function status(message = '') { $('#status').textContent = message; }
function persist() {
  saved[selected.id] = { ...params };
  try { localStorage.setItem(storageKey, JSON.stringify({ selected: selected.id, sounds: saved })); }
  catch { status('Browser storage is unavailable. You can still save a preset.'); }
}
function list() {
  const matching = profiles.filter(p => (filter === 'All' || category(p) === filter) && title(p).toLowerCase().includes(query.toLowerCase()));
  $('#result-count').textContent = `${matching.length} sound${matching.length === 1 ? '' : 's'}`;
  const tabStop = matching.find(p => p.id === selected.id) || matching[0];
  $('#presets').replaceChildren(...matching.map(p => {
    const button = document.createElement('button');
    button.className = 'preset'; button.dataset.id = p.id;
    button.setAttribute('aria-pressed', String(p.id === selected.id));
    button.tabIndex = p === tabStop ? 0 : -1;
    button.innerHTML = `<span>${title(p)}</span>${p.id === selected.id ? checkIcon : ''}`;
    button.addEventListener('click', () => {
      stopPlayback(); selected = p; params = { ...(saved[p.id] || defaults) };
      seed = 42; rendered = undefined; status(); persist(); sync();
      $<HTMLButtonElement>(`.preset[data-id="${p.id}"]`).focus({ preventScroll: true });
    });
    return button;
  }));
  if (!matching.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No matching sounds.';
    const clear = document.createElement('button'); clear.className = 'text-button'; clear.textContent = 'Clear filters';
    clear.addEventListener('click', clearFilters); empty.append(document.createElement('br'), clear); $('#presets').append(empty);
  }
}
function clearFilters() {
  filter = 'All'; query = ''; $<HTMLInputElement>('#search').value = ''; $<HTMLSelectElement>('#category-filter').value = 'All'; list();
}
function updateSummary() {
  const seconds = (phase === 'pair' ? Math.max(duration(selected, 'down', params), .2 + duration(selected, 'up', params)) : duration(selected, phase, params)) + .04;
  $('#duration').textContent = `${seconds.toFixed(2)} s`;
  $<HTMLButtonElement>('#reset').disabled = controls.every(c => params[c.key] === defaults[c.key]) && seed === 42;
  $<HTMLButtonElement>('#seed').disabled = params.variation === 0;
}
function sync() {
  $('#sound-name').textContent = title(selected); $('#category').textContent = category(selected);
  for (const c of controls) {
    $<HTMLInputElement>(`#${c.key}`).value = String(params[c.key]);
    $(`#${c.key}-value`).textContent = c.format(params[c.key]);
  }
  list(); updateSummary();
  const active = document.querySelector<HTMLElement>('.preset[aria-pressed="true"]');
  if (active) {
    const list = $('#presets');
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
  }
}
function stopPlayback() {
  playRevision++; playing = false;
  if (source) { source.onended = null; source.stop(); source.disconnect(); source = undefined; }
  $('#pad').innerHTML = `${playIcon}<span>Play sound</span>`; $('#pad').setAttribute('aria-label', 'Play sound');
}
function invalidate() { rendered = undefined; stopPlayback(); status(); updateSummary(); }
function getSound() {
  if (!rendered) {
    const pending = renderSound(selected, phase, { ...params }, seed); rendered = pending;
    void pending.catch(() => { if (rendered === pending) rendered = undefined; });
  }
  return rendered;
}
$('#pad').addEventListener('click', async () => {
  if (playing) { stopPlayback(); status(); return; }
  if (muted) { status('Unmute to play.'); return; }
  const revision = ++playRevision;
  playing = true; $('#pad').innerHTML = `${stopIcon}<span>Stop</span>`; $('#pad').setAttribute('aria-label', 'Stop playback');
  try {
    audio ||= new AudioContext();
    await audio.resume();
    if (revision !== playRevision) return;
    const buffer = await getSound();
    if (revision !== playRevision) return;
    source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
    source.onended = () => { if (revision === playRevision) stopPlayback(); };
    source.start(); status();
  } catch (error) { if (revision === playRevision) { stopPlayback(); status(`Playback failed: ${(error as Error).message}`); } }
});
for (const c of controls) $(`#${c.key}`).addEventListener('input', e => {
  params[c.key] = Number((e.target as HTMLInputElement).value);
  $(`#${c.key}-value`).textContent = c.format(params[c.key]); invalidate(); persist();
});
$('#search').addEventListener('input', e => { query = (e.target as HTMLInputElement).value; list(); });
$('#category-filter').addEventListener('change', e => { filter = (e.target as HTMLSelectElement).value; list(); });
$('#presets').addEventListener('keydown', e => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.preset')];
  const index = buttons.indexOf(e.target as HTMLButtonElement);
  if (index < 0) return;
  let next: number;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(index + 1, buttons.length - 1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(index - 1, 0);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  else return;
  e.preventDefault(); buttons.forEach((b, i) => b.tabIndex = i === next ? 0 : -1); buttons[next].focus();
});
document.querySelectorAll<HTMLButtonElement>('[data-phase]').forEach(b => b.addEventListener('click', () => {
  phase = b.dataset.phase as Phase | 'pair';
  document.querySelectorAll<HTMLButtonElement>('[data-phase]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); invalidate();
}));
$('#seed').addEventListener('click', () => { seed = (seed + 1) >>> 0; invalidate(); status('New variation ready. Play to hear it.'); });
$('#reset').addEventListener('click', () => { params = { ...defaults }; seed = 42; invalidate(); persist(); sync(); status('Settings reset.'); });
$('#mute').addEventListener('click', () => {
  muted = !muted; stopPlayback(); $('#mute').setAttribute('aria-pressed', String(muted)); $('#mute').textContent = muted ? 'Unmute' : 'Mute';
  status(muted ? 'Playback muted.' : '');
});
window.addEventListener('pagehide', () => { stopPlayback(); void audio?.close(); audio = undefined; });
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function closeTools(restoreFocus = false) {
  const tools = $<HTMLDetailsElement>('.tools');
  tools.open = false;
  if (restoreFocus) tools.querySelector('summary')!.focus();
}
document.addEventListener('pointerdown', e => { if (!$( '.tools').contains(e.target as Node)) closeTools(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $<HTMLDetailsElement>('.tools').open) { e.preventDefault(); closeTools(true); }
});
$('#export').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#export'); button.disabled = true;
  const name = `${selected.id}-${phase}.wav`;
  try { const buffer = await getSound(); download(new Blob([encodeWav(buffer)], { type: 'audio/wav' }), name); status(`Downloaded ${name}`); }
  catch (error) { status(`Download failed: ${(error as Error).message}`); }
  finally { button.disabled = false; }
});
$('#save').addEventListener('click', () => {
  download(new Blob([JSON.stringify({ version: 1, preset: selected.id, parameters: params, seed }, null, 2)], { type: 'application/json' }), `${selected.id}-preset.json`);
  closeTools(true); status('Preset saved.');
});
$('#import').addEventListener('click', () => { closeTools(true); $<HTMLInputElement>('#import-file').click(); });
$('#import-file').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 100000) throw new Error('Preset file is too large.');
    const data = JSON.parse(await file.text()), p = profiles.find(x => x.id === data.preset);
    if (data.version !== 1 || !p) throw new Error('Unsupported preset version or unknown sound.');
    const next = sanitize(data.parameters);
    if (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 4294967295) throw new Error('Invalid seed.');
    selected = p; params = next; seed = data.seed; invalidate(); clearFilters(); persist(); sync();
    status(`Imported ${title(p)}.`);
  } catch (error) { status(`Could not import preset: ${(error as Error).message}`); }
  finally { input.value = ''; }
});
$('#code').addEventListener('click', async () => {
  const code = `import { ButtonSynth } from './src/synth';\n\nconst synth = new ButtonSynth();\nconst parameters = ${JSON.stringify(params, null, 2)};\n\n// Call from a user interaction; reuse this instance.\nawait synth.trigger('${selected.id}', 'down', parameters, ${seed});\n// On release:\nawait synth.trigger('${selected.id}', 'up', parameters, ${(seed + 1) >>> 0});\n// On teardown: await synth.dispose();\n`;
  closeTools(true);
  try { await navigator.clipboard.writeText(code); status('Code copied.'); }
  catch { download(new Blob([code], { type: 'text/javascript' }), 'button-synth-example.ts'); status('Code downloaded.'); }
});
sync();
