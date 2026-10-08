import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fileWatcher.ts imports 'vscode' at module load; stub what it touches so it loads under vitest.
vi.mock('vscode', () => ({ window: { activeTerminal: undefined, terminals: [] } }));

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { EXTERNAL_IDLE_DESPAWN_MS } from '../src/constants.js';
import { ensureProjectScan, staleExternalAgentIds } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

const adapter: StateAdapter = {
  loadAgents: () => [],
  saveAgents: () => {},
  loadSeats: () => ({}),
  saveSeats: () => {},
  getSetting: <T>(_k: string, d: T): T => d,
  setSetting: () => {},
};

describe('staleExternalAgentIds', () => {
  let root: string;
  let workspaceDir: string;
  let otherDir: string;
  let agents: AgentStateStore;
  const scanTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
  const now = Date.now();

  function agent(id: number, dir: string, idleMs: number, overrides: Partial<AgentState> = {}): AgentState {
    const jsonlFile = path.join(dir, `s${id}.jsonl`);
    fs.writeFileSync(jsonlFile, '{}\n');
    const t = (now - idleMs) / 1000;
    fs.utimesSync(jsonlFile, t, t);
    const a = {
      id,
      sessionId: `s${id}`,
      isExternal: true,
      projectDir: dir,
      jsonlFile,
      permissionSent: false,
      ...overrides,
    } as AgentState;
    agents.set(id, a);
    return a;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-stale-'));
    workspaceDir = path.join(root, 'workspace');
    otherDir = path.join(root, 'other');
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(otherDir);
    agents = new AgentStateStore();
    agents.setAdapter(adapter);
    // Registers workspaceDir as the watched workspace (it is empty, so nothing is adopted).
    ensureProjectScan(
      workspaceDir,
      new Set(),
      scanTimer,
      { current: null },
      { current: 100 },
      agents,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      () => {},
    );
  });

  afterEach(() => {
    if (scanTimer.current) clearInterval(scanTimer.current);
    scanTimer.current = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes field agents idle past the limit, with or without hooks', () => {
    agent(1, otherDir, EXTERNAL_IDLE_DESPAWN_MS + 60_000);
    agent(2, otherDir, 60_000);
    expect(staleExternalAgentIds(agents, now, true)).toEqual([1]);
    expect(staleExternalAgentIds(agents, now, false)).toEqual([1]);
  });

  it('keeps the watched workspace, teammates and agents waiting on a permission', () => {
    const old = EXTERNAL_IDLE_DESPAWN_MS * 10;
    agent(1, workspaceDir, old);
    agent(2, otherDir, old, { leadAgentId: 9 });
    agent(3, otherDir, old, { permissionSent: true });
    agent(4, otherDir, old, { isExternal: false });
    expect(staleExternalAgentIds(agents, now, true)).toEqual([]);
  });

  it('removes agents whose transcript is gone only when hooks are off', () => {
    const a = agent(1, workspaceDir, 0);
    fs.unlinkSync(a.jsonlFile);
    expect(staleExternalAgentIds(agents, now, true)).toEqual([]);
    expect(staleExternalAgentIds(agents, now, false)).toEqual([1]);
  });
});
