import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(fileURLToPath(import.meta.url), '../../..');

export interface OfficeConfig {
  home: string;
  dbPath: string;
  tasksDir: string;
  worktreesDir: string;
  envFile: string;
  /** Built-in agent and skill definitions (the defaults). */
  agentsDir: string;
  skillsDir: string;
  /** My edits, which override the defaults: ~/.office/agents/<role>.md, ~/.office/skills/<name>/SKILL.md */
  customAgentsDir: string;
  customSkillsDir: string;
  knowledgeDir: string;
  graphsDir: string;
  /** "Install globally" copies a skill here, for my own Claude Code sessions. */
  claudeSkillsDir: string;
  /** Where the Team page looks for Claude Code skills to import (plugins and ~/.claude/skills). */
  importRoots: Array<{ label: string; dir: string }>;
  /** Files I attach to missions, waiting for the task that claims them. */
  uploadsDir: string;
  /** Written by start.sh: the workspace the pixel office watches. */
  pixelWorkspaceFile: string;
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
    customAgentsDir: join(home, 'agents'),
    customSkillsDir: join(home, 'skills'),
    knowledgeDir: join(home, 'knowledge'),
    graphsDir: join(home, 'graphs'),
    pixelWorkspaceFile: join(home, 'pixel-workspace'),
    claudeSkillsDir: env.OFFICE_CLAUDE_SKILLS_DIR ?? join(homedir(), '.claude', 'skills'),
    importRoots: env.OFFICE_IMPORT_ROOTS
      ? env.OFFICE_IMPORT_ROOTS.split(delimiter).filter(Boolean).map((dir) => ({ label: dir, dir }))
      : [
          { label: '~/.claude/skills', dir: join(homedir(), '.claude', 'skills') },
          { label: 'Claude Code plugins', dir: join(homedir(), '.claude', 'plugins') },
          // The Claude desktop app keeps its plugins' skills here.
          { label: 'Claude app plugins', dir: join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions') },
        ],
    uploadsDir: join(home, 'uploads'),
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
 * Reads ~/.office/env (KEY=value lines, mode 600): the Claude token, Slack tokens and remote-access
 * settings. Values are never logged.
 */
export function loadEnvFile(envFile: string): Record<string, string> {
  if (!existsSync(envFile)) {
    throw new Error(
      `No ${envFile}. Create a token with \`claude setup-token\` and save it there as CLAUDE_CODE_OAUTH_TOKEN=<token> (chmod 600).`,
    );
  }
  const mode = statSync(envFile).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${envFile} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${envFile}`);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"]*?)"?\s*$/);
    if (m?.[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

/** The subscription token from `claude setup-token`. */
export function loadOauthToken(envFile: string): string {
  const token = loadEnvFile(envFile).CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error(`${envFile} has no CLAUDE_CODE_OAUTH_TOKEN line.`);
  return token;
}

export interface RemoteConfig {
  /** Where links in Slack point, e.g. https://office.example.dev. Defaults to the local address. */
  publicUrl: string;
  /** Extra Host headers accepted (the tunnel hostname). Each must be protected by Cloudflare Access. */
  allowedHosts: string[];
  /** Cloudflare Access: team domain (e.g. myteam.cloudflareaccess.com) and the application's AUD tag. */
  accessTeamDomain?: string;
  accessAud?: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  ownerId: string;
}

export function remoteConfig(config: OfficeConfig, env: Record<string, string>): RemoteConfig {
  const allowedHosts = (env.OFFICE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    publicUrl: (env.OFFICE_PUBLIC_URL ?? `http://${config.host}:${config.port}`).replace(/\/$/, ''),
    allowedHosts,
    accessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    accessAud: env.CF_ACCESS_AUD,
  };
}

/** Slack is optional: all three values or nothing. */
export function slackConfig(env: Record<string, string>): SlackConfig | null {
  const { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken, SLACK_OWNER_ID: ownerId } = env;
  if (!botToken && !appToken && !ownerId) return null;
  if (!botToken?.startsWith('xoxb-')) throw new Error('SLACK_BOT_TOKEN must be the xoxb- bot token.');
  if (!appToken?.startsWith('xapp-')) throw new Error('SLACK_APP_TOKEN must be the xapp- app-level token (connections:write).');
  if (!ownerId?.match(/^[UW][A-Z0-9]+$/)) throw new Error('SLACK_OWNER_ID must be your Slack member ID (starts with U).');
  return { botToken, appToken, ownerId };
}
