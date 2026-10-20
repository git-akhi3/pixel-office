#!/usr/bin/env node
/**
 * Records a director scenario of the running pixel office to a video file.
 *
 *   node scripts/record-scenario.mjs [scenario=mission] [out=demo/raw/<scenario>.webm] [url=http://127.0.0.1:3100]
 *
 * Opens the office at 1920x1080 in headless Chrome, plays `?scenario=<name>`, waits for the director
 * to finish, and writes the recording. Sound is not captured (it is added in post).
 */
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const [scenario = 'mission', outArg, base = 'http://127.0.0.1:3100'] = process.argv.slice(2);
const out = resolve(outArg ?? `demo/raw/${scenario}.webm`);
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: dirname(out), size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`${base}/?scenario=${encodeURIComponent(scenario)}`);
await page.waitForFunction(() => window.pixelDirector?.isPlaying(), null, { timeout: 60_000 });
console.log('scenario started');
await page.waitForFunction(() => window.pixelDirector?.isDone(), null, { timeout: 15 * 60_000 });
const errors = await page.evaluate(() => window.pixelDirector?.errors() ?? []);
await page.waitForTimeout(1500);
const video = page.video();
await context.close();
const tmp = await video.path();
renameSync(tmp, out);
await browser.close();
if (errors.length) console.error('script errors:\n  ' + errors.join('\n  '));
console.log(`wrote ${out}`);
