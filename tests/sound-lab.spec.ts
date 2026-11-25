import { test, expect } from '@playwright/test';

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
  expect(results.count).toBe(67);
  expect(results.same).toBe(true);
  expect(results.different).toBe(true);
  expect(results.sampleRate).toBe(48000);
  expect(results.size).toBe(results.expectedSize);
});

test('reference mode loads before audition and download failures leave synthesis usable', async ({ page }) => {
  await page.goto('/');
  const wav = await page.evaluate(async () => {
    const { renderSound, profiles, defaults, encodeWav } = await import('/src/synth.ts');
    return Array.from(new Uint8Array(encodeWav(await renderSound(profiles[0], 'pair', defaults))));
  });
  let requests = 0;
  await page.route('https://raw.githubusercontent.com/**', async route => {
    requests++;
    if (requests > 1) return route.fulfill({ status: 503 });
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from(wav) });
  });
  await page.locator('#reference-mode').click();
  await expect(page.locator('#status')).toContainText('Original reference ready');
  await expect(page.locator('#pad')).toBeEnabled();
  await page.locator('#play-pair').click();
  await expect(page.locator('#status')).toContainText('Playing original');
  await page.locator('.preset').first().click();
  await expect(page.locator('#status')).toContainText('Could not load original');
  await page.locator('#synth-mode').click();
  await expect(page.locator('#pad')).toBeEnabled();
  await page.locator('#play-pair').click();
  await expect(page.locator('#status')).toContainText('procedural synthesis');
});

test('library, parameter persistence, keyboard audition, WAV and preset round trip', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.preset')).toHaveCount(67);
  await page.getByRole('button', { name: 'Mice', exact: true }).click();
  await expect(page.locator('.preset')).toHaveCount(5);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('searchbox').fill('sd metallic');
  await expect(page.locator('.preset')).toHaveCount(1);
  await page.locator('.preset').click();
  await page.locator('#pitch').fill('7');
  await expect(page.locator('#pitch-value')).toHaveText('+7 st');
  await page.reload();
  await expect(page.locator('#pitch')).toHaveValue('7');
  await expect(page.locator('#sound-name')).toHaveText('SD Metallic');
  await page.locator('#pad').focus();
  await page.keyboard.down('Space');
  await expect(page.locator('#pad')).toHaveClass(/pressed/);
  await page.keyboard.up('Space');
  await expect(page.locator('#pad')).not.toHaveClass(/pressed/);
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
  await page.getByRole('button', { name: 'Sound on' }).click();
  await page.locator('#play-pair').click();
  await expect(page.locator('#status')).toContainText('muted');
  expect(errors).toEqual([]);
});

test('invalid imports are rejected and narrow layouts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, preset: 'hi75-soft', parameters: { pitch: 'bad' }, seed: 42 })) });
  await expect(page.locator('#status')).toContainText('Invalid pitch');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#pad').tap({ force: true }).catch(() => page.locator('#pad').click());
  await page.screenshot({ path: '.cache/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: '.cache/desktop.png', fullPage: true });
});
