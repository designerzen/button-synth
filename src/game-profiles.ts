import type { Impact, Profile } from './synth';

// Original chiptune-style cues: short pulse/triangle phrases, not game recordings.
const note = (frequency: number, at = 0, duration = .065, wave: OscillatorType = 'square', endFrequency?: number) =>
  ({ frequency, at, duration, wave, endFrequency });
function impact(notes: NonNullable<Impact['notes']>, level = .65, noise = .015): Impact {
  return { notes, modes: [], decay: .012, brightness: 6500, noise, bounce: .025, level };
}
function game(id: string, name: string, down: Impact, up: Impact): Profile {
  return { id: `game-${id}`, name, samples: 0, down, up };
}
const coreGameProfiles: Profile[] = [
  game('8bit-select', '8-bit Select', impact([note(880, 0, .035), note(1320, .035, .045)]), impact([note(660, 0, .025, 'triangle')], .35)),
  game('arcade-confirm', 'Arcade Confirm', impact([note(523.25, 0, .055), note(659.25, .045, .055), note(1046.5, .09, .11)]), impact([note(1568, 0, .035, 'triangle')], .32)),
  game('menu-back', 'Menu Back', impact([note(880, 0, .045), note(440, .04, .075)]), impact([note(220, 0, .03, 'triangle')], .3)),
  game('menu-error', 'Menu Error', impact([note(146.83, 0, .075, 'sawtooth'), note(138.59, .09, .09, 'sawtooth')], .55, .05), impact([note(110, 0, .04, 'triangle')], .3)),
  game('coin-pickup', 'Coin Pickup', impact([note(987.77, 0, .045), note(1318.51, .045, .16)]), impact([note(1975.53, 0, .025, 'triangle')], .23)),
  game('game-start', 'Game Start', impact([note(392, 0, .055), note(523.25, .05, .055), note(659.25, .10, .055), note(783.99, .15, .13)]), impact([note(1046.5, 0, .045, 'triangle')], .3)),
  game('power-up', 'Power Up', impact([note(220, 0, .065, 'square', 440), note(440, .06, .065, 'square', 880), note(880, .12, .12, 'square', 1760)]), impact([note(1760, 0, .04, 'triangle')], .28)),
  game('pause-blip', 'Pause Blip', impact([note(659.25, 0, .05, 'triangle'), note(523.25, .07, .08, 'triangle')]), impact([note(659.25, 0, .03, 'triangle')], .3)),
  game('console-confirm', 'Console Confirm', impact([note(523.25, 0, .10, 'triangle'), note(783.99, 0, .10, 'triangle'), note(1046.5, .07, .14, 'sine')], .6), impact([note(1318.51, 0, .04, 'sine')], .28)),
  game('pixel-toggle', 'Pixel Toggle', impact([note(440, 0, .075, 'square', 880)], .6), impact([note(880, 0, .065, 'square', 440)], .45)),
];

// Fixed-seed generator so the "random" cues are chaotic-sounding but identical on every load.
function rng(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const waves: OscillatorType[] = ['square', 'sawtooth', 'triangle', 'sine'];
function scramble(seed: number, count: number, step: number, low: number, high: number, level = .55, noise = .03): Impact {
  const next = rng(seed);
  const notes = Array.from({ length: count }, (_, i) => {
    const frequency = low * Math.pow(high / low, next());
    const sweep = next() < .35 ? frequency * (next() < .5 ? .5 : 2) : undefined;
    return note(frequency, i * step * (.7 + next() * .6), step * (.8 + next()), waves[Math.floor(next() * waves.length)], sweep);
  });
  return impact(notes, level, noise);
}
const arp = (root: number, ratios: number[], step: number, wave: OscillatorType = 'square') =>
  ratios.map((r, i) => note(root * r, i * step, step * 1.1, wave));

const extraGameProfiles: Profile[] = [
  // Space
  game('space-laser', 'Laser Zap', impact([note(2400, 0, .16, 'sawtooth', 180)], .6, .01), impact([note(300, 0, .05, 'sine', 120)], .3)),
  game('space-warp', 'Warp Drive', impact([note(80, 0, .35, 'sawtooth', 1800), note(160, 0, .35, 'sine', 3200)], .5, .04), impact([note(1800, 0, .12, 'sine', 90)], .35)),
  game('space-sonar', 'Sonar Ping', impact([note(1320, 0, .5, 'sine'), note(1330, .01, .5, 'sine')], .55, .004), impact([note(660, 0, .09, 'sine')], .25)),
  game('space-airlock', 'Airlock', impact([note(110, 0, .09, 'sawtooth', 55), note(70, .09, .18, 'square', 40)], .6, .09), impact([note(2000, 0, .06, 'sine', 400)], .25, .06)),
  game('space-tractor', 'Tractor Beam', impact([note(300, 0, .12, 'triangle', 600), note(600, .12, .12, 'triangle', 300), note(300, .24, .12, 'triangle', 600)], .55, .01), impact([note(450, 0, .07, 'triangle', 150)], .3)),
  game('space-alien', 'Alien Chirp', impact([note(900, 0, .05, 'sine', 2400), note(2400, .06, .04, 'sine', 700), note(1100, .12, .08, 'triangle', 3000)], .55, .005), impact([note(1500, 0, .05, 'sine', 500)], .25)),
  // 8-bit
  game('8bit-jump', '8-bit Jump', impact([note(260, 0, .14, 'square', 780)]), impact([note(520, 0, .05, 'square', 260)], .35)),
  game('8bit-blip', '8-bit Blip', impact([note(1046.5, 0, .04, 'square')]), impact([note(784, 0, .03, 'square')], .35)),
  game('8bit-hit', '8-bit Hit', impact([note(180, 0, .12, 'square', 60)], .7, .25), impact([note(90, 0, .05, 'square')], .35, .1)),
  game('8bit-arp', '8-bit Arpeggio', impact(arp(261.63, [1, 1.26, 1.5, 2, 1.5, 1.26, 1], .04)), impact([note(1046.5, 0, .04, 'triangle')], .3)),
  game('8bit-levelup', '8-bit Level Up', impact(arp(392, [1, 1.26, 1.5, 2, 2.52, 3], .055, 'square')), impact([note(2349, 0, .05, 'triangle')], .3)),
  game('8bit-gameover', '8-bit Game Over', impact([note(392, 0, .16, 'triangle'), note(329.63, .17, .16, 'triangle'), note(261.63, .34, .16, 'triangle'), note(130.81, .51, .35, 'sawtooth', 65)], .6), impact([note(98, 0, .08, 'triangle')], .3)),
  // Random
  game('random-glitch', 'Glitch Burst', scramble(11, 9, .022, 200, 4000), scramble(12, 3, .02, 300, 3000, .35)),
  game('random-scramble', 'Data Scramble', scramble(21, 14, .018, 400, 6000, .5, .05), scramble(22, 4, .02, 800, 5000, .3)),
  game('random-bloop', 'Bleep Bloop', scramble(31, 5, .06, 150, 1800, .6, .01), scramble(32, 2, .05, 200, 1200, .35, .01)),
  game('random-static', 'Static Pop', scramble(41, 6, .03, 60, 900, .6, .3), scramble(42, 2, .03, 100, 600, .35, .25)),
  game('random-wobble', 'Wobble Trill', scramble(51, 8, .035, 500, 1500), scramble(52, 3, .03, 500, 1500, .35)),
  game('random-chaos', 'Chaos Chime', scramble(61, 7, .07, 700, 5000, .5, .005), scramble(62, 3, .05, 900, 4000, .3, .005)),
];
export const gameProfiles: Profile[] = [...coreGameProfiles, ...extraGameProfiles];
