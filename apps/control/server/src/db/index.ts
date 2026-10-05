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
  rateLimit: { fiveHour?: number; sevenDay?: number; resetsAt?: number; at: number } | null;
}

const DEFAULTS: Settings = { autoApprovePush: false, concurrency: 2, rateLimit: null };

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
