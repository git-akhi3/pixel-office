/**
 * Resident agents (layout.residents): always-present characters that idle inside
 * their area and are animated by sub-agents of the same type instead of a
 * transient Subtask character.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { AREA_DEFAULT_COLORS } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { parseSubtaskStatus } from '../src/office/toolUtils.js';
import type { OfficeLayout, ResidentDefinition } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

/** All-floor layout split into two areas: "Dev" (left half) and "QA" (right half). */
function twoRoomLayout(residents: ResidentDefinition[], cols = 10, rows = 6): OfficeLayout {
  const areaTiles: Array<string | null> = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) areaTiles.push(c < cols / 2 ? 'Dev' : 'QA');
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
    areas: [
      { label: 'Dev', color: AREA_DEFAULT_COLORS[0] },
      { label: 'QA', color: AREA_DEFAULT_COLORS[1] },
    ],
    areaTiles,
    residents,
  };
}

const TEAM: ResidentDefinition[] = [
  { name: 'coder', area: 'Dev' },
  { name: 'tester', area: 'QA' },
];

test('parses the sub-agent type out of the Subtask status', () => {
  assert.deepEqual(parseSubtaskStatus('Subtask: [tester] Run the suite'), {
    agentType: 'tester',
    label: 'Run the suite',
  });
  assert.deepEqual(parseSubtaskStatus('Subtask: [tester]'), {
    agentType: 'tester',
    label: 'tester',
  });
  assert.deepEqual(parseSubtaskStatus('Subtask: tester'), { agentType: 'tester', label: 'tester' });
  assert.deepEqual(parseSubtaskStatus('Subtask: Fix the login bug'), {
    agentType: 'Fix the login bug',
    label: 'Fix the login bug',
  });
});

test('creates one idle, named character per resident', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  assert.equal(os.residentIds.size, 2);
  for (const def of TEAM) {
    const ch = os.characters.get(os.residentIds.get(def.name)!);
    assert.ok(ch, `${def.name} exists`);
    assert.equal(ch.isResident, true);
    assert.equal(ch.isActive, false, 'residents start idle');
    assert.equal(ch.agentName, def.name, 'name shows in the overlay');
    assert.equal(ch.residentArea, def.area);
    assert.ok(ch.id <= -1_000_000, 'resident ids never collide with sub-agent ids');
  }
});

test('idle residents wander only inside their own area', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  const tester = os.characters.get(os.residentIds.get('tester')!)!;
  for (let i = 0; i < 2000; i++) {
    os.update(0.1);
    if (tester.matrixEffect) continue;
    assert.ok(tester.tileCol >= 5, `tester stayed in QA (col ${tester.tileCol})`);
  }
});

test('a sub-agent of a resident type animates the resident, and finishing returns it to idle', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  const testerId = os.residentIds.get('tester')!;
  const before = os.characters.size;

  const subId = os.addSubagent(1, 'toolu_1', 'tester');
  assert.equal(subId, testerId, 'the resident takes the job');
  assert.equal(os.characters.size, before, 'no transient character is spawned');
  assert.equal(os.characters.get(testerId)!.isActive, true);
  assert.equal(os.getSubagentId(1, 'toolu_1'), testerId, 'sub-agent tools route to the resident');

  os.removeSubagent(1, 'toolu_1');
  const tester = os.characters.get(testerId)!;
  assert.ok(tester, 'the resident never despawns');
  assert.notEqual(tester.matrixEffect, 'despawn');
  assert.equal(tester.isActive, false, 'back to idle');
  assert.equal(os.getSubagentId(1, 'toolu_1'), null);
});

test('a busy resident or an unknown type falls back to a normal sub-agent', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  const testerId = os.residentIds.get('tester')!;
  os.addSubagent(1, 'toolu_1', 'tester');

  const second = os.addSubagent(1, 'toolu_2', 'tester');
  assert.notEqual(second, testerId, 'second parallel tester gets its own character');
  assert.equal(os.characters.get(second)!.isSubagent, true);

  const other = os.addSubagent(1, 'toolu_3', 'general-purpose');
  assert.equal(os.characters.get(other)!.isResident, undefined);
});

test('closing the parent agent releases its residents without despawning them', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  const coderId = os.residentIds.get('coder')!;
  os.addSubagent(7, 'toolu_9', 'coder');
  os.removeAllSubagents(7);
  const coder = os.characters.get(coderId)!;
  assert.notEqual(coder.matrixEffect, 'despawn');
  assert.equal(coder.isActive, false);
});

test('residents follow layout edits: removed from the roster, they leave', () => {
  const os = new OfficeState(twoRoomLayout(TEAM));
  const coderId = os.residentIds.get('coder')!;
  os.rebuildFromLayout(twoRoomLayout([{ name: 'tester', area: 'QA' }]));
  assert.equal(os.residentIds.has('coder'), false);
  assert.equal(os.characters.get(coderId)!.matrixEffect, 'despawn');
  assert.equal(os.residentIds.size, 1);
});
