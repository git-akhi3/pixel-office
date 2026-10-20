#!/usr/bin/env node
/**
 * Records a director scenario of the running pixel office to a video with its soundtrack.
 *
 *   node scripts/record-scenario.mjs [scenario=mission] [out=demo/raw/<scenario>.mp4] [url=http://127.0.0.1:3100]
 *
 * Opens the office at 1920x1080 in headless Chrome, plays `?scenario=<name>`, waits for the director
 * to finish, asks the page to render the scenario's soundtrack (Web Audio, offline) and muxes the
 * two with ffmpeg into an H.264/AAC mp4. The raw recording (.webm) and the soundtrack (.wav) are
 * kept beside it. Set PW_CHANNEL=chrome to use the installed Google Chrome.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { chromium } from 'playwright';

const [scenario = 'mission', outArg, base = 'http://127.0.0.1:3100'] = process.argv.slice(2);
const out = resolve(outArg ?? `demo/raw/${scenario}.mp4`);
const stem = out.replace(/\.[a-z0-9]+$/i, '');
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: dirname(out), size: { width: 1920, height: 1080 } },
});
const pageCreatedAt = Date.now();
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`${base}/?scenario=${encodeURIComponent(scenario)}`);
await page.waitForFunction(() => window.pixelDirector?.isPlaying(), null, { timeout: 60_000 });
console.log('scenario started');
await page.waitForFunction(() => window.pixelDirector?.isDone(), null, { timeout: 15 * 60_000 });
const errors = await page.evaluate(() => window.pixelDirector?.errors() ?? []);
const startedAt = await page.evaluate(() => window.pixelDirector?.startedAt() ?? 0);
await page.waitForTimeout(2000);
const audio = await page.evaluate(() => window.pixelDirector?.renderAudio());
const video = page.video();
await context.close();
renameSync(await video.path(), `${stem}.webm`);
await browser.close();
if (errors.length) console.error('script errors:\n  ' + errors.join('\n  '));

writeFileSync(`${stem}.wav`, Buffer.from(audio, 'base64'));
// The recording starts when the page opens; the soundtrack at the scenario's first command.
const lead = Math.max(0, (startedAt - pageCreatedAt) / 1000 - 0.05);
execFileSync(ffmpeg, [
  '-y', '-ss', lead.toFixed(3), '-i', `${stem}.webm`, '-i', `${stem}.wav`,
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest', out,
], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`wrote ${out}`);
