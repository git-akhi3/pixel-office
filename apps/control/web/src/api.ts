// Typed client for the control API. Types mirror server/src/db/schema.ts.

export type TaskStatus = string;

export interface Gate {
  id: number;
  taskId: number;
  kind: 'plan' | 'push' | 'command' | 'review_post' | 'question' | 'breakdown';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  subject: string | null;
  decision: string | null;
  comment: string | null;
  auto: boolean;
  createdAt: number;
  decidedAt: number | null;
}

export interface ReviewComment {
  id: number;
  taskId: number;
  path: string;
  line: number;
  severity: 'blocking' | 'suggestion' | 'nit';
  body: string;
  deleted: boolean;
}

export type Role = 'manager' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'debugger' | 'researcher';
/** Roles a mission can pick skills for. */
export const PICKABLE_ROLES: Role[] = ['architect', 'coder', 'reviewer', 'tester', 'debugger', 'researcher'];
export type SkillPicks = Partial<Record<Role, { skills: string[]; by: 'owner' | 'manager'; why?: string }>>;

export interface Task {
  id: number;
  repoId: number;
  title: string;
  input: string;
  kind: 'feature' | 'bug' | 'review';
  baseBranch: string | null;
  prNumber: number | null;
  prRepo: string | null;
  prAuthor: string | null;
  reviewSummary: string | null;
  reviewPostedUrl: string | null;
  size: 'S' | 'M' | 'L' | null;
  /** How much of the team the task gets; null on old tasks (standard). */
  lane: 'trivial' | 'small' | 'standard' | null;
  parentId: number | null;
  dependsOn: number | null;
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
  skillPicks: SkillPicks;
  grillMode: 'auto' | 'always' | 'never';
  grill: boolean;
  grillReason: string | null;
  attachments: Array<{ name: string; size: number; type: string }>;
  links: string[];
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

export interface Question {
  id: number;
  taskId: number;
  gateId: number | null;
  round: number;
  idx: number;
  title: string;
  body: string;
  options: string[];
  recommended: string | null;
  answer: string | null;
  answeredVia: 'board' | 'slack' | null;
  delegated: boolean;
  answeredAt: number | null;
}

export interface TaskDetail {
  task: Task;
  repo: { id: number; name: string; defaultBranch: string };
  runs: Run[];
  gates: Gate[];
  docs: Array<{ file: string; name: string; version: number }>;
  alerts: OfficeEvent[];
  reviewComments: ReviewComment[];
  questions: Question[];
  /** Epics: the milestone tasks it was split into. Milestones: their epic. */
  milestones: Array<{ id: number; title: string; status: TaskStatus; dependsOn: number | null }>;
  parent: { id: number; title: string; status: TaskStatus } | null;
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
  skills: Record<string, string[]>;
  graphify: boolean;
}

export interface AgentInfo {
  role: string;
  custom: boolean;
  text: string;
  model: string;
  effort?: string;
  tools: string[];
  skills: string[];
  description: string;
  /** Set when my custom file is invalid (the built-in agent is used meanwhile). */
  error?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  text: string;
  custom: boolean;
  builtIn: boolean;
  /** Only tells the agent to call other skills: does nothing in the office. */
  wrapper: boolean;
  importedFrom: string | null;
  updateAvailable: boolean;
}

export interface ImportableSkill {
  key: string;
  name: string;
  description: string;
  source: string;
  path: string;
  extraFiles: number;
  wrapper: boolean;
  status: 'new' | 'imported' | 'update' | 'taken';
}

export interface Proposal {
  id: number;
  repoId: number;
  taskId: number | null;
  text: string;
  status: string;
  createdAt: number;
}

export interface GraphInfo {
  installed: boolean;
  version: string | null;
  pinned: string;
  install: string;
  repos: Array<{
    repoId: number;
    enabled: boolean;
    builtAt: number | null;
    building: boolean;
    withGraph: { runs: number; avg: number };
    without: { runs: number; avg: number };
  }>;
}

export interface Settings {
  autoApprovePush: boolean;
  concurrency: number;
  reviewAutoPickup: boolean;
  reviewMinLines: number;
  rateLimit: { fiveHour?: number; sevenDay?: number; resetsAt?: number; at: number } | null;
  usagePauseAt: number;
  grillSkill: string;
  sonnetForSmall: boolean;
  usage?: { paused: boolean; until: number | null; window: string | null };
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
  createTask: (body: {
    repoId: number;
    input: string;
    kind?: 'feature' | 'bug';
    skills?: Partial<Record<Role, string[]>>;
    grillMode?: Task['grillMode'];
    attachments?: string[];
    links?: string[];
  }) => request<Task>('POST', '/api/tasks', body),
  /** Uploads one file for a mission; the returned id goes into createTask's attachments. */
  upload: async (file: File): Promise<Upload> => {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'x-office': '1', 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = (await res.json().catch(() => ({}))) as Upload & { error?: string; message?: string };
    if (!res.ok) throw new Error(data.error === 'Payload Too Large' || res.status === 413 ? `${file.name} is over 10 MB.` : (data.error ?? `HTTP ${res.status}`));
    return data;
  },
  setTaskSkills: (id: number, role: Role, skills: string[]) => request<Task>('PUT', `/api/tasks/${id}/skills`, { role, skills }),
  answerQuestion: (id: number, answer: { answer?: string; delegate?: boolean }) => request<Question>('POST', `/api/questions/${id}`, answer),
  briefing: (taskId: number, action: 'send' | 'enough') => request('POST', `/api/tasks/${taskId}/briefing`, { action }),
  doc: (id: number, file: string) => request<string>('GET', `/api/tasks/${id}/docs/${file}`),
  diff: (id: number) => request<string>('GET', `/api/tasks/${id}/diff`),
  events: (id: number, after = 0) => request<OfficeEvent[]>('GET', `/api/tasks/${id}/events?after=${after}&limit=2000`),
  decide: (gateId: number, decision: string, comment?: string) => request('POST', `/api/gates/${gateId}`, { decision, comment }),
  action: (id: number, action: 'stop' | 'resume' | 'discard' | 'done' | 'takeover') =>
    request('POST', `/api/tasks/${id}/actions`, { action }),
  steer: (id: number, text: string) => request<{ delivered: 'live' | 'next_step' }>('POST', `/api/tasks/${id}/steer`, { text }),
  replan: (id: number, reason: string) => request<Task>('POST', `/api/tasks/${id}/replan`, { reason }),
  createReview: (prUrl: string) => request<Task>('POST', '/api/reviews', { prUrl }),
  pickupReviews: () => request<{ created: number }>('POST', '/api/reviews/pickup', {}),
  editComment: (id: number, patch: { body?: string; deleted?: boolean }) => request<ReviewComment>('PUT', `/api/review-comments/${id}`, patch),
  editSummary: (id: number, summary: string) => request<Task>('PUT', `/api/tasks/${id}/review-summary`, { summary }),
  fixIt: (id: number) => request<Task>('POST', `/api/tasks/${id}/fix-it`, {}),
  agents: () => request<AgentInfo[]>('GET', '/api/agents'),
  saveAgent: (role: string, text: string) => request('PUT', `/api/agents/${role}`, { text }),
  resetAgent: (role: string) => request('DELETE', `/api/agents/${role}`),
  skills: () => request<SkillInfo[]>('GET', '/api/skills'),
  saveSkill: (name: string, text: string) => request('PUT', `/api/skills/${name}`, { text }),
  deleteSkill: (name: string) => request('DELETE', `/api/skills/${name}`),
  installSkillGlobally: (name: string) => request<{ path: string }>('POST', `/api/skills/${name}/install-global`, {}),
  importableSkills: () => request<ImportableSkill[]>('GET', '/api/skills/importable'),
  importDiff: (key: string) => request<{ name: string; current: string; incoming: string }>('GET', `/api/skills/importable/${key}`),
  importSkill: (key: string) => request<{ name: string }>('POST', '/api/skills/import', { key }),
  knowledge: (repoId: number) => request<{ text: string; maxLines: number; proposals: Proposal[] }>('GET', `/api/repos/${repoId}/knowledge`),
  saveKnowledge: (repoId: number, text: string) => request('PUT', `/api/repos/${repoId}/knowledge`, { text }),
  proposals: () => request<Proposal[]>('GET', '/api/knowledge/proposals'),
  decideProposal: (id: number, decision: 'accept' | 'reject', text?: string) => request('POST', `/api/knowledge/proposals/${id}`, { decision, text }),
  graphify: () => request<GraphInfo>('GET', '/api/graphify'),
  buildGraph: (repoId: number) => request('POST', `/api/repos/${repoId}/graph`, {}),
  office: () =>
    request<{ running: boolean; url: string | null; linked: boolean; aspect: number | null; start: string }>('GET', '/api/office'),
  repos: () => request<Repo[]>('GET', '/api/repos'),
  saveRepo: (repo: Partial<Repo>, id?: number) => request<Repo>(id ? 'PUT' : 'POST', id ? `/api/repos/${id}` : '/api/repos', repo),
  deleteRepo: (id: number) => request('DELETE', `/api/repos/${id}`),
  ghAccounts: () => request<string[]>('GET', '/api/gh-accounts'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/api/settings', s),
};

export interface Upload {
  id: string;
  name: string;
  size: number;
  type: string;
}

export const ACCEPTED_FILES = '.md,.markdown,.txt,.log,.csv,.json,.yaml,.yml,.xml,.html,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg';
export const MAX_MISSION_BYTES = 25 * 1024 * 1024;

export function fileSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

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
