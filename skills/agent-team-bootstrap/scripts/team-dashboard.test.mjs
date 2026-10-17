import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTracker, createServer, parseEnvelope } from './team-dashboard.mjs';

const T = Date.now();
const iso = (offset = 0) => new Date(T - 5000 + offset).toISOString();
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  fs.mkdirSync(path.join(claudeDir, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, '2026', '10', '17'), { recursive: true });
  return {
    claudeDir, codexDir,
    claude: (name, text) => fs.writeFileSync(path.join(claudeDir, 'proj', name + '.jsonl'), text),
    codex: (name, text) => fs.writeFileSync(path.join(codexDir, '2026', '10', '17', `rollout-${name}.jsonl`), text),
    tracker: (project = 'wms') => createTracker({ project, claudeDir, codexDir, now: () => T }),
  };
}

const claudeSend = (sid, ts, id, message, to = 'leader') => ({
  type: 'assistant', sessionId: sid, cwd: '/w/' + sid, timestamp: iso(ts),
  message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message } }] },
});
const claudeResult = (sid, ts, id) => ({
  type: 'user', sessionId: sid, timestamp: iso(ts), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'sent' }] },
});

test('parseEnvelope reads compact and YAML forms', () => {
  assert.deepEqual(parseEnvelope('P:wms T:REVIEW_VERDICT ID:20 TO:leader STATUS:approved REF:PR#42'),
    { project: 'wms', type: 'REVIEW_VERDICT', id: '20', to: 'leader', from: undefined, re: undefined, status: 'approved', ref: 'PR#42' });
  const y = parseEnvelope('protocol: agent-team/native\nproject: wms\nmessage_id: b-3\nin_reply_to: null\ntype: JOIN_REQUEST\nfrom: backend-01\nto: leader-main');
  assert.equal(y.project, 'wms'); assert.equal(y.id, 'b-3'); assert.equal(y.re, undefined); assert.equal(y.from, 'backend-01');
  assert.equal(parseEnvelope('hello there'), null);
});

test('Claude: sender with a pending Bash call is a RUNNING Worker in JOINING', () => {
  const f = fixture();
  f.claude('s1', jl(
    claudeSend('s1', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:b1 FROM:backend-01'),
    claudeResult('s1', 100, 'u1'),
    { type: 'assistant', sessionId: 's1', timestamp: iso(200), message: { content: [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'npm test' } }] } },
  ));
  const st = f.tracker().state();
  assert.equal(st.sessions.length, 1);
  const s = st.sessions[0];
  assert.deepEqual([s.name, s.role, s.proto, s.exec, s.tool], ['backend-01', 'Worker', 'JOINING', 'RUNNING', 'Bash: npm test']);
  assert.equal(st.messages[0].type, 'JOIN_REQUEST');
});

test('Codex: tool call + output + task_complete is IDLE; send_message_to_thread envelope is recognised', () => {
  const f = fixture();
  f.codex('a', jl(
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'cx1', cwd: '/w/cx' } },
    { timestamp: iso(10), type: 'response_item', payload: { type: 'function_call', name: 'codex_app.send_message_to_thread', call_id: 'c1', arguments: JSON.stringify({ thread_id: 't9', prompt: 'P:wms T:PEER_REQUEST ID:fe1 FROM:frontend-01 Q:enum?' }) } },
    { timestamp: iso(20), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { timestamp: iso(30), type: 'event_msg', payload: { type: 'task_complete' } },
  ));
  const st = f.tracker().state();
  assert.equal(st.sessions[0].exec, 'IDLE');
  assert.equal(st.sessions[0].unverified, true);
  assert.equal(st.messages[0].id, 'fe1');
});

test('receive wrapper links the receiver to the sender record; replies resolve via RE', () => {
  const f = fixture();
  f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:b1 FROM:backend-01')));
  f.claude('l1', jl(
    { type: 'user', sessionId: 'l1', timestamp: iso(50), message: { content: [{ type: 'text', text: '<cross-session-message from="backend-01">P:wms T:JOIN_REQUEST ID:b1 FROM:backend-01</cross-session-message>' }] } },
    claudeSend('l1', 100, 'u2', 'P:wms T:JOIN_ACK ID:l1 RE:b1', 'backend-01'),
  ));
  const st = f.tracker().state();
  const byId = Object.fromEntries(st.messages.map((m) => [m.id, m]));
  assert.equal(byId.b1.from, 'claude:w1'); assert.equal(byId.b1.to, 'claude:l1');
  assert.equal(byId.l1.from, 'claude:l1'); assert.equal(byId.l1.to, 'claude:w1');
  assert.equal(st.sessions.find((s) => s.id === 'claude:l1').role, 'Leader');
  assert.equal(byId.b1.p2p, false);
});

test('skill example envelopes in tool results, assistant text and user text create no events or members', () => {
  const f = fixture();
  const doc = 'P:wms T:ASSIGN ID:17 REF:docs/tasks/17.md ACK:1\nproject: example-project\ntype: JOIN_ACK';
  f.claude('s2', jl(
    { type: 'user', sessionId: 's2', timestamp: iso(0), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: doc }] } },
    { type: 'assistant', sessionId: 's2', timestamp: iso(10), message: { content: [{ type: 'text', text: doc }] } },
    { type: 'user', sessionId: 's2', timestamp: iso(20), message: { content: doc } },
  ));
  f.codex('b', jl(
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'cx2', cwd: '/x' } },
    { timestamp: iso(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'z', output: doc } },
    { timestamp: iso(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: doc }] } },
  ));
  const st = f.tracker().state();
  assert.equal(st.messages.length, 0);
  assert.equal(st.sessions.length, 0);
});

test('duplicate IDs collapse; other projects are ignored', () => {
  const f = fixture();
  f.claude('s3', jl(
    claudeSend('s3', 0, 'u1', 'P:wms T:PING ID:p1 FROM:a'),
    claudeSend('s3', 10, 'u2', 'P:wms T:PING ID:p1 FROM:a'),
    claudeSend('s3', 20, 'u3', 'P:other T:PING ID:o1 FROM:a'),
  ));
  assert.equal(f.tracker().state().messages.length, 1);
});

test('incremental reads keep a partially written last line', () => {
  const f = fixture();
  const line = JSON.stringify(claudeSend('s4', 0, 'u1', 'P:wms T:PING ID:p1 FROM:a'));
  const file = path.join(f.claudeDir, 'proj', 's4.jsonl');
  const tr = f.tracker();
  fs.writeFileSync(file, line.slice(0, 40));
  assert.equal(tr.state().sessions.length, 0);
  fs.appendFileSync(file, line.slice(40) + '\n');
  assert.equal(tr.state().messages.length, 1);
});

test('stale sessions are marked STALE', () => {
  const f = fixture();
  f.claude('s5', jl({ ...claudeSend('s5', 0, 'u1', 'P:wms T:PING ID:p1 FROM:a'), timestamp: new Date(T - 3600e3).toISOString() }));
  assert.equal(f.tracker().state().sessions[0].exec, 'STALE');
});

test('server rejects foreign Host headers and serves state for the right one', async () => {
  const f = fixture();
  const server = createServer(f.tracker());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = (host, p) => new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path: p, headers: { host } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  try {
    assert.equal((await get('evil.example', '/api/state')).status, 403);
    const ok = await get(`localhost:${port}`, '/api/state');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).sessions, []);
    assert.match((await get(`127.0.0.1:${port}`, '/')).body, /Agent Team Office/);
  } finally { server.close(); }
});
