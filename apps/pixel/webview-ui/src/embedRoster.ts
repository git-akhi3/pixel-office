/**
 * Embedded view (`?embed`): who is on duty, for the page that shows the office in an iframe.
 *
 * In a busy office a label bar over every working character overlaps its neighbours. So the
 * embedded view puts only a small name tag over each one (stacked apart when they would collide)
 * and reports what each is doing to the embedding page, which lists it beside the office.
 *
 * Free of DOM access, like projection.ts: App reads the environment and posts the messages.
 */

import type { ToolActivity } from './office/types.js';

/** Messages to the embedding page carry this `source`; messages from it carry {@link BOARD_SOURCE}. */
export const EMBED_SOURCE = 'pixel-agents-embed';
export const BOARD_SOURCE = 'pixel-office-board';

/**
 * The embedding page's origin from `?parent=`, used as the postMessage target. Only a page on this
 * machine is accepted: the roster includes the commands agents run, and the browser delivers a
 * message only to a window that really has the target origin.
 */
export function embedParentOrigin(search: string): string | null {
  const raw = new URLSearchParams(search).get('parent');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]')
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The part of a character the roster and the name tags read. */
export interface RosterCharacter {
  isActive: boolean;
  bubbleType: 'permission' | 'waiting' | null;
  waitingAwaitingInput?: boolean;
  isSubagent: boolean;
  isResident?: boolean;
  folderName?: string;
  agentName?: string;
  isTeamLead?: boolean;
}

export interface RosterSub {
  id: number;
  parentAgentId: number;
  parentToolId: string;
  label: string;
}

export interface RosterInput {
  characters: ReadonlyMap<number, RosterCharacter>;
  /** Resident name (the sub-agent type it stands for) to character id. */
  residentIds: ReadonlyMap<string, number>;
  agents: readonly number[];
  agentTools: Readonly<Record<number, ToolActivity[]>>;
  subagentCharacters: readonly RosterSub[];
  subagentTools: Readonly<Record<number, Record<string, ToolActivity[]>>>;
}

export interface RosterEntry {
  id: number;
  name: string;
  kind: 'resident' | 'agent' | 'sub';
  state: 'working' | 'approval' | 'waiting' | 'idle';
  /** What it is working on (a sub-agent's task title). */
  task?: string;
  /** What it is doing right now (the running tool). */
  activity?: string;
}

/** A short name for a character's tag: the resident's role, the team role, or the session's folder. */
export function characterName(
  id: number,
  ch: RosterCharacter,
  residentIds: ReadonlyMap<string, number>,
  sub?: RosterSub,
): string {
  for (const [name, rid] of residentIds) if (rid === id) return name;
  if (ch.isTeamLead) return 'lead';
  if (ch.agentName) return ch.agentName;
  if (sub) return subagentType(sub.label) ?? 'subtask';
  return ch.folderName || 'agent';
}

/** "Subtask: [reviewer] Quick review" names its sub-agent type in brackets. */
function subagentType(label: string): string | null {
  return /\[([^\]]{1,24})\]/.exec(label)?.[1] ?? null;
}

function runningTool(
  tools: ToolActivity[] | undefined,
  isActive: boolean,
): ToolActivity | undefined {
  if (!tools || tools.length === 0) return undefined;
  const active = [...tools].reverse().find((t) => !t.done);
  // All tools done but still mid-turn: the last one is the freshest thing to show.
  return active ?? (isActive ? tools[tools.length - 1] : undefined);
}

/** Everyone but residents at rest: working characters and open sessions (idle ones too), by id. */
export function buildRoster(input: RosterInput): RosterEntry[] {
  const { characters, residentIds, agents, agentTools, subagentCharacters, subagentTools } = input;
  const ids = [...agents, ...subagentCharacters.map((s) => s.id)];
  for (const rid of residentIds.values()) if (!ids.includes(rid)) ids.push(rid);

  const roster: RosterEntry[] = [];
  for (const id of new Set(ids)) {
    const ch = characters.get(id);
    if (!ch) continue;
    const sub = subagentCharacters.find((s) => s.id === id);
    const isSub = ch.isSubagent || (!!ch.isResident && !!sub);
    // A resident with no sub-agent job is part of the furniture.
    if (ch.isResident && !isSub) continue;

    const tool = sub
      ? runningTool(subagentTools[sub.parentAgentId]?.[sub.parentToolId], ch.isActive)
      : runningTool(agentTools[id], ch.isActive);
    const state: RosterEntry['state'] =
      ch.bubbleType === 'permission' || (tool?.permissionWait && !tool.done)
        ? 'approval'
        : ch.bubbleType === 'waiting' && ch.waitingAwaitingInput
          ? 'waiting'
          : ch.isActive
            ? 'working'
            : 'idle';

    const entry: RosterEntry = {
      id,
      name: characterName(id, ch, residentIds, sub),
      kind: ch.isResident ? 'resident' : isSub ? 'sub' : 'agent',
      state,
    };
    if (sub?.label) entry.task = sub.label;
    if (tool && state !== 'idle') entry.activity = tool.status;
    roster.push(entry);
  }
  return roster.sort((a, b) => a.id - b.id);
}

// ── Name tags ────────────────────────────────────────────────────────────────

/** A tag anchored above a character: `x` is its centre, `y` its bottom edge (CSS px). */
export interface TagBox {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rough on-screen width of a name tag, before any label scaling: text, status dot, padding. */
export function tagWidth(name: string): number {
  return name.length * 8 + 30;
}

/**
 * Moves tags that would overlap apart, upward. Returns each tag's bottom edge.
 *
 * Tags are placed in id order, so while characters walk around each other only the later one
 * steps aside; two tags never swap who yields. (A tag that leaves the set, e.g. when its character
 * is hovered, still lets the ones above it settle back down.)
 */
export function stackTags(tags: readonly TagBox[], gap = 2): Map<number, number> {
  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const result = new Map<number, number>();
  for (const tag of [...tags].sort((a, b) => a.id - b.id)) {
    const left = tag.x - tag.width / 2;
    const right = tag.x + tag.width / 2;
    let bottom = tag.y;
    // Each move clears one placed tag, so this settles within placed.length passes.
    for (let pass = 0; pass <= placed.length; pass++) {
      const hit = placed.find(
        (p) =>
          left < p.right + gap &&
          right > p.left - gap &&
          bottom - tag.height < p.bottom + gap &&
          bottom > p.top - gap,
      );
      if (!hit) break;
      bottom = hit.top - gap;
    }
    placed.push({ left, right, top: bottom - tag.height, bottom });
    result.set(tag.id, bottom);
  }
  return result;
}
