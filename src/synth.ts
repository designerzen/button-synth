import rawProfiles from './profiles.json';
import { gameProfiles } from './game-profiles';

export type Phase = 'down' | 'up';
export interface Impact {
  notes?: { frequency: number; at: number; duration: number; wave: OscillatorType; endFrequency?: number }[];
  modes: number[][];
  decay: number;
  brightness: number;
  noise: number;
  bounce: number;
  level: number;
}
export interface Profile { id: string; name: string; samples: number; down: Impact; up: Impact }
export const profiles: Profile[] = [...rawProfiles, ...gameProfiles];
export interface Parameters {
  pitch: number; decay: number; brightness: number; body: number; noise: number;
  snap: number; bounce: number; variation: number; volume: number;
}
export const defaults: Parameters = { pitch: 0, decay: 1, brightness: 1, body: .65, noise: 1, snap: .5, bounce: 1, variation: .12, volume: .65 };
export const limits: Record<keyof Parameters, [number, number]> = {
  pitch: [-24, 24], decay: [.2, 3], brightness: [.2, 3], body: [0, 1], noise: [0, 2],
  snap: [0, 1], bounce: [0, 2], variation: [0, .5], volume: [0, 1],
};
export function sanitize(value: unknown): Parameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a parameter object.');
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Parameters)[]) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid ${key} value.`);
    result[key] = Math.max(limits[key][0], Math.min(limits[key][1], v));
  }
  return result;
}
function random(seed: number) {
  let a = seed | 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// A common, memoryless output stage keeps live audio and offline exports aligned.
// Scale before waveshaping to represent input levels up to +/-4 without a hard edge.
const limiterCurve = new Float32Array(8193);
for (let i = 0; i < limiterCurve.length; i++) {
  const x = (i / (limiterCurve.length - 1) * 2 - 1) * 4;
  limiterCurve[i] = Math.sign(x) * (Math.abs(x) <= .65 ? Math.abs(x) : .65 + .3 * Math.tanh((Math.abs(x) - .65) / .3));
}
function outputStage(ctx: BaseAudioContext, destination: AudioNode): GainNode {
  const input = ctx.createGain(), limiter = ctx.createWaveShaper();
  input.gain.value = .25; limiter.curve = limiterCurve;
  input.connect(limiter).connect(destination);
  return input;
}
export function duration(profile: Profile, phase: Phase, p: Parameters) {
  const notes = profile[phase].notes;
  if (notes?.length) return Math.max(...notes.map(n => n.at * Math.sqrt(p.decay) + n.duration * p.decay * 1.25)) + profile[phase].bounce * p.bounce + .04;
  return Math.max(.06, profile[phase].decay * p.decay * 9 + profile[phase].bounce * p.bounce + .035);
}

/** Native oscillators + filtered, generated noise. No recorded buffers involved. */
export function scheduleImpact(ctx: BaseAudioContext, destination: AudioNode, profile: Profile, phase: Phase, params: Parameters, time: number, seed: number) {
  const p = sanitize(params), spec = profile[phase], rng = random(seed);
  const nodes: AudioNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => { nodes.push(n); return n; };
  const varied = 1 + (rng() * 2 - 1) * p.variation;
  const pitch = 2 ** (p.pitch / 12) * varied;
  const decay = spec.decay * p.decay * (1 + (rng() - .5) * p.variation);
  const length = duration(profile, phase, p);
  const bus = keep(ctx.createGain());
  bus.gain.value = spec.level * p.volume * .8;
  bus.connect(destination);
  const envelope = (at: number, life: number, amplitude: number) => {
    const gain = keep(ctx.createGain());
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(Math.max(.000001, amplitude), at + .0007);
    gain.gain.exponentialRampToValueAtTime(.00001, at + Math.max(.002, life));
    gain.gain.linearRampToValueAtTime(0, at + Math.max(.002, life) + .002);
    gain.connect(bus);
    return gain;
  };
  const strike = (at: number, strength: number) => {
    if (spec.notes) {
      const filter = keep(ctx.createBiquadFilter());
      filter.type = 'lowpass'; filter.Q.value = .7;
      filter.frequency.value = Math.min(ctx.sampleRate * .44, spec.brightness * p.brightness);
      const toneBus = keep(ctx.createGain()); toneBus.connect(filter).connect(bus);
      const concurrent = Math.max(1, ...spec.notes.map(n => spec.notes!.filter(m => m.at <= n.at && m.at + m.duration > n.at).length));
      for (const n of spec.notes) {
        const start = at + n.at * Math.sqrt(p.decay);
        const life = Math.max(.006, n.duration * decay / spec.decay);
        const oscillator = keep(ctx.createOscillator()); oscillator.type = n.wave;
        const hz = (f: number) => Math.max(30, Math.min(ctx.sampleRate * .43, f * pitch));
        oscillator.frequency.setValueAtTime(hz(n.frequency), start);
        if (n.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(hz(n.endFrequency), start + life);
        const gain = envelope(start, life, strength * p.body * .9 / Math.sqrt(concurrent));
        gain.disconnect(); gain.connect(toneBus);
        oscillator.connect(gain); oscillator.start(start); oscillator.stop(start + life + .004);
      }
    }
    // Inharmonic resonant modes mimic the switch cap and housing.
    const sum = spec.modes.reduce((s, m) => s + m[1], 0) || 1;
    spec.modes.forEach(([frequency, weight], i) => {
      const osc = keep(ctx.createOscillator());
      const hz = Math.max(30, Math.min(ctx.sampleRate * .43, frequency * pitch));
      osc.type = 'sine';
      osc.frequency.setValueAtTime(Math.min(ctx.sampleRate * .45, hz * (1 + p.snap * .28)), at);
      osc.frequency.exponentialRampToValueAtTime(hz, at + .007);
      const life = Math.min(length - .004, decay * (i === 0 ? 7 : 4.5));
      const shade = Math.min(1, spec.brightness * p.brightness / Math.max(1, hz));
      osc.connect(envelope(at, life, strength * p.body * weight / sum * shade));
      osc.start(at); osc.stop(at + life + .004);
    });
    // Fresh seeded excitation, shaped by a lowpass and a highpass.
    const noiseLife = Math.min(length - .004, Math.max(.006, decay * 3));
    const buffer = ctx.createBuffer(1, Math.ceil((noiseLife + .004) * ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
    const source = keep(ctx.createBufferSource()); source.buffer = buffer;
    const low = keep(ctx.createBiquadFilter()); low.type = 'lowpass'; low.Q.value = .7;
    low.frequency.value = Math.min(ctx.sampleRate * .44, spec.brightness * p.brightness * pitch);
    const high = keep(ctx.createBiquadFilter()); high.type = 'highpass'; high.frequency.value = Math.min(1500, 180 * pitch);
    source.connect(low).connect(high).connect(envelope(at, noiseLife, strength * spec.noise * p.noise * 1.8));
    source.start(at); source.stop(at + noiseLife + .004);
    const click = keep(ctx.createOscillator()); click.type = 'triangle';
    click.frequency.setValueAtTime(Math.min(ctx.sampleRate * .4, 3200 * pitch * p.brightness), at);
    click.frequency.exponentialRampToValueAtTime(Math.max(40, 180 * pitch), at + .004);
    click.connect(envelope(at, .005, strength * p.snap * .24));
    click.start(at); click.stop(at + .008);
  };
  strike(time, 1);
  if (spec.bounce > 0 && p.bounce > 0) strike(time + spec.bounce * p.bounce, Math.min(.6, p.bounce * .25));
  return { end: time + length + .02, disconnect: () => nodes.forEach(n => n.disconnect()) };
}

export class ButtonSynth {
  private ctx?: AudioContext;
  private output?: GainNode;
  private voices: { disconnect: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private muted = false;
  async ready() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.output = this.ctx.createGain(); this.output.gain.value = this.muted ? 0 : 1;
      this.output.connect(this.ctx.destination);
      this.input = outputStage(this.ctx, this.output);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }
  private input?: AudioNode;
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.output) this.output.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, .008);
  }
  async trigger(profile: Profile | string, phase: Phase = 'down', parameters: Partial<Parameters> = {}, seed?: number) {
    const selected = typeof profile === 'string' ? profiles.find(p => p.id === profile) : profile;
    if (!selected) throw new Error('Unknown sound preset.');
    const ctx = await this.ready();
    while (this.voices.length >= 24) { const old = this.voices.shift()!; clearTimeout(old.timer); old.disconnect(); }
    const p = sanitize(parameters);
    const voice = scheduleImpact(ctx, this.input!, selected, phase, p, ctx.currentTime + .003, seed ?? (p.variation === 0 ? 42 : Math.floor(Math.random() * 2 ** 32)));
    const entry = { disconnect: voice.disconnect, timer: setTimeout(() => { voice.disconnect(); this.voices = this.voices.filter(v => v !== entry); }, (voice.end - ctx.currentTime) * 1000 + 50) };
    this.voices.push(entry);
  }
  async dispose() {
    this.voices.forEach(v => { clearTimeout(v.timer); v.disconnect(); }); this.voices = [];
    await this.ctx?.close(); this.ctx = undefined;
  }
}

export async function renderSound(profile: Profile, phase: Phase | 'pair', params: Parameters, seed = 42): Promise<AudioBuffer> {
  const p = sanitize(params);
  const gap = .2;
  const seconds = phase === 'pair' ? Math.max(duration(profile, 'down', p), gap + duration(profile, 'up', p)) : duration(profile, phase, p);
  const ctx = new OfflineAudioContext(1, Math.ceil((seconds + .04) * 48000), 48000);
  const destination = outputStage(ctx, ctx.destination);
  if (phase === 'pair') {
    scheduleImpact(ctx, destination, profile, 'down', p, .005, seed);
    scheduleImpact(ctx, destination, profile, 'up', p, gap + .005, seed + 1);
  } else scheduleImpact(ctx, destination, profile, phase, p, .005, seed);
  return ctx.startRendering();
}

export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const output = new ArrayBuffer(44 + buffer.length * 2), view = new DataView(output);
  const word = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset+i, c.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, 36 + buffer.length * 2, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, buffer.length * 2, true);
  buffer.getChannelData(0).forEach((x, i) => view.setInt16(44 + i*2, Math.round(Math.max(-1, Math.min(1, x)) * (x < 0 ? 32768 : 32767)), true));
  return output;
}
