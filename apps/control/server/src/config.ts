import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(fileURLToPath(import.meta.url), '../../..');

export interface OfficeConfig {
  home: string;
  dbPath: string;
  tasksDir: string;
  worktreesDir: string;
  envFile: string;
  agentsDir: string;
  skillsDir: string;
  webDist: string;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OfficeConfig {
  const home = resolve(env.OFFICE_HOME ?? join(homedir(), '.office'));
  return {
    home,
    dbPath: join(home, 'office.db'),
    tasksDir: join(home, 'tasks'),
    worktreesDir: join(home, 'worktrees'),
    envFile: join(home, 'env'),
    agentsDir: env.OFFICE_AGENTS_DIR ?? join(appDir, 'agents'),
    skillsDir: env.OFFICE_SKILLS_DIR ?? join(appDir, 'skills'),
    webDist: join(appDir, 'web', 'dist'),
    host: '127.0.0.1',
    port: Number(env.OFFICE_PORT ?? 4100),
  };
}

export function ensureDirs(config: OfficeConfig): void {
  for (const dir of [config.home, config.tasksDir, config.worktreesDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * The subscription token from `claude setup-token`, kept in ~/.office/env as
 * CLAUDE_CODE_OAUTH_TOKEN=... (mode 600). Never logged.
 */
export function loadOauthToken(envFile: string): string {
  if (!existsSync(envFile)) {
    throw new Error(
      `No ${envFile}. Create a token with \`claude setup-token\` and save it there as CLAUDE_CODE_OAUTH_TOKEN=<token> (chmod 600).`,
    );
  }
  const mode = statSync(envFile).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${envFile} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${envFile}`);
  }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m?.[1]) return m[1];
  }
  throw new Error(`${envFile} has no CLAUDE_CODE_OAUTH_TOKEN line.`);
}
