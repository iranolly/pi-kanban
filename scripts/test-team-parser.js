#!/usr/bin/env node
'use strict';

// Unit + real-data checks for pi-agents-team parsing in lib/pi-parsers.js.
// Run: node scripts/test-team-parser.js  (or: npm run test:team-parser)

const parsers = require('../lib/pi-parsers');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

function fail(message) {
  throw new Error(message);
}

function expect(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ts(ms) {
  return new Date(ms).toISOString();
}

let callSeq = 0;

function delegate(workerId, opts = {}) {
  const {
    status = 'running',
    startedAt = 1000,
    lastEventAt = 1500,
    task = { taskId: 't1', title: 'Task 1', goal: 'Goal 1', pathScope: { roots: ['C:/x'] } },
    relay = [],
    usage = { turns: 1, inputTokens: 2, outputTokens: 3 },
  } = opts;
  return {
    type: 'message',
    timestamp: ts(lastEventAt),
    message: {
      role: 'toolResult',
      toolCallId: `call_${++callSeq}`,
      toolName: 'delegate_task',
      content: [{ type: 'text', text: `${workerId} started` }],
      details: {
        worker: {
          workerId,
          profileName: 'fixer',
          status,
          startedAt,
          lastEventAt,
          currentTask: task,
          pendingRelayQuestions: relay,
          usage,
        },
      },
    },
  };
}

function terminal(workerId, opts = {}) {
  const {
    status = 'idle',
    startedAt = 1000,
    lastEventAt = 2000,
    summary = { headline: 'done', readFiles: ['C:/read'], changedFiles: ['C:/changed'], risks: ['risk'], nextRecommendation: 'next' },
    usage = { turns: 2, inputTokens: 5, outputTokens: 6, contextTokens: 100 },
  } = opts;
  return {
    type: 'custom',
    customType: 'pi-agent-team/state',
    timestamp: ts(lastEventAt),
    data: {
      version: 2,
      kind: 'worker_terminal',
      worker: { workerId, profileName: 'fixer', status, startedAt, lastEventAt, lastSummary: summary, usage },
    },
  };
}

function pruned(workerId, opts = {}) {
  const { lastEventAt = 2500, usage = { turns: 2 } } = opts;
  return {
    type: 'custom',
    customType: 'pi-agent-team/state',
    timestamp: ts(lastEventAt),
    data: { version: 2, kind: 'worker_pruned', workerId, lastEventAt, usage },
  };
}

function agentResultToolCall(workerId, callId) {
  return {
    type: 'message',
    timestamp: ts(1200),
    message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'agent_result', arguments: { workerId } }] },
  };
}

function agentResult(workerId, callId, text, opts = {}) {
  const details = opts.detailsWorker
    ? { worker: { workerId, profileName: 'fixer', status: 'idle', startedAt: 1000, lastEventAt: 2100 } }
    : undefined;
  return {
    type: 'message',
    timestamp: ts(2100),
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'agent_result',
      content: [{ type: 'text', text }],
      details,
    },
  };
}

function recordFor(entries, workerId) {
  const summary = parsers.summarize(entries);
  return (summary.teamAgents || []).find((r) => r.workerId === workerId) || null;
}

function apiFor(entries, workerId, opts = {}) {
  const rec = recordFor(entries, workerId);
  return rec ? parsers.teamAgentToApi(rec, opts) : null;
}

// 1. terminal newer than snapshot -> stopped
check('terminal newer than snapshot -> stopped', () => {
  const rec = apiFor([delegate('w1'), terminal('w1', { lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec.stoppedAt, ts(2000), 'stoppedAt');
  expect(rec.startedAt, ts(1000), 'startedAt');
});

// 2. snapshot newer than terminal -> active (worker reuse)
check('snapshot newer than terminal -> active', () => {
  const rec = apiFor([terminal('w1', { lastEventAt: 1500 }), delegate('w1', { lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'active', 'status');
  expect(rec.stoppedAt, null, 'stoppedAt');
  expect(rec.updatedAt, ts(2000), 'updatedAt');
  expect(rec._teamStatus, 'running', '_teamStatus');
});

// 3. aborted -> cancelled
check('aborted -> cancelled', () => {
  const rec = apiFor([terminal('w1', { status: 'aborted', lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'cancelled', 'status');
  expect(rec.cancelled, true, 'cancelled');
});

// 4. pruned -> stopped + _pruned, stoppedAt stays at the snapshot time (P3)
check('pruned -> stopped + _pruned, keeps pre-prune timestamp', () => {
  const rec = apiFor([delegate('w1', { lastEventAt: 1500 }), pruned('w1', { lastEventAt: 1900 })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec._pruned, true, '_pruned');
  expect(rec._teamStatus, 'pruned', '_teamStatus');
  expect(rec.stoppedAt, ts(1500), 'stoppedAt must not move to prune time');
});

// 5. pruned then a newer terminal recovers the worker
check('pruned then newer terminal -> recovers (not pruned)', () => {
  const rec = apiFor([delegate('w1', { lastEventAt: 1500 }), pruned('w1', { lastEventAt: 1800 }), terminal('w1', { status: 'idle', lastEventAt: 2500 })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec._pruned, false, '_pruned');
  expect(rec.updatedAt, ts(2500), 'updatedAt');
});

// 5b. prune-only (no snapshot/terminal) must not fall back to 1970
check('prune-only timestamp is not 1970', () => {
  const rec = apiFor([pruned('w1', { lastEventAt: 1900, usage: { turns: 3 } })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec._pruned, true, '_pruned');
  expect(rec.updatedAt, ts(1900), 'updatedAt');
  expect(rec.stoppedAt, ts(1900), 'stoppedAt');
  expect(rec.startedAt, null, 'startedAt');
});

// 5c. stale prune (earlier than a newer snapshot) must not stop the worker
check('stale prune before newer running snapshot -> stays active', () => {
  const rec = apiFor([pruned('w1', { lastEventAt: 1200 }), delegate('w1', { status: 'running', startedAt: 1000, lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'active', 'status');
  expect(rec.stoppedAt, null, 'stoppedAt');
  expect(rec._pruned, false, '_pruned');
});

check('stale prune after newer running snapshot -> stays active', () => {
  const rec = apiFor([delegate('w1', { status: 'running', startedAt: 1000, lastEventAt: 2000 }), pruned('w1', { lastEventAt: 1200 })], 'w1');
  expect(rec.status, 'active', 'status');
  expect(rec.stoppedAt, null, 'stoppedAt');
  expect(rec._pruned, false, '_pruned');
});

// 6. waiting_followup -> active
check('waiting_followup -> active', () => {
  const rec = apiFor([delegate('w1', { status: 'waiting_followup', lastEventAt: 1600, relay: [{ id: 'q1' }, { id: 'q2' }] })], 'w1');
  expect(rec.status, 'active', 'status');
  expect(rec.stoppedAt, null, 'stoppedAt');
  expect(rec._relayQuestions, 2, '_relayQuestions');
});

// 7. starting -> active
check('starting -> active', () => {
  const rec = apiFor([delegate('w1', { status: 'starting', lastEventAt: 1100 })], 'w1');
  expect(rec.status, 'active', 'status');
  expect(rec.stoppedAt, null, 'stoppedAt');
});

// 8-10. error / idle / exited terminal -> stopped
check('error terminal -> stopped', () => {
  const rec = apiFor([terminal('w1', { status: 'error', lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec.stoppedAt, ts(2000), 'stoppedAt');
});

check('idle terminal -> stopped', () => {
  const rec = apiFor([terminal('w1', { status: 'idle', lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'stopped', 'status');
});

check('exited terminal -> stopped', () => {
  const rec = apiFor([terminal('w1', { status: 'exited', lastEventAt: 2000 })], 'w1');
  expect(rec.status, 'stopped', 'status');
});

// 11. finalAnswer associated via assistant toolCall args.workerId
check('finalAnswer via agent_result toolCall mapping', () => {
  const entries = [delegate('w1'), terminal('w1', { lastEventAt: 2000 }), agentResultToolCall('w1', 'c1'), agentResult('w1', 'c1', 'FINAL-A')];
  const full = apiFor(entries, 'w1', { includeFinalAnswer: true });
  expect(full._finalAnswer, 'FINAL-A', '_finalAnswer');
  const slim = apiFor(entries, 'w1');
  expect(Object.prototype.hasOwnProperty.call(slim, '_finalAnswer'), false, 'list payload omits _finalAnswer');
  expect(Object.prototype.hasOwnProperty.call(slim, '_readFiles'), false, 'list payload omits duplicate _readFiles');
  expect(Object.prototype.hasOwnProperty.call(slim, '_nextRecommendation'), false, 'list payload omits duplicate _nextRecommendation');
  expect(slim._summary.readFiles.length, 1, '_summary.readFiles kept');
});

// 12. finalAnswer fallback via toolResult details.worker.workerId (no toolCall mapping)
check('finalAnswer via details.worker fallback', () => {
  const entries = [delegate('w1'), agentResult('w1', 'missing-call-id', 'FINAL-B', { detailsWorker: true })];
  const full = apiFor(entries, 'w1', { includeFinalAnswer: true });
  expect(full._finalAnswer, 'FINAL-B', '_finalAnswer');
});

// 13. empty input is safe
check('empty input -> [] teamAgents', () => {
  const summary = parsers.summarize([]);
  if (!Array.isArray(summary.teamAgents) || summary.teamAgents.length !== 0) fail('teamAgents should be empty');
  if (!Array.isArray(summary.subagents) || summary.subagents.length !== 0) fail('subagents should be empty');
});

// 14. later terminal wins over an earlier terminal
check('later terminal wins over earlier terminal', () => {
  const rec = apiFor([terminal('w1', { status: 'idle', lastEventAt: 2000 }), terminal('w1', { status: 'exited', lastEventAt: 3000 })], 'w1');
  expect(rec.status, 'stopped', 'status');
  expect(rec._teamStatus, 'exited', '_teamStatus');
  expect(rec.updatedAt, ts(3000), 'updatedAt');
});

// Real-data assertion: (sessionId, agentId) pairs are unique for every session.
async function realDataCheck() {
  const started = Date.now();
  const files = await parsers.listSessionFiles();
  let teamCount = 0;
  const keys = new Set();
  const idOnly = new Set();
  for (const meta of files) {
    const sessionId = parsers.slugFromFile(meta.file);
    let agents;
    try {
      agents = await parsers.listAgentsForSession(meta);
    } catch {
      continue;
    }
    for (const a of agents) {
      if (!a || !a.agentId) continue;
      teamCount++;
      keys.add(`${sessionId}|${a.agentId}`);
      idOnly.add(a.agentId);
    }
  }
  check('real data: (sessionId, agentId) pairs unique across sessions', () => {
    expect(keys.size, teamCount, 'unique (sessionId|agentId)');
  });
  console.log(
    `      sessions=${files.length} agents=${teamCount} unique(sessionId|agentId)=${keys.size} unique(agentId)=${idOnly.size} elapsed=${Date.now() - started}ms`
  );
}

async function main() {
  await realDataCheck();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
