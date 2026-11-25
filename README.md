# Button Synth

A procedural Web Audio sound lab inspired by [Josh Comeau’s Button Sounds](https://github.com/joshwcomeau/button-sounds/tree/main/package/audio). All 57 WAV files have corresponding editable synthesis profiles, with distinct press and release characteristics. These are measured starting points and perceptual approximations, not identical reproductions of the recordings.

**[Open the live sound lab](https://designerzen.github.io/button-synth/)**

The **Game sounds** category adds 10 original procedural cues for classic arcade and console interfaces: 8-bit Select, Arcade Confirm, Menu Back, Menu Error, Coin Pickup, Game Start, Power Up, Pause Blip, Console Confirm, and Pixel Toggle. These use square, triangle, sawtooth, and sine oscillators with authored note sequences, chords, and pitch sweeps. They have separate release cues and support all shaping controls, JSON presets, and WAV exports. They do not have reference recordings. There are 67 presets in total.

## GitHub Pages

The `.github/workflows/pages.yml` workflow builds and deploys the site on every push to `main`, or when manually run from the Actions tab. It uses the pinned pnpm version from `package.json`, Node.js 24, and the committed lockfile. Repository Pages settings must use **GitHub Actions** as the source. Vite emits relative asset URLs so the build works under `/button-synth/`.

## Run

```sh
pnpm install
pnpm dev
```

Open the local address printed by Vite. `pnpm build` type-checks and creates `dist/`. `pnpm test` runs the Chromium integration and audio-rendering checks; install Chromium with `pnpm exec playwright install chromium` if needed. Tests use their own port, 5196.

## Sound lab

- Select a preset, then press and hold the large button. Press and release produce separate sounds. Space and Enter work when the button has focus.
- Adjust pitch, decay, brightness, body, noise texture, transient snap, mechanical bounce, variation, and output level. Bounce affects presets with a detected secondary impact, or adds a short echo to game cues. Controls apply to both press and release profiles.
- Switch to **Original** for A/B comparison. This downloads the selected recording from GitHub and auditions its first press/release pair. Synthesis needs no recordings or network connection once the app is loaded. Network failures leave synthesis available.
- Select Press, Release, or Pair above the waveform to choose the preview and WAV export. Pair uses a 200 ms hold. The waveform seed gives repeatable procedural excitation; the seed button changes it. Native Web Audio implementations can have tiny floating point differences.
- WAV exports are mono, 48 kHz, 16-bit PCM. They always contain the synthesized sound, including when Original mode is selected. Mute controls audition playback; exports retain the chosen output level.
- Settings are saved per preset in browser storage. Save/Import JSON transfers settings and seed. Reset restores the selected sound’s controls. Copy code provides an integration snippet for this repository’s engine.

## Reuse the engine

Copy `src/synth.ts`, `src/game-profiles.ts`, and `src/profiles.json` into a TypeScript browser project. The engine has no runtime dependencies and does not import the UI.

```ts
import { ButtonSynth } from './src/synth';

const synth = new ButtonSynth();
const parameters = { pitch: -3, decay: .7, brightness: 1.4 };

// Trigger from a user interaction so the browser can unlock audio.
button.addEventListener('pointerdown', () => {
  void synth.trigger('hi75-soft', 'down', parameters);
});
button.addEventListener('pointerup', () => {
  void synth.trigger('hi75-soft', 'up', parameters);
});

// synth.setMuted(true);
// await synth.dispose(); // when the component is removed
```

`trigger` takes a preset ID (or profile), phase, optional partial parameters, and optional numeric seed. Reuse one instance. Parameter ranges are exported as `limits`; `sanitize` fills defaults, clamps ranges, and rejects non-finite values. With variation at zero, unseeded triggers reuse a fixed excitation; otherwise each trigger gets a new seed. Explicit seeds also support reproducible sound design.

`renderSound(profile, 'down' | 'up' | 'pair', parameters, seed)` renders through `OfflineAudioContext`. `encodeWav(buffer)` returns a WAV `ArrayBuffer`. `scheduleImpact` exposes the native node graph for applications that own an audio context and destination; provide your own output protection when using this low-level function. Disconnect the returned voice after its `end` time. The `ButtonSynth` wrapper handles cleanup and limits simultaneous voices to 24. Both the wrapper and offline renderer use a shared soft limiter that stays linear for quieter signals and bounds extreme combinations below full scale.

## How synthesis works

Each acoustic impact combines up to eight damped resonant sine modes (with individually measured per-mode decays and optional pitch sweeps), a 7-band 4th-order bandpass procedural noise bank spanning 35 Hz to 19.5 kHz (with equivalent noise bandwidth gain compensation and per-band decays), measured attack shaping, and multi-hit sub-event scheduling for double-clicks, latches, and trills. Seeded perturbations vary tuning, decay, and noise excitation. No PCM from the recordings is stored in the profiles or used by synthesis.

The controls operate on this compact model, so fine texture, stereo imaging, and subtle room acoustics are approximated while preserving each switch's spectral balance, decay envelope, and multi-event character.

## Regenerate the profiles

```sh
pnpm analyze
```

Requires Python 3 and `ffmpeg` on PATH. `scripts/analyze.py` downloads the upstream WAVs into the ignored `.cache/reference/` folder and analyzes them at full 48 kHz bandwidth using the documented sprite offsets (press at 1 s, 2 s, etc.; release 200 ms later). It separates high-prominence tonal modes from broadband residual noise across seven perceptual sub-bands, measures per-mode and per-band exponential decay constants, detects pitch sweeps, and extracts multi-hit sub-events. The generated profiles are committed so running the app never requires this analysis step.

Reference format: [upstream raw-audio documentation](https://github.com/joshwcomeau/button-sounds/blob/main/docs/raw-audio-files.md). Reference recordings are MIT licensed, copyright Josh Comeau. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
