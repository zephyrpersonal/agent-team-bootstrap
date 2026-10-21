import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Script, runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
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

test('tracker links ledgerDir fixture tasks only to exact client and full session IDs', () => {
  const f = fixture();
  const ledgerDir = fileURLToPath(new URL('./fixtures/team-dashboard/ledger/', import.meta.url));
  f.claude('worker', jl(claudeSend('claude-worker', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:join FROM:backend-01')));
  f.codex('worker', jl(dated(codex.session_meta, 0), dated(codex.send, 20)));
  const tracker = createTracker({ project: 'wms', claudeDir: f.claudeDir, codexDir: f.codexDir, ledgerDir, now: () => T });
  const state = tracker.state();
  assert.equal(state.ledger.status, 'ok');
  assert.equal(state.ledger.source, 'directory');
  assert.equal(state.ledger.sourcePath, path.resolve(ledgerDir));
  assert.equal(state.ledger.commit, null);
  assert.equal(state.ledger.updatedAt, T);
  assert.equal(state.sessions.length, 2);
  assert.deepEqual(state.ledger.tasks.map((task) => [task.id, task.ownerSessionId, task.reviewerSessionId]), [
    ['17', 'claude:claude-worker', 'codex:codex-worker'],
    ['18', 'codex:codex-worker', 'claude:claude-worker'],
    ['19', null, null],
  ]);
  fs.rmSync(path.join(f.claudeDir, 'proj', 'worker.jsonl'));
  f.claude('near-match', jl(claudeSend('claude-worker-extra', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:join FROM:backend-01')));
  const changed = tracker.state();
  assert.equal(changed.sessions.find((s) => s.client === 'claude').name, 'backend-01');
  assert.equal(changed.ledger.tasks[0].ownerSessionId, null, 'a matching name and session prefix cannot link a task');
  assert.equal(changed.ledger.tasks[0].ownerLink, 'unmatched');
  assert.equal(changed.ledger.tasks[0].reviewerSessionId, 'codex:codex-worker');
});

test('HTTP API reports an unavailable ledger branch without affecting sessions', async (t) => {
  const f = fixture();
  const ledgerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ledger-'));
  t.after(() => fs.rmSync(ledgerRepo, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', ledgerRepo]);
  f.claude('worker', jl(claudeSend('full-worker-session', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:join FROM:backend-01')));
  const tracker = createTracker({ project: 'wms', claudeDir: f.claudeDir, codexDir: f.codexDir, ledgerRepo, now: () => T });
  const expected = tracker.state();
  const server = createServer(tracker);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.ledger.status, 'unavailable');
    assert.equal(state.ledger.source, 'git');
    assert.equal(state.ledger.sourcePath, ledgerRepo);
    assert.equal(state.ledger.ref, null);
    assert.equal(state.ledger.commit, null);
    assert.equal(state.ledger.updatedAt, T);
    assert.deepEqual(state.ledger.tasks, []);
    assert.deepEqual(state.ledger.diagnostics, []);
    assert.match(state.ledger.error, /branch is unavailable locally; no fetch was attempted/);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].id, 'claude:full-worker-session');
    assert.deepEqual(state.sessions, expected.sessions);
    assert.deepEqual(state.messages, JSON.parse(JSON.stringify(expected.messages)));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('server enforces Host guard and serves the dashboard with tested inline rules', async (t) => {
  const f = fixture();
  const server = createServer(f.tracker());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = (host, p) => new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path: p, headers: { host } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', reject);
  });
  try {
    for (const route of ['/', '/api/state', '/vendor/d3-7.9.0.min.js', '/unknown']) {
      assert.equal((await get('evil.example', route)).status, 403, route);
    }
    for (const route of ['/unknown', '/vendor/missing.js', '/vendor/D3-LICENSE', '/vendor/team-dashboard.mjs']) {
      assert.equal((await get(`localhost:${port}`, route)).status, 404, route);
    }
    const vendor = await get(`localhost:${port}`, '/vendor/d3-7.9.0.min.js');
    assert.equal(vendor.status, 200);
    assert.equal(vendor.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(vendor.headers['x-content-type-options'], 'nosniff');
    assert.equal(vendor.body, fs.readFileSync(new URL('./vendor/d3-7.9.0.min.js', import.meta.url), 'utf8'));
    const license = fs.readFileSync(new URL('./vendor/D3-LICENSE', import.meta.url), 'utf8');
    assert.match(license, /Copyright/);
    assert.match(license, /Permission to use, copy, modify, and\/or distribute/);
    const ok = await get(`localhost:${port}`, '/api/state');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).sessions, []);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const page = await get(`127.0.0.1:${port}`, '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    assert.deepEqual(Array.from(page.body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), (match) => match[1]), ['/vendor/d3-7.9.0.min.js']);
    assert.match(page.body, /<title>Agent Team · 团队监控<\/title>/);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
    new Script(script);
    assert.doesNotMatch(script, /`|\$\{|format unverified/);
    const start = script.indexOf('function esc('), end = script.indexOf('// DOM 与轮询状态。');
    assert.ok(start >= 0 && end > start, 'pure rules have an explicit boundary before DOM state');
    const context = { setTimeout, clearTimeout, setInterval, clearInterval, performance };
    const rules = runInNewContext(vendor.body + '\n' + script.slice(start, end) + '; ({ d3, matchingMessages, counts, attentionSessions, avatar, esc, messageKey, newMessages, communicationGraph, forceLayout, curvePath, edgeType, edgeState, cardState })', context);
    assert.equal(rules.d3.version, '7.9.0');
    await t.test('card appearance keeps blocked and stale visible without implying running work is complete', () => {
      for (const [exec, proto, expected] of [
        ['RUNNING', 'ASSIGNED', 'running'], ['IDLE', 'IN_REVIEW', 'review'],
        ['RUNNING', 'BLOCKED', 'blocked'], ['STALE', 'COMPLETE', 'stale'],
        ['RUNNING', 'COMPLETE', 'running'], ['IDLE', 'COMPLETE', 'complete'],
        ['IDLE', 'NONE', 'idle'], ['STALE', 'BLOCKED', 'blocked'],
      ]) assert.equal(rules.cardState({ exec, proto }), expected);
      assert.match(script, /seat\.dataset\.role=s\.role/);
      assert.match(script, /seat\.dataset\.cardState=cardState\(s\)/);
    });

    await t.test('message filters combine exact type and member IDs with case-insensitive search', () => {
      const messages = [
        { id: 'm1', type: 'ASSIGN', from: 'claude:1', to: 'codex:2', fromLabel: 'Backend', ref: 'PR#42' },
        { id: 'm2', type: 'ASSIGN', from: 'codex:2', to: 'claude:1', ref: 'PR#43' },
        { id: 'm3', type: 'PING', from: 'claude:1', to: 'codex:2', ref: 'PR#42' },
        { id: 'm4', type: 'ASSIGN', from: 'claude:10', to: 'codex:2', fromLabel: 'claude:1', ref: 'PR#42' },
      ];
      const ids = (type = '', member = '', query = '') => Array.from(rules.matchingMessages(messages, type, member, query), (m) => m.id);
      assert.deepEqual(ids(), ['m1', 'm2', 'm3', 'm4']);
      assert.deepEqual(ids('ASSIGN', 'claude:1', '  pr#42  '), ['m1']);
      assert.deepEqual(ids('ASSIGN', 'claude:1'), ['m1', 'm2']);
      assert.deepEqual(ids('', 'claude:'), []);
      assert.deepEqual(ids('assign'), []);
      assert.deepEqual(ids('', '', 'missing'), []);
      for (const field of ['type', 'fromLabel', 'toLabel', 'from', 'to', 'id', 're', 'status', 'ref']) {
        const message = { [field]: 'Needle' };
        assert.deepEqual(Array.from(rules.matchingMessages([message, {}], '', '', '  nEeDlE  ')), [message], field);
      }
    });

    await t.test('counts keep execution and protocol independent; attention lists each member once', () => {
      const sessions = [
        { id: 'a', exec: 'RUNNING', proto: 'COMPLETE' },
        { id: 'b', exec: 'RUNNING', proto: 'BLOCKED' },
        { id: 'c', exec: 'STALE', proto: 'BLOCKED' },
        { id: 'd', exec: 'IDLE', proto: 'ACTIVE' },
        { id: 'e', exec: 'STALE', proto: 'COMPLETE' },
      ];
      assert.deepEqual({ ...rules.counts(sessions) }, { total: 5, running: 2, blocked: 2, stale: 2 });
      assert.deepEqual(Array.from(rules.attentionSessions(sessions), (s) => s.id), ['b', 'c', 'e']);
      assert.deepEqual({ ...rules.counts([]) }, { total: 0, running: 0, blocked: 0, stale: 0 });
      assert.deepEqual(Array.from(rules.attentionSessions([])), []);
    });

    await t.test('avatars map clients to project text marks and unknown clients to a safe fallback', () => {
      for (const [client, mark, label] of [['claude', 'CC', 'Claude Code'], ['codex', 'CX', 'Codex CLI']]) {
        const html = rules.avatar(client);
        assert.match(html, new RegExp('^<span class="avatar cli-icon ' + client + '" role="img" aria-label="' + label + '">'));
        assert.ok(html.includes('<b>' + mark + '</b>'));
        assert.doesNotMatch(html, /<svg|<img/);
        assert.equal(rules.avatar(client), html);
      }
      const fallback = rules.avatar('unknown');
      assert.match(fallback, /^<span class="avatar cli-icon generic" role="img" aria-label="CLI">/);
      assert.ok(fallback.includes('<b>>_</b>'));
      for (const client of ['', null, undefined, 'claude:1', 'codex:2', '"><script>alert(1)</script>']) {
        assert.equal(rules.avatar(client), fallback);
      }
      for (const name of ['renderStage', 'renderMembers', 'renderDetail']) {
        const start = script.indexOf('function ' + name + '(');
        const end = script.indexOf('\nfunction ', start + 1);
        assert.ok(start >= 0, name);
        assert.match(script.slice(start, end), /avatar\(s\.client\)/, name);
      }
    });

    await t.test('esc encodes markup and attribute injection characters', () => {
      assert.equal(rules.esc('"><script>alert("x")</script>&'), '&quot;&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;');
      assert.equal(rules.esc(null), '');
      assert.equal(rules.esc(undefined), '');
      assert.equal(rules.esc(0), '0');
    });

    await t.test('new messages skip the initial snapshot and previously seen sender/ID pairs', () => {
      const seen = { from: 'claude:1', id: 'm1', ts: 1, type: 'PING', to: 'codex:2' };
      const duplicate = { ...seen, ts: 2, type: 'PONG', to: 'codex:3' };
      const otherSender = { ...seen, from: 'claude:2' };
      const next = { ...seen, id: 'm2' };
      assert.deepEqual(Array.from(rules.newMessages([seen, otherSender], null)), []);
      assert.equal(rules.messageKey(seen), rules.messageKey(duplicate));
      assert.notEqual(rules.messageKey(seen), rules.messageKey(otherSender));
      const previous = new Set([rules.messageKey(seen)]);
      assert.deepEqual(Array.from(rules.newMessages([duplicate], previous)), []);
      assert.deepEqual(Array.from(rules.newMessages([duplicate, otherSender, next], previous)), [otherSender, next]);
    });

    await t.test('messages without IDs fall back to sender, timestamp, type and recipient', () => {
      const seen = { from: 'claude:1', ts: 1, type: 'PING', to: 'codex:2' };
      const variants = [
        { ...seen, from: 'claude:2' },
        { ...seen, ts: 2 },
        { ...seen, type: 'PONG' },
        { ...seen, to: 'codex:3' },
      ];
      assert.equal(rules.messageKey(seen), rules.messageKey({ ...seen, id: '' }));
      for (const message of variants) assert.notEqual(rules.messageKey(seen), rules.messageKey(message));
      const previous = new Set([rules.messageKey(seen)]);
      assert.deepEqual(Array.from(rules.newMessages([{ ...seen }, ...variants], previous)), variants);
    });

    await t.test('new message batches contain at most the latest four unseen messages', () => {
      const messages = Array.from({ length: 7 }, (_, i) => ({ from: 'claude:1', id: 'm' + i }));
      const previous = new Set([rules.messageKey(messages[5])]);
      assert.deepEqual(Array.from(rules.newMessages(messages, previous)), [messages[2], messages[3], messages[4], messages[6]]);
      assert.deepEqual(Array.from(rules.newMessages(messages.slice(0, 2), new Set())), messages.slice(0, 2));
      assert.deepEqual(Array.from(rules.newMessages([], new Set())), []);
    });

    const members = (...ids) => ids.map((id) => ({ id, role: 'Worker' }));
    const links = (...pairs) => pairs.map(([from, to]) => ({ from, to }));
    const completeLinks = (sessions) => links(...sessions.flatMap((a, i) => sessions.slice(i + 1).map((b) => [a.id, b.id])));
    const graphSnapshot = (graph) => JSON.parse(JSON.stringify({
      order: graph.order, edges: Array.from(graph.edges),
      adj: Array.from(graph.adj, ([id, peers]) => [id, Array.from(peers)]),
    }));

    await t.test('communication graph retains isolated members and all 28 pairs of eight members', () => {
      const empty = rules.communicationGraph([], []);
      assert.deepEqual(Array.from(empty.order), []);
      for (const field of ['edges', 'adj']) assert.equal(empty[field].size, 0, field);
      const sessions = members('h', 'g', 'f', 'e', 'd', 'c', 'b', 'a');
      const isolated = rules.communicationGraph(sessions, []);
      assert.deepEqual(Array.from(isolated.order), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      assert.equal(isolated.adj.size, 8);
      assert.equal(isolated.edges.size, 0);
      for (const peers of isolated.adj.values()) assert.equal(peers.size, 0);
      const messages = completeLinks(sessions);
      const graph = rules.communicationGraph(sessions, [...messages, ...messages.map((m) => ({ from: m.to, to: m.from }))]);
      assert.equal(graph.adj.size, 8);
      assert.equal(graph.edges.size, 28);
      for (const [key, edge] of graph.edges) {
        assert.equal(key, JSON.stringify(edge.pair));
        assert.equal(edge.count, 2);
      }
      for (const [id, peers] of graph.adj) {
        assert.equal(peers.size, 7);
        assert.equal(peers.has(id), false);
        for (const peer of peers) assert.ok(graph.adj.get(peer).has(id));
      }
    });

    await t.test('unknown endpoints and self messages create neither nodes nor edges', () => {
      const graph = rules.communicationGraph(members('a', 'b'), links(
        ['a', 'a'], ['b', 'b'], ['a', 'missing'], ['missing', 'b'], ['unknown', 'missing'],
        ['a', undefined], [undefined, 'b'], ['a', null], ['', 'b'], ['a', 'b'],
      ));
      assert.deepEqual(Array.from(graph.order), ['a', 'b']);
      assert.deepEqual(Array.from(graph.edges.values(), (edge) => Array.from(edge.pair)), [['a', 'b']]);
      assert.equal(graph.edges.values().next().value.count, 1);
      assert.deepEqual(Array.from(graph.adj.get('a')), ['b']);
      assert.deepEqual(Array.from(graph.adj.get('b')), ['a']);
    });

    await t.test('bidirectional repeats merge and the greatest timestamp determines type and state', () => {
      const messages = [
        { from: 'b', to: 'a', ts: 30, type: 'REVIEW_VERDICT', status: 'approved' },
        { from: 'a', to: 'b', ts: 10, type: 'ASSIGN' },
        { from: 'b', to: 'a', ts: 20, type: 'BLOCKED' },
      ];
      for (const input of [messages, messages.slice().reverse()]) {
        const graph = rules.communicationGraph(members('a', 'b'), input);
        const edge = graph.edges.get('["a","b"]');
        assert.equal(graph.edges.size, 1);
        assert.deepEqual(Array.from(edge.pair), ['a', 'b']);
        assert.equal(edge.count, 3);
        assert.equal(edge.latest, messages[0]);
        assert.equal(edge.category, 'review');
        assert.equal(edge.state, 'complete');
      }
      const update = { from: 'a', to: 'b', ts: 40, type: 'PEER_REPLY', status: 'failed' };
      const edge = rules.communicationGraph(members('a', 'b'), [...messages, update, update]).edges.get('["a","b"]');
      assert.equal(edge.count, 5);
      assert.equal(edge.latest, update);
      assert.equal(edge.category, 'peer');
      assert.equal(edge.state, 'blocked');
      const tie = { ...update, type: 'PING', status: '' };
      const tied = rules.communicationGraph(members('a', 'b'), [update, tie]).edges.get('["a","b"]');
      assert.equal(tied.latest, tie, 'the last message wins equal timestamps');
      assert.equal(tied.category, 'other');
      assert.equal(tied.state, 'observed');
    });

    await t.test('order survives shuffles and expired links, removes departed members and appends newcomers', () => {
      const sessions = [{ id: 'n', role: 'Leader' }, ...members('m')];
      const messages = links(['m', 'n']);
      const previous = rules.communicationGraph(sessions, messages);
      const before = graphSnapshot(previous);
      assert.deepEqual(Array.from(previous.order), ['m', 'n']);
      const repeated = [...messages, ...links(['n', 'm'], ['m', 'n'])];
      for (const prior of [undefined, previous]) {
        assert.deepEqual(Array.from(rules.communicationGraph(sessions.slice().reverse(), repeated, prior).order), ['m', 'n']);
      }
      const graph = rules.communicationGraph(
        [{ id: 'a', role: 'Leader' }, ...members('z'), ...sessions.slice().reverse()],
        [...messages, ...links(['n', 'z'], ['m', 'a'])], previous,
      );
      assert.deepEqual(Array.from(graph.order), ['m', 'n', 'a', 'z']);
      const expired = rules.communicationGraph([...sessions, ...members('a', 'z', 'b')], [], graph);
      assert.deepEqual(Array.from(expired.order), ['m', 'n', 'a', 'z', 'b']);
      assert.equal(expired.edges.size, 0);
      const removed = rules.communicationGraph(members('z', 'a', 'b'), links(['a', 'b'], ['m', 'a']), expired);
      assert.deepEqual(Array.from(removed.order), ['a', 'z', 'b']);
      assert.equal(removed.edges.size, 1);
      assert.deepEqual(graphSnapshot(previous), before, 'updates leave the previous graph intact');
    });

    await t.test('edgeType classifies coordination, peer, review and other messages', () => {
      const cases = {
        assign: ['ASSIGN', 'JOIN_REQUEST', 'JOIN_ACK', 'ACK_RECEIVED', 'COORDINATION'],
        peer: ['PEER_REQUEST', 'PEER_REPLY', 'SCOPE_REQUEST', 'SCOPE_REPLY'],
        review: ['REVIEW_REQUEST', 'REVIEW_FEEDBACK', 'REVIEW_VERDICT', 'REVIEW_RESULT'],
        other: ['PING', 'PONG', 'BLOCKED', 'COMPLETE', 'UNKNOWN', '', null, undefined],
      };
      for (const [category, types] of Object.entries(cases)) {
        for (const type of types) assert.equal(rules.edgeType(type), category, String(type));
      }
    });

    await t.test('edgeState reflects latest message content with blocked taking precedence', () => {
      const cases = [
        [{ type: 'BLOCKED' }, 'blocked'], [{ type: 'COMPLETE' }, 'complete'],
        ...['BLOCKED', 'rejected', 'failed'].map((status) => [{ type: 'PING', status }, 'blocked']),
        ...['APPROVED', 'completed', 'success'].map((status) => [{ type: 'REVIEW_VERDICT', status }, 'complete']),
        [{ type: 'BLOCKED', status: 'approved' }, 'blocked'],
        [{ type: 'COMPLETE', status: 'failed' }, 'blocked'],
        ...['sent', 'delivered', 'received', 'pending', '', null, undefined].map((status) => [{ type: 'PING', status }, 'observed']),
        [{}, 'observed'],
      ];
      for (const [message, state] of cases) assert.equal(rules.edgeState(message), state, JSON.stringify(message));
    });

    await t.test('real D3 settles finite cards without overlap for desktop and mobile graphs', async (t) => {
      const sessions = members('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
      for (const viewport of [{ width: 1200, height: 420 }, { width: 1384, height: 500 }, { width: 366, height: 500 }]) {
        await t.test(viewport.width + 'x' + viewport.height, () => {
          for (const messages of [[], completeLinks(sessions)]) {
            const graph = rules.communicationGraph(sessions, messages);
            const { nodes, simulation } = rules.forceLayout(rules.d3, graph, new Map(), viewport.width, viewport.height, viewport.width < 600);
            try {
              simulation.stop();
              assert.equal(nodes.length, 8);
              assert.equal(simulation.nodes(), nodes);
              for (const [i, a] of nodes.entries()) {
                assert.ok([a.x, a.y, a.vx, a.vy, a.width, a.height].every(Number.isFinite));
                assert.ok(a.width > 0 && a.height > 0);
                if (viewport.width < 600) assert.ok(a.width < 200, 'mobile cards stay compact');
                const radius = Math.hypot(a.width, a.height) / 2;
                assert.ok(simulation.force('collision').radius()(a) > radius, 'collision covers the half diagonal plus padding');
                for (const b of nodes.slice(i + 1)) {
                  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= radius + Math.hypot(b.width, b.height) / 2,
                    a.id + ' and ' + b.id + ' collision circles do not overlap');
                }
              }
              for (const edge of graph.edges.values()) {
                for (const pair of [edge.pair, edge.pair.slice().reverse()]) {
                  const a = nodes.find((n) => n.id === pair[0]), b = nodes.find((n) => n.id === pair[1]);
                  const curve = rules.curvePath(a, b, nodes);
                  assert.match(curve.d, /^M \S+ \S+ Q \S+ \S+ \S+ \S+$/);
                  const [x, y, cx, cy, ex, ey] = curve.d.match(/[^MQ\s]+/g).map(Number);
                  assert.ok([x, y, cx, cy, ex, ey, curve.end.x, curve.end.y].every(Number.isFinite));
                  assert.deepEqual({ ...curve.end }, { x: ex, y: ey });
                  for (const [px, py, n] of [[x, y, a], [ex, ey, b]]) {
                    const rx = Math.abs(px - n.x) / (n.width / 2 + 3);
                    const ry = Math.abs(py - n.y) / (n.height / 2 + 3);
                    assert.ok(Math.abs(Math.max(rx, ry) - 1) < 1e-9, 'curve attaches to the padded card border');
                  }
                }
              }
            } finally { simulation.stop(); }
          }
        });
      }
      const empty = rules.forceLayout(rules.d3, rules.communicationGraph([], []), new Map(), 366, 500, true);
      empty.simulation.stop();
      assert.equal(empty.nodes.length, 0);
    });

    await t.test('polling deduplicates requests, retains state on failure and respects pause', async () => {
      const tickStart = script.indexOf('async function tick('), tickEnd = script.indexOf("$('#pause').onclick", tickStart);
      assert.ok(tickStart >= 0 && tickEnd > tickStart);
      let requests = 0, finish;
      const state = { sessions: [{ id: 'a' }], messages: [] };
      const context = {
        inFlight: false, paused: false, demo: false, document: { hidden: false },
        lastState: null, lastSuccess: 0, connectionError: '', AbortSignal,
        renderConnection() {}, render(st) { context.lastState = st; },
        fetch(url, options) {
          requests++;
          assert.equal(url, '/api/state');
          assert.equal(options.cache, 'no-store');
          return new Promise((resolve) => { finish = resolve; });
        },
      };
      const tick = runInNewContext(script.slice(tickStart, tickEnd) + '; tick', context);
      const pending = tick(false);
      await tick(true);
      assert.equal(requests, 1);
      assert.equal(context.inFlight, true);
      finish({ ok: true, json: async () => state });
      await pending;
      assert.equal(context.lastState, state);
      assert.equal(context.inFlight, false);
      const lastSuccess = context.lastSuccess;
      assert.ok(lastSuccess > 0);
      context.fetch = async () => { requests++; throw new Error('offline'); };
      await tick(false);
      assert.equal(context.lastState, state);
      assert.equal(context.lastSuccess, lastSuccess);
      assert.equal(context.connectionError, 'offline');
      assert.equal(context.inFlight, false);
      context.paused = true;
      await tick(false);
      assert.equal(requests, 2);
      await tick(true);
      assert.equal(requests, 3, 'manual refresh remains available while paused');
      context.paused = false;
      context.document.hidden = true;
      await tick(false);
      assert.equal(requests, 3);
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
