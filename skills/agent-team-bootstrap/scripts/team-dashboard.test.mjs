import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Script, runInNewContext } from 'node:vm';
import { createTracker, createServer, parseEnvelope, parseCodexLine, parseClaudeLine } from './team-dashboard.mjs';

const sample = (client) => JSON.parse(fs.readFileSync(new URL(`./fixtures/team-dashboard/${client}.json`, import.meta.url))).rows;
const codex = sample('codex'), claude = sample('claude');
const dated = (row, offset) => ({ ...row, timestamp: iso(offset) });

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

test('LEAVE_REQUEST then LEAVE_ACK marks the Worker LEFT', () => {
  const f = fixture();
  f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:LEAVE_REQUEST ID:lv1 FROM:fe-01 REF:branch')));
  f.claude('l1', jl(claudeSend('l1', 100, 'u2', 'P:wms T:LEAVE_ACK ID:la1 RE:lv1', 'fe-01')));
  const st = f.tracker().state();
  assert.equal(st.sessions.find((s) => s.name === 'fe-01').proto, 'LEFT');
});

test('Codex: tool call + output + task_complete is IDLE; send_message_to_thread envelope is recognised', () => {
  const f = fixture();
  f.codex('a', jl(...['session_meta', 'task_started', 'user', 'assistant', 'send', 'send_output', 'task_complete']
    .map((key, i) => dated(codex[key], i * 10))));
  const st = f.tracker().state();
  assert.equal(st.sessions[0].exec, 'IDLE');
  assert.equal(st.sessions[0].id, 'codex:codex-worker');
  assert.equal(st.sessions[0].cwd, '/work/demo');
  assert.equal(st.messages[0].id, 'cx-join');
  assert.equal(st.sessions[0].lastText, 'Inspecting the task.');
});

test('real Claude queued/user wrappers link receivers; queue logs do not duplicate delivery', () => {
  const f = fixture();
  f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:cl-join FROM:backend-01')));
  f.claude('l1', jl(
    dated(claude.enqueue, 30), dated(claude.queued, 50), dated(claude.user, 60),
    claudeSend('claude-leader', 100, 'u2', 'P:wms T:JOIN_ACK ID:l1 RE:cl-join', 'backend-01'),
  ));
  const st = f.tracker().state();
  const byId = Object.fromEntries(st.messages.map((m) => [m.id, m]));
  assert.equal(byId['cl-join'].from, 'claude:w1'); assert.equal(byId['cl-join'].to, 'claude:claude-leader');
  assert.equal(byId.l1.from, 'claude:claude-leader'); assert.equal(byId.l1.to, 'claude:w1');
  assert.equal(st.sessions.find((s) => s.id === 'claude:claude-leader').role, 'Leader');
  assert.equal(byId['cl-join'].p2p, false);
  assert.equal(st.messages.length, 2);
  for (const row of [claude.queued, claude.user]) {
    assert.equal(parseClaudeLine(row, {}).filter((ev) => ev.kind === 'recv').length, 1);
  }
  assert.deepEqual(parseClaudeLine(claude.enqueue, {}), []);
});

test('Codex threadId resolves directly even when the receiver has no protocol name', () => {
  const f = fixture();
  f.codex('worker', jl(dated(codex.session_meta, 0), dated(codex.send, 20)));
  f.codex('leader', jl(
    { ...dated(codex.session_meta, 0), payload: { ...codex.session_meta.payload, id: 'codex-leader' } },
    { ...dated(codex.send, 10), payload: { ...codex.send.payload, arguments: JSON.stringify({ threadId: 'codex-worker', prompt: 'P:wms T:ASSIGN ID:assignment' }) } },
  ));
  assert.equal(f.tracker().state().messages.find((m) => m.id === 'cx-join').to, 'codex:codex-leader');
});

test('Codex commentary stays RUNNING during a turn; completion and interruption clear pending tools', () => {
  for (const ending of ['task_complete', 'turn_aborted']) {
    const f = fixture();
    const rows = ['session_meta', 'send', 'send_output', 'task_started', 'assistant'].map((key, i) => dated(codex[key], i * 10));
    f.codex('worker', jl(...rows));
    const tracker = f.tracker();
    assert.equal(tracker.state().sessions[0].exec, 'RUNNING');
    f.codex('worker', jl(...rows, dated(codex.custom_tool_call, 60)));
    assert.match(tracker.state().sessions[0].tool, /^apply_patch:/);
    f.codex('worker', jl(...rows, dated(codex.custom_tool_call, 60), dated(codex[ending], 70)));
    assert.equal(tracker.state().sessions[0].exec, 'IDLE');
  }
  const call = parseCodexLine(codex.custom_tool_call, {})[0];
  assert.equal(parseCodexLine(codex.custom_tool_call_output, {})[0].callId, call.callId);
});

test('legacy agent_message remains text-only (handwritten compatibility case, no local sample)', () => {
  const events = parseCodexLine({ type: 'event_msg', payload: { type: 'agent_message', message: 'P:wms T:ASSIGN ID:example' } }, {});
  assert.deepEqual(events.map((e) => e.kind), ['text']);
});

test('skill example envelopes in tool results, assistant text and user text create no events or members', () => {
  const f = fixture();
  const doc = 'P:wms T:ASSIGN ID:17 REF:docs/tasks/17.md ACK:1\nproject: example-project\ntype: JOIN_ACK';
  f.claude('s2', jl(
    { type: 'user', sessionId: 's2', timestamp: iso(0), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: doc }] } },
    { type: 'assistant', sessionId: 's2', timestamp: iso(10), message: { content: [{ type: 'text', text: doc }] } },
    { type: 'user', sessionId: 's2', timestamp: iso(20), message: { content: doc } },
    { type: 'attachment', attachment: { type: 'tools', prompt: claude.queued.attachment.prompt } },
    { ...claude.user, message: { role: 'user', content: 'Documentation example:\n' + claude.user.message.content } },
  ));
  f.codex('b', jl(
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'cx2', cwd: '/x' } },
    { timestamp: iso(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'z', output: doc } },
    { timestamp: iso(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: doc }] } },
    { ...codex.send, payload: { ...codex.send.payload, name: 'not_send_message_to_thread' } },
    { ...codex.send, payload: { ...codex.send.payload, arguments: '{broken' } },
  ));
  const st = f.tracker().state();
  assert.equal(st.messages.length, 0);
  assert.equal(st.sessions.length, 0);
});

test('large tails preserve UTF-8 and partial lines across chunk boundaries', () => {
  const f = fixture();
  const row = claudeSend('large', 0, 'u1', 'P:wms T:PING ID:large FROM:a ' + '中文'.repeat(24000));
  const bytes = Buffer.from(jl(row));
  const file = path.join(f.claudeDir, 'proj', 'large.jsonl');
  const tracker = f.tracker();
  fs.writeFileSync(file, bytes.subarray(0, 65537));
  assert.equal(tracker.state().messages.length, 0);
  fs.appendFileSync(file, bytes.subarray(65537));
  assert.equal(tracker.state().messages[0].id, 'large');
  fs.appendFileSync(file, jl({ type: 'assistant', sessionId: 'large', timestamp: iso(10), message: { content: '中文正常' } }));
  assert.equal(tracker.state().sessions[0].lastText, '中文正常');
});

test('split session files retain messages and use the newest state regardless of file order', () => {
  for (const names of [['a', 'z'], ['z', 'a']]) {
    const f = fixture();
    f.claude(names[0], jl(claudeSend('split', 0, 'u1', 'P:wms T:PING ID:old FROM:a')));
    f.claude(names[1], jl({ type: 'assistant', sessionId: 'split', timestamp: iso(100), message: { content: 'Finished.' } }));
    const st = f.tracker().state();
    assert.equal(st.sessions.length, 1);
    assert.equal(st.sessions[0].exec, 'IDLE');
    assert.equal(st.sessions[0].lastText, 'Finished.');
    assert.equal(st.messages[0].id, 'old');
  }
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

test('server enforces Host guard and serves valid, responsive inline UI', async () => {
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
    const html = (await get(`127.0.0.1:${port}`, '/')).body;
    assert.match(html, /Agent Team Office/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    new Script(script);
    assert.doesNotMatch(script, /`|\$\{|format unverified/);
    const fly = script.slice(script.indexOf('function fly('), script.indexOf('function renderMessages('));
    runInNewContext(fly + '; fly({from:"a",to:"b"}, 0)', {
      pos: { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, chars: {},
      motion: { matches: true }, setTimeout: (fn) => fn(),
      el: () => assert.fail('reduced motion must not create flying envelopes'),
    });
    const layout = script.slice(script.indexOf('function layout('), script.indexOf('function renderStage('));
    for (const width of [288, 335, 640, 900]) {
      for (const count of [0, 1, 4, 6, 8, 12]) {
        let bounds;
        const stage = { clientWidth: width, setAttribute: (name, value) => { if (name === 'viewBox') bounds = value.split(' ').map(Number); } };
        const sessions = Array.from({ length: count }, (_, i) => ({ id: String(i), role: i ? 'Worker' : 'Leader' }));
        const positions = Object.values(runInNewContext(layout + '; layout(sessions)', { $: () => stage, stage, sessions }));
        assert.equal(positions.length, count);
        for (const p of positions) {
          assert.ok(p.x >= 60 && p.x <= bounds[2] - 60, 'character fits stage width');
          assert.ok(p.y >= 100 && p.y <= bounds[3] - 100, 'character fits stage height');
        }
        for (let i = 0; i < positions.length; i++) {
          for (const p of positions.slice(i + 1)) {
            assert.ok(Math.hypot(p.x - positions[i].x, p.y - positions[i].y) >= 120, 'characters do not overlap');
          }
        }
      }
    }
  } finally { server.close(); }
});
