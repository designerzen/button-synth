import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('every preset renders finite, bounded press and release audio; seeds reproduce exports', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { profiles, defaults, renderSound, encodeWav } = await import('/src/synth.ts');
    const failures: string[] = [];
    for (const profile of profiles) for (const phase of ['down', 'up'] as const) {
      const buffer = await renderSound(profile, phase, defaults, 42);
      const data = buffer.getChannelData(0);
      let peak = 0, energy = 0;
      for (const v of data) { if (!Number.isFinite(v)) failures.push(`${profile.id}/${phase}: nonfinite`); peak = Math.max(peak, Math.abs(v)); energy += v*v; }
      if (peak > 1) failures.push(`${profile.id}/${phase}: clipping ${peak}`);
      if (profile[phase].level > 0 && energy < .000001) failures.push(`${profile.id}/${phase}: silent`);
      if (Math.abs(data[data.length-1]) > .00001) failures.push(`${profile.id}/${phase}: truncated tail`);
    }
    const profile = profiles.find(p => p.id === 'sd-metallic')!;
    const a = await renderSound(profile, 'pair', defaults, 42);
    const b = await renderSound(profile, 'pair', defaults, 42);
    const c = await renderSound(profile, 'pair', defaults, 43);
    // Native audio graphs can differ by floating point summing order across renders.
    const same = a.getChannelData(0).every((v, i) => Math.abs(v - b.getChannelData(0)[i]) < 1e-6);
    const different = a.getChannelData(0).some((v, i) => v !== c.getChannelData(0)[i]);
    const wav = new DataView(encodeWav(a));
    // Exercise extreme controls across the entire library, including game phrases.
    for (const p of profiles) {
      const out = await renderSound(p, 'pair', { ...defaults, pitch: 24, decay: 3, brightness: 3, noise: 2, body: 1, snap: 1, bounce: 2, variation: .5, volume: 1 }, 7);
      if (out.getChannelData(0).some(v => !Number.isFinite(v) || Math.abs(v) > 1)) failures.push(`${p.id}: invalid extreme output`);
    }
    return { failures, count: profiles.length, same, different, sampleRate: wav.getUint32(24, true), size: wav.getUint32(40, true), expectedSize: a.length * 2 };
  });
  expect(results.failures).toEqual([]);
  expect(results.count).toBe(85);
  expect(results.same).toBe(true);
  expect(results.different).toBe(true);
  expect(results.sampleRate).toBe(48000);
  expect(results.size).toBe(results.expectedSize);
});

test('playback and WAV use the same selected phase and audio; synthesis needs no external requests', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:5196')) external.push(r.url()); });
  await page.addInitScript(() => {
    const original = AudioBufferSourceNode.prototype.start;
    (window as any).played = [];
    AudioBufferSourceNode.prototype.start = function (...args: any[]) {
      if (this.context instanceof AudioContext) (window as any).played.push(this.buffer);
      return original.apply(this, args as [number?, number?, number?]);
    };
  });
  await page.goto('/');
  await expect(page.locator('#reference-mode')).toHaveCount(0);
  await expect(page.locator('.advanced')).not.toHaveAttribute('open');
  for (const [part, label] of [['down', 'Press'], ['up', 'Release'], ['pair', 'Both']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator(`[data-phase="${part}"]`)).toHaveAttribute('aria-pressed', 'true');
    const count = await page.evaluate(() => (window as any).played.length);
    await page.locator('#pad').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => (window as any).played.length)).toBe(count + 1);
    const expected = await page.evaluate(async () => {
      const { encodeWav } = await import('/src/synth.ts');
      return Array.from(new Uint8Array(encodeWav((window as any).played.at(-1))));
    });
    const downloaded = page.waitForEvent('download');
    await page.locator('#export').click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe(`hi75-soft-${part}.wav`);
    expect(await readFile((await file.path())!)).toEqual(Buffer.from(expected));
  }
  expect(external).toEqual([]);
});

test('library, parameter persistence, keyboard audition, WAV and preset round trip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.preset')).toHaveCount(85);
  await page.getByRole('combobox', { name: 'Category' }).selectOption('Mice');
  await expect(page.locator('.preset')).toHaveCount(5);
  await page.getByRole('combobox', { name: 'Category' }).selectOption('All');
  await page.getByRole('searchbox').fill('sd metallic');
  await expect(page.locator('.preset')).toHaveCount(1);
  await page.locator('.preset').click();
  await page.locator('#pitch').fill('7');
  await expect(page.locator('#pitch-value')).toHaveText('+7 st');
  await page.reload();
  await expect(page.locator('#pitch')).toHaveValue('7');
  await expect(page.locator('#sound-name')).toHaveText('SD Metallic');
  await page.locator('[data-id="sd-metallic"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-id="sd-resonant"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sound-name')).toHaveText('SD Resonant');
  await expect(page.locator('[data-id="sd-resonant"]')).toBeFocused();
  await page.locator('[data-id="sd-metallic"]').click();
  await page.getByText('Preset & code', { exact: true }).click();
  const presetDownload = page.waitForEvent('download');
  await page.locator('#save').click();
  const preset = await presetDownload;
  await page.locator('#reset').click();
  await expect(page.locator('#pitch')).toHaveValue('0');
  await page.locator('#import-file').setInputFiles((await preset.path())!);
  await expect(page.locator('#pitch')).toHaveValue('7');
  await expect(page.locator('#status')).toContainText('Imported');
  const wavDownload = page.waitForEvent('download');
  await page.locator('#export').click();
  expect((await wavDownload).suggestedFilename()).toBe('sd-metallic-pair.wav');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page.locator('#pad').click();
  await expect(page.locator('#status')).toContainText('Unmute to play');
  expect(errors).toEqual([]);
});

test('invalid imports are rejected and narrow layouts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, preset: 'hi75-soft', parameters: { pitch: 'bad' }, seed: 42 })) });
  await expect(page.locator('#status')).toContainText('Invalid pitch');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('searchbox').fill('no match at all');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.preset')).toHaveCount(85);
  await page.screenshot({ path: '.cache/mobile.png', fullPage: true });
  await page.getByText('More controls', { exact: true }).click();
  await page.locator('#variation').fill('0');
  await expect(page.getByRole('button', { name: 'New variation' })).toBeDisabled();
  await page.locator('#body').fill('.2');
  await expect(page.locator('#body-value')).toHaveText('20%');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText('More controls', { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByText('Preset & code', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tools')).not.toHaveAttribute('open');
  await expect(page.locator('.tools summary')).toBeFocused();
  await page.screenshot({ path: '.cache/desktop.png', fullPage: true });
});

test('pointer press plays down and release plays up even when released off the pad', async ({ page }) => {
  await page.addInitScript(() => {
    const original = AudioBufferSourceNode.prototype.start;
    (window as any).played = [];
    AudioBufferSourceNode.prototype.start = function (...args: any[]) {
      if (this.context instanceof AudioContext) (window as any).played.push(this.buffer);
      return original.apply(this, args as [number?, number?, number?]);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Both', exact: true }).click();
  const box = (await page.locator('#pad').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).played.length)).toBe(1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).played.length)).toBe(2);
});
