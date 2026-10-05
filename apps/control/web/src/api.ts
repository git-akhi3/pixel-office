// Typed client for the control API. Types mirror server/src/db/schema.ts.

export type TaskStatus = string;

export interface Gate {
  id: number;
  taskId: number;
  kind: 'plan' | 'push' | 'command';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  subject: string | null;
  decision: string | null;
  comment: string | null;
  auto: boolean;
  createdAt: number;
  decidedAt: number | null;
}

export interface Task {
  id: number;
  repoId: number;
  title: string;
  input: string;
  kind: 'feature' | 'bug';
  size: 'S' | 'M' | 'L' | null;
  status: TaskStatus;
  resumeStatus: TaskStatus | null;
  statusNote: string | null;
  loopCount: number;
  replanCount: number;
  testFailures: number;
  tokenEstimate: number | null;
  filesInScope: string[];
  branch: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  resumeAt: number | null;
  createdAt: number;
  updatedAt: number;
  column: string;
  running: boolean;
  tokens: number;
  pendingGates: Array<{ id: number; kind: Gate['kind']; subject: string | null }>;
}

export interface Run {
  id: number;
  role: string;
  step: string;
  model: string;
  effort: string | null;
  status: string;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  durationMs: number | null;
  startedAt: number;
}

export interface OfficeEvent {
  id: number;
  taskId: number | null;
  runId: number | null;
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

export interface TaskDetail {
  task: Task;
  repo: { id: number; name: string; defaultBranch: string };
  runs: Run[];
  gates: Gate[];
  docs: Array<{ file: string; name: string; version: number }>;
  alerts: OfficeEvent[];
}

export interface Repo {
  id: number;
  name: string;
  path: string;
  defaultBranch: string;
  protectedBranches: string[];
  setupCmd: string | null;
  buildCmd: string | null;
  testCmd: string | null;
  lintCmd: string | null;
  testGlobs: string[];
  ghAccount: string | null;
  gitAuthor: string | null;
  allowlist: string[];
  effectiveAllowlist: string[];
}

export interface Settings {
  autoApprovePush: boolean;
  concurrency: number;
  rateLimit: { fiveHour?: number; sevenDay?: number; resetsAt?: number; at: number } | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-office': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  tasks: () => request<Task[]>('GET', '/api/tasks'),
  task: (id: number) => request<TaskDetail>('GET', `/api/tasks/${id}`),
  createTask: (body: { repoId: number; input: string; kind?: 'feature' | 'bug' }) => request<Task>('POST', '/api/tasks', body),
  doc: (id: number, file: string) => request<string>('GET', `/api/tasks/${id}/docs/${file}`),
  diff: (id: number) => request<string>('GET', `/api/tasks/${id}/diff`),
  events: (id: number, after = 0) => request<OfficeEvent[]>('GET', `/api/tasks/${id}/events?after=${after}&limit=2000`),
  decide: (gateId: number, decision: string, comment?: string) => request('POST', `/api/gates/${gateId}`, { decision, comment }),
  action: (id: number, action: 'stop' | 'resume' | 'discard' | 'done' | 'takeover') =>
    request('POST', `/api/tasks/${id}/actions`, { action }),
  repos: () => request<Repo[]>('GET', '/api/repos'),
  saveRepo: (repo: Partial<Repo>, id?: number) => request<Repo>(id ? 'PUT' : 'POST', id ? `/api/repos/${id}` : '/api/repos', repo),
  deleteRepo: (id: number) => request('DELETE', `/api/repos/${id}`),
  ghAccounts: () => request<string[]>('GET', '/api/gh-accounts'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/api/settings', s),
};

export type LiveMessage = { type: 'task'; task: Task } | { type: 'event'; event: OfficeEvent };

/** Reconnecting WebSocket to the server's live feed. */
export function connectLive(onMessage: (m: LiveMessage) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: number | undefined;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => onState(true);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data as string) as LiveMessage);
    ws.onclose = () => {
      onState(false);
      if (!closed) retry = window.setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    ws?.close();
  };
}
