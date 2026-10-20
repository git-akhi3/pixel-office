// Runs the office for its login item (tools/mac-agent.sh); launchd starts it again whenever it exits.
//
// Written for node, not the shell: macOS only lets a launchd job into ~/Documents (where this checkout
// and the repos live) when the program launchd starts has been allowed there, and node has.
// - While another copy holds the port (one started by hand), it waits, then takes over.
// - The office runs in this same process, so launchd's SIGTERM reaches its shutdown handler (running
//   steps are parked for me to resume, not killed half-way).
// - caffeinate keeps the Mac from sleeping while the office runs on power. On battery it sleeps as usual.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const control = join(root, 'apps', 'control');
const port = Number(process.env.OFFICE_PORT ?? 4100);
const home = process.env.OFFICE_HOME ?? join(homedir(), '.office');
const log = (m) => console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} office-service: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portTaken = () =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

if (await portTaken()) {
  log(`another office holds port ${port}; waiting for it to stop`);
  while (await portTaken()) await sleep(30_000);
}

// Without its token the office can't start: say so every few minutes rather than rebuilding the board
// on every relaunch.
let env = '';
try {
  env = readFileSync(join(home, 'env'), 'utf8');
} catch {
  // missing: same as no token
}
if (!/^CLAUDE_CODE_OAUTH_TOKEN=./m.test(env)) {
  log(`no CLAUDE_CODE_OAUTH_TOKEN in ${join(home, 'env')} yet (see the README)`);
  await sleep(300_000);
  process.exit(1);
}

process.chdir(control);
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const build = spawnSync(process.execPath, [vite, 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' });
if (build.status !== 0) {
  log('building the board failed');
  await sleep(60_000);
  process.exit(1);
}

spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
const { register } = await import(pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')).href);
register();
await import(pathToFileURL(join(control, 'server', 'src', 'index.ts')).href);
