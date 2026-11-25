import { test, expect } from '@playwright/test';

test('game sounds use pitched phrases, respond to controls, and export without reference downloads', async ({ page }) => {
  const downloads: string[] = [];
  page.on('request', r => { if (r.url().includes('raw.githubusercontent.com')) downloads.push(r.url()); });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Category' }).selectOption('Game sounds');
  await expect(page.locator('.preset')).toHaveCount(10);
  await page.locator('[data-id="game-coin-pickup"]').click();
  await expect(page.locator('#sound-name')).toHaveText('Coin Pickup');
  await expect(page.locator('#reference-mode')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play sound', exact: true }).click();
  const result = await page.evaluate(async () => {
    const { profiles, defaults, renderSound } = await import('/src/synth.ts');
    const p = profiles.find(p => p.id === 'game-coin-pickup')!;
    const a = await renderSound(p, 'down', { ...defaults, variation: 0 });
    const shifted = await renderSound(p, 'down', { ...defaults, variation: 0, pitch: 12 });
    const longer = await renderSound(p, 'down', { ...defaults, decay: 2 });
    // Count positive crossings in the sustained second note, away from attacks.
    function crossings(buffer: AudioBuffer) {
      const data = buffer.getChannelData(0); let count = 0;
      for (let i = Math.floor(.085 * buffer.sampleRate); i < .14 * buffer.sampleRate; i++) if (data[i-1] <= 0 && data[i] > 0) count++;
      return count;
    }
    return { ratio: crossings(shifted) / crossings(a), length: a.duration, longer: longer.duration };
  });
  expect(result.ratio).toBeGreaterThan(1.8);
  expect(result.ratio).toBeLessThan(2.2);
  expect(result.longer).toBeGreaterThan(result.length * 1.5);
  const file = page.waitForEvent('download');
  await page.locator('#export').click();
  expect((await file).suggestedFilename()).toBe('game-coin-pickup-pair.wav');
  await page.getByRole('combobox', { name: 'Category' }).selectOption('All');
  await page.locator('[data-id="hi75-soft"]').click();
  expect(downloads).toEqual([]);
});
