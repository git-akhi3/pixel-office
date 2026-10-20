#!/usr/bin/env node
/**
 * Records a director scenario of the running pixel office to a video with its soundtrack.
 *
 *   node scripts/record-scenario.mjs [scenario=mission] [out=demo/raw/<scenario>.mp4] [url=http://127.0.0.1:3100]
 *
 * Frame-accurate: the page freezes real time and the recorder advances it one frame at a time
 * (30 fps), screenshotting each frame, so the result is perfectly smooth no matter how fast the
 * capture runs. The page then renders the scenario's soundtrack offline (Web Audio) and ffmpeg
 * muxes frames and audio into an H.264/AAC mp4. Set PW_CHANNEL=chrome to use the installed Chrome.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { chromium } from 'playwright';

const FPS = 30;
const TAIL_SEC = 2.5;
const [scenario = 'mission', outArg, base = 'http://127.0.0.1:3100'] = process.argv.slice(2);
const out = resolve(outArg ?? `demo/raw/${scenario}.mp4`);
const stem = out.replace(/\.[a-z0-9]+$/i, '');
const frames = `${stem}-frames`;
mkdirSync(dirname(out), { recursive: true });
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames);

const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
if (process.env.KEEP_FRAMES) {
  await page.addInitScript(() => {
    window.__canvasCount = 0;
    const orig = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      if (String(tag).toLowerCase() === 'canvas') window.__canvasCount++;
      return orig(tag, ...rest);
    };
  });
}
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
const LIMIT_SEC = Number(process.env.SCENARIO_LIMIT_SEC || 0);
await page.goto(`${base}/?scenario=${encodeURIComponent(scenario)}`);
await page.waitForFunction(() => window.pixelDirector?.isPlaying(), null, { timeout: 60_000 });
// Freeze time now; every step below is one frame.
await page.evaluate((fps) => window.pixelDirector?.record(fps), FPS);
console.log('scenario started, capturing frames');

// Frames come straight from the canvas (the page draws its HUD onto it while recording), so no
// compositor screenshot is ever awaited.
const capture = async () => {
  const url = await page.evaluate(() => window.pixelDirector?.frame() ?? '');
  if (!url) throw new Error('no frame');
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};
let n = 0;
let tail = -1;
let last = null;
const started = Date.now();
for (;;) {
  await page.evaluate(() => window.pixelDirector?.step());
  let jpg;
  try {
    jpg = await capture();
  } catch (e) {
    console.error(`frame ${n}: ${e.message}, retrying`);
    try {
      jpg = await capture();
    } catch {
      jpg = last; // keep the previous frame rather than stall
    }
  }
  if (jpg) {
    writeFileSync(join(frames, `f${String(n).padStart(6, '0')}.jpg`), jpg);
    last = jpg;
  }
  n++;
  if (tail < 0 && (await page.evaluate(() => window.pixelDirector?.isDone()))) tail = n + TAIL_SEC * FPS;
  if (tail >= 0 && n >= tail) break;
  if (n > FPS * 900) break; // 15 minutes, something is stuck
  if (n % (FPS * 5) === 0 || (jpg && jpg.length < 60000 && n % FPS === 0)) {
    const sec = n / FPS;
    const rate = n / ((Date.now() - started) / 1000);
    const diag = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const d = window.pixelDirector;
      const t = document.createElement('canvas');
      t.width = 64; t.height = 64;
      const tc = t.getContext('2d');
      tc.fillStyle = '#ff0000'; tc.fillRect(0, 0, 64, 64);
      const probe = tc.getImageData(1, 1, 1, 1).data[0];
      return `canvas ${c?.width}x${c?.height} heap ${Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6)}MB canvases ${window.__canvasCount ?? '?'} newCanvasRed ${probe} clock ${d?.clock().toFixed(1)} playing ${d?.isPlaying()} errors ${d?.errors().length}`;
    });
    console.log(`  ${sec.toFixed(0)} s of video (${rate.toFixed(1)} frames/s) ${diag}`);
    if (LIMIT_SEC && sec >= LIMIT_SEC) { tail = n; break; }
  }
}
const errors = await page.evaluate(() => window.pixelDirector?.errors() ?? []);
const audio = await page.evaluate(() => window.pixelDirector?.renderAudio());
await browser.close();
if (errors.length) console.error('script errors:\n  ' + errors.join('\n  '));

writeFileSync(`${stem}.wav`, Buffer.from(audio, 'base64'));
execFileSync(ffmpeg, [
  '-y', '-framerate', String(FPS), '-i', join(frames, 'f%06d.jpg'), '-i', `${stem}.wav`,
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out,
], { stdio: ['ignore', 'ignore', 'inherit'] });
if (!process.env.KEEP_FRAMES) rmSync(frames, { recursive: true, force: true });
console.log(`wrote ${out} (${(n / FPS).toFixed(1)} s)`);
