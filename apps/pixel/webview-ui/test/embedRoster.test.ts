import { describe, expect, it } from 'vitest';

import {
  buildRoster,
  characterName,
  embedParentOrigin,
  type RosterCharacter,
  type RosterInput,
  stackTags,
  tagWidth,
} from '../src/embedRoster.js';

const character = (over: Partial<RosterCharacter> = {}): RosterCharacter => ({
  isActive: false,
  bubbleType: null,
  isSubagent: false,
  ...over,
});

describe('embedParentOrigin', () => {
  it('accepts only a page on this machine', () => {
    expect(embedParentOrigin('?embed&parent=http%3A%2F%2F127.0.0.1%3A4100')).toBe(
      'http://127.0.0.1:4100',
    );
    expect(embedParentOrigin('?embed&parent=http://localhost:5173/some/path')).toBe(
      'http://localhost:5173',
    );
    expect(embedParentOrigin('?embed')).toBeNull();
    expect(embedParentOrigin('?embed&parent=https://evil.example')).toBeNull();
    expect(embedParentOrigin('?embed&parent=http://127.0.0.1.evil.example')).toBeNull();
    expect(embedParentOrigin('?embed&parent=javascript:alert(1)')).toBeNull();
    expect(embedParentOrigin('?embed&parent=not a url')).toBeNull();
  });
});

describe('characterName', () => {
  const residents = new Map([['coder', 7]]);

  it('prefers the resident role, then the team role, then the folder', () => {
    expect(characterName(7, character({ isResident: true, folderName: 'x' }), residents)).toBe(
      'coder',
    );
    expect(characterName(1, character({ agentName: 'qa', folderName: 'x' }), residents)).toBe('qa');
    expect(characterName(1, character({ isTeamLead: true }), residents)).toBe('lead');
    expect(characterName(1, character({ folderName: 'galaxy' }), residents)).toBe('galaxy');
    expect(characterName(1, character(), residents)).toBe('agent');
  });

  it('names a transient sub-agent after its type', () => {
    const sub = {
      id: 9,
      parentAgentId: 1,
      parentToolId: 't',
      label: 'Subtask: [reviewer] Quick review',
    };
    expect(characterName(9, character({ isSubagent: true }), residents, sub)).toBe('reviewer');
    expect(
      characterName(9, character({ isSubagent: true }), residents, {
        ...sub,
        label: 'Look around',
      }),
    ).toBe('subtask');
  });
});

describe('buildRoster', () => {
  const base = (over: Partial<RosterInput> = {}): RosterInput => ({
    characters: new Map(),
    residentIds: new Map(),
    agents: [],
    agentTools: {},
    subagentCharacters: [],
    subagentTools: {},
    ...over,
  });

  it('leaves out residents at rest and lists a resident doing a sub-agent job', () => {
    const roster = buildRoster(
      base({
        characters: new Map([
          [1, character({ isActive: true })],
          [5, character({ isResident: true })],
          [6, character({ isResident: true, isActive: true })],
        ]),
        residentIds: new Map([
          ['tester', 5],
          ['coder', 6],
        ]),
        agents: [1],
        subagentCharacters: [
          { id: 6, parentAgentId: 1, parentToolId: 'tool-a', label: '#3 Add variants' },
        ],
        subagentTools: {
          1: { 'tool-a': [{ toolId: 'x', status: 'Running: npm test', done: false }] },
        },
      }),
    );
    expect(roster).toEqual([
      { id: 1, name: 'agent', kind: 'agent', state: 'working' },
      {
        id: 6,
        name: 'coder',
        kind: 'resident',
        state: 'working',
        task: '#3 Add variants',
        activity: 'Running: npm test',
      },
    ]);
  });

  it('reports approval and waiting ahead of working, and no activity for an idle session', () => {
    const roster = buildRoster(
      base({
        characters: new Map([
          [1, character({ isActive: true, bubbleType: 'permission', folderName: 'a' })],
          [2, character({ bubbleType: 'waiting', waitingAwaitingInput: true, folderName: 'b' })],
          [3, character({ folderName: 'c' })],
          [4, character({ isActive: true, folderName: 'd' })],
        ]),
        agents: [4, 3, 2, 1],
        agentTools: {
          3: [{ toolId: 'old', status: 'Reading file', done: true }],
          4: [{ toolId: 'p', status: 'Running: rm', done: false, permissionWait: true }],
        },
      }),
    );
    expect(roster.map((r) => [r.name, r.state, r.activity])).toEqual([
      ['a', 'approval', undefined],
      ['b', 'waiting', undefined],
      ['c', 'idle', undefined],
      ['d', 'approval', 'Running: rm'],
    ]);
  });
});

describe('stackTags', () => {
  const tag = (id: number, x: number, y: number, width = 60, height = 20) => ({
    id,
    x,
    y,
    width,
    height,
  });

  it('leaves tags that do not touch where they are', () => {
    const out = stackTags([tag(1, 100, 100), tag(2, 300, 100), tag(3, 100, 200)]);
    expect([...out]).toEqual([
      [1, 100],
      [2, 100],
      [3, 200],
    ]);
  });

  it('lifts the later tag clear of the earlier one, and a third clear of both', () => {
    const out = stackTags([tag(2, 110, 104), tag(1, 100, 100), tag(3, 105, 102)]);
    expect(out.get(1)).toBe(100); // lowest id keeps its place
    expect(out.get(2)).toBe(78); // above tag 1 (top 80) with the 2px gap
    expect(out.get(3)).toBe(56); // above tag 2 (top 58)
  });

  it('never leaves two tags overlapping', () => {
    const tags = Array.from({ length: 12 }, (_, i) =>
      tag(i, 100 + (i % 4) * 25, 100 + (i % 3) * 9),
    );
    const out = stackTags(tags);
    const boxes = tags.map((t) => ({
      left: t.x - 30,
      right: t.x + 30,
      bottom: out.get(t.id)!,
      top: out.get(t.id)! - 20,
    }));
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const overlap =
          boxes[a]!.left < boxes[b]!.right &&
          boxes[a]!.right > boxes[b]!.left &&
          boxes[a]!.top < boxes[b]!.bottom &&
          boxes[a]!.bottom > boxes[b]!.top;
        expect(overlap).toBe(false);
      }
    }
  });

  it('sizes a tag from its name', () => {
    expect(tagWidth('coder')).toBeGreaterThan(tagWidth('qa'));
  });
});
