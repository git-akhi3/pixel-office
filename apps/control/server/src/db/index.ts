import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = resolve(fileURLToPath(import.meta.url), '../../../drizzle');

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export interface Settings {
  autoApprovePush: boolean;
  concurrency: number;
  /** Queue reviews for PRs that request my review (registered repos only). Off by default. */
  reviewAutoPickup: boolean;
  /** Skip auto-pickup for PRs smaller than this many changed lines. */
  reviewMinLines: number;
  rateLimit: { fiveHour?: number; sevenDay?: number; fiveHourResetsAt?: number; sevenDayResetsAt?: number; resetsAt?: number; at: number } | null;
  /** Start no new agent steps once the 5-hour or 7-day usage reaches this fraction (1 = never pause). */
  usagePauseAt: number;
  /** Stable id of the office's session in Pixel Agents, so restarts don't add characters. */
  pixelSessionId: string | null;
  /** The skill the architect follows when a mission is grilled (a short built-in fallback when it isn't in the catalog). */
  grillSkill: string;
  /** On size S tasks, run the architect and reviewer on Sonnet when their definition says Opus. */
  sonnetForSmall: boolean;
  /** Allow commands off the allow-list without asking, unless crucialCommand() says they need me. */
  autoAllowCommands: boolean;
}

const UNKNOWN_RESET_PAUSE_MS = 30 * 60 * 1000;

/** Whether new steps should wait for a usage window to reset, and until when (ms). */
export function usagePause(s: Settings, now: number): { paused: boolean; until: number | null; window: string | null } {
  const r = s.rateLimit;
  if (!r || s.usagePauseAt >= 1) return { paused: false, until: null, window: null };
  const windows: Array<[string, number | undefined, number | undefined]> = [
    ['5-hour', r.fiveHour, r.fiveHourResetsAt],
    ['7-day', r.sevenDay, r.sevenDayResetsAt],
  ];
  for (const [window, used, resets] of windows) {
    if (used === undefined || used < s.usagePauseAt) continue;
    // Without a reset time, pause briefly from when the reading was taken; the next run refreshes it.
    const until = resets ? resets * 1000 : r.at + UNKNOWN_RESET_PAUSE_MS;
    if (until > now) return { paused: true, until, window };
  }
  return { paused: false, until: null, window: null };
}

const DEFAULTS: Settings = { autoApprovePush: false, concurrency: 2, reviewAutoPickup: false, reviewMinLines: 0, rateLimit: null, usagePauseAt: 0.9, pixelSessionId: null, grillSkill: 'grilling', sonnetForSmall: true, autoAllowCommands: false };

export function getSettings(db: Db): Settings {
  const rows = db.select().from(schema.settings).all();
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out as unknown as Settings;
}

export function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

export function deleteSetting(db: Db, key: keyof Settings): void {
  db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
}

export { schema };
