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
const herdr = JSON.parse(fs.readFileSync(new URL('./fixtures/team-dashboard/herdr.json', import.meta.url)));
const unavailableObserver = { snapshot: () => ({ status: 'unavailable', observedAt: T, agents: [], error: 'fixture: unavailable' }) };
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
    tracker: (project = 'wms', options = {}) => createTracker({ project, claudeDir, codexDir, now: () => T, herdrObserver: unavailableObserver, ...options }),
  };
}

const claudeSend = (sid, ts, id, message, to = 'leader') => ({
  type: 'assistant', sessionId: sid, cwd: '/w/' + sid, timestamp: iso(ts),
  message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message } }] },
});
const claudeResult = (sid, ts, id) => ({
  type: 'user', sessionId: sid, timestamp: iso(ts), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'sent' }] },
});

const claudeMetadata = (ts, fields) => ({
  type: 'assistant', sessionId: 'metadata-worker', timestamp: iso(ts), message: fields,
});
const codexMetadata = (ts, fields) => ({ type: 'turn_context', timestamp: iso(ts), payload: fields });

test('handwritten metadata: Claude metadata comes only from assistant message.model and output_config.effort', () => {
  assert.deepEqual(parseClaudeLine(claudeMetadata(10, { model: ' claude-test ', output_config: { effort: ' high ' } }), {}), [
    { ts: Date.parse(iso(10)), kind: 'metadata', model: 'claude-test', effort: 'high' },
  ]);
  assert.deepEqual(parseClaudeLine(claudeMetadata(20, { output_config: { effort: 'low' } }), {}), [
    { ts: Date.parse(iso(20)), kind: 'metadata', model: null, effort: 'low' },
  ]);
  const text = 'model: claude-injected output_config: {"effort":"max"}';
  for (const type of ['assistant', 'user']) {
    const events = parseClaudeLine({ ...claudeMetadata(30, { content: text }), type,
      model: 'claude-injected', output_config: { effort: 'max' } }, {});
    assert.deepEqual(events.map((ev) => ev.kind), ['text']);
  }
  assert.deepEqual(parseClaudeLine({ ...claudeMetadata(40, { model: 'ignored', output_config: { effort: 'max' } }), type: 'user' }, {}), []);
  assert.deepEqual(parseClaudeLine({ ...claudeMetadata(50, { model: 'ignored' }), isSidechain: true }, {}), []);
});

test('handwritten metadata: Codex turn_context reads payload model and either effort spelling without execution events', () => {
  for (const fields of [
    { model: ' gpt-test ', effort: ' high ' },
    { model: 'gpt-test', reasoning_effort: 'high' },
    { model: 'gpt-test', effort: 'high', reasoning_effort: 'low' },
  ]) {
    assert.deepEqual(parseCodexLine(codexMetadata(10, fields), {}), [
      { ts: Date.parse(iso(10)), kind: 'metadata', model: 'gpt-test', effort: 'high', reset: true },
    ]);
  }
  assert.deepEqual(parseCodexLine(codexMetadata(20, { model: 'gpt-test' }), {}), [
    { ts: Date.parse(iso(20)), kind: 'metadata', model: 'gpt-test', effort: null, reset: true },
  ]);
  const text = '{"model":"gpt-injected","reasoning_effort":"max"}';
  for (const role of ['assistant', 'user']) {
    const events = parseCodexLine({ type: 'response_item', timestamp: iso(30), model: 'ignored', effort: 'max',
      payload: { type: 'message', role, model: 'ignored', effort: 'max', content: [{ text }] } }, {});
    assert.deepEqual(events.map((ev) => ev.kind), ['text']);
  }
  assert.deepEqual(parseCodexLine({ type: 'session_meta', payload: { model: 'ignored', effort: 'max' } }, {}), []);
});

test('handwritten metadata: metadata parsers reject invalid field types and blank strings instead of coercing them', () => {
  for (const value of [undefined, null, false, true, 0, 42, {}, [], ['high'], '', ' \t\n ']) {
    assert.deepEqual(parseClaudeLine(claudeMetadata(0, { model: value, output_config: { effort: value } }), {}), []);
    for (const field of ['effort', 'reasoning_effort']) {
      assert.deepEqual(parseCodexLine(codexMetadata(0, { model: value, [field]: value }), {}), [
        { ts: Date.parse(iso()), kind: 'metadata', model: null, effort: null, reset: true },
      ]);
    }
  }
});

test('handwritten metadata: metadata alone creates neither project members nor protocol messages', () => {
  const f = fixture();
  f.claude('metadata', jl(claudeMetadata(100, { model: 'claude-test', output_config: { effort: 'high' } })));
  f.codex('metadata', jl(dated(codex.session_meta, 0), codexMetadata(200, { model: 'gpt-test', effort: 'high' })));
  const state = f.tracker().state();
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.messages, []);
});

test('handwritten metadata: metadata updates do not advance activity, clear pending tools or change membership', () => {
  for (const client of ['claude', 'codex']) {
    const f = fixture();
    f[client]('worker', client === 'claude'
      ? jl(claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join FROM:worker'))
      : jl(dated(codex.session_meta, 0), dated(codex.send, 0), dated(codex.task_started, 10), dated(codex.custom_tool_call, 20)));
    const tracker = f.tracker(), before = tracker.state();
    assert.equal(before.sessions[0].exec, 'RUNNING');
    const file = client === 'claude' ? path.join(f.claudeDir, 'proj', 'worker.jsonl')
      : path.join(f.codexDir, '2026', '10', '17', 'rollout-worker.jsonl');
    fs.appendFileSync(file, jl(client === 'claude'
      ? claudeMetadata(100, { model: 'claude-test', output_config: { effort: 'high' } })
      : codexMetadata(100, { model: 'gpt-test', reasoning_effort: 'high' })));
    const after = tracker.state(), session = after.sessions[0];
    assert.deepEqual(session, { ...before.sessions[0], model: client === 'claude' ? 'claude-test' : 'gpt-test',
      effort: 'high', modelObservedAt: Date.parse(iso(100)) });
    assert.deepEqual(after.messages, before.messages);
  }
});

test('handwritten metadata: fresh metadata cannot revive a stale member or advance lastTs', () => {
  const f = fixture();
  const old = T - 3600e3;
  f.claude('worker', jl({ ...claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join'), timestamp: new Date(old).toISOString() },
    claudeMetadata(100, { model: 'claude-test', output_config: { effort: 'high' } })));
  const session = f.tracker().state().sessions[0];
  assert.equal(session.exec, 'STALE');
  assert.equal(session.lastTs, old);
  assert.equal(session.modelObservedAt, Date.parse(iso(100)));
});

test('handwritten metadata: Claude model changes clear old effort, while ordinary text and same-model metadata preserve it', () => {
  const f = fixture();
  f.claude('worker', jl(claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join'),
    claudeMetadata(10, { model: 'claude-first', output_config: { effort: 'high' } })));
  const tracker = f.tracker(), file = path.join(f.claudeDir, 'proj', 'worker.jsonl');
  const check = (row, model, effort, observed) => {
    fs.appendFileSync(file, jl(row));
    const session = tracker.state().sessions[0];
    assert.deepEqual([session.model, session.effort, session.modelObservedAt], [model, effort, Date.parse(iso(observed))]);
  };
  assert.equal(tracker.state().sessions[0].effort, 'high');
  check(claudeMetadata(20, { content: 'model: injected effort: low' }), 'claude-first', 'high', 10);
  check(claudeMetadata(30, { model: 'claude-first' }), 'claude-first', 'high', 30);
  check(claudeMetadata(40, { model: 'claude-second' }), 'claude-second', null, 40);
  check(claudeMetadata(50, { output_config: { effort: 'low' } }), 'claude-second', 'low', 50);
  check(claudeMetadata(60, { model: 'claude-third', output_config: { effort: 'max' } }), 'claude-third', 'max', 60);
});

test('handwritten metadata: Codex missing turn effort clears it to unknown; ordinary text preserves metadata', () => {
  const f = fixture();
  f.codex('worker', jl(dated(codex.session_meta, 0), dated(codex.send, 0),
    codexMetadata(10, { model: 'gpt-first', effort: 'high' })));
  const tracker = f.tracker(), file = path.join(f.codexDir, '2026', '10', '17', 'rollout-worker.jsonl');
  assert.equal(tracker.state().sessions[0].effort, 'high');
  fs.appendFileSync(file, jl(dated(codex.assistant, 20)));
  let session = tracker.state().sessions[0];
  assert.deepEqual([session.model, session.effort, session.modelObservedAt], ['gpt-first', 'high', Date.parse(iso(10))]);
  for (const [offset, model] of [[30, 'gpt-first'], [40, 'gpt-second']]) {
    fs.appendFileSync(file, jl(codexMetadata(offset, { model })));
    session = tracker.state().sessions[0];
    assert.deepEqual([session.model, session.effort, session.modelObservedAt], [model, null, Date.parse(iso(offset))]);
  }
});

test('handwritten metadata: older metadata appended later cannot overwrite newer model or effort', () => {
  for (const client of ['claude', 'codex']) {
    const f = fixture(), meta = client === 'claude' ? claudeMetadata : codexMetadata;
    const fields = (model, effort) => client === 'claude' ? { model, output_config: { effort } } : { model, effort };
    f[client]('worker', client === 'claude'
      ? jl(claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join'), meta(100, fields('new-model', 'high')))
      : jl(dated(codex.session_meta, 0), dated(codex.send, 0), meta(100, fields('new-model', 'high'))));
    const tracker = f.tracker(), before = tracker.state().sessions[0];
    const file = client === 'claude' ? path.join(f.claudeDir, 'proj', 'worker.jsonl')
      : path.join(f.codexDir, '2026', '10', '17', 'rollout-worker.jsonl');
    fs.appendFileSync(file, jl(meta(50, fields('old-model', 'low')), meta(60, fields('older-without-effort'))));
    assert.deepEqual(tracker.state().sessions[0], before);
  }
});

test('handwritten metadata: split files select newest metadata independently of the execution snapshot and file order', () => {
  for (const client of ['claude', 'codex']) {
    for (const names of [['a', 'z'], ['z', 'a']]) {
      const f = fixture();
      if (client === 'claude') {
        f.claude(names[0], jl(claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join'), claudeResult('metadata-worker', 5, 'join'),
          claudeMetadata(10, { model: 'old-model', output_config: { effort: 'low' } }),
          claudeMetadata(300, { content: 'Newest execution snapshot.' })));
        f.claude(names[1], jl(claudeMetadata(200, { model: 'new-model', output_config: { effort: 'high' } })));
      } else {
        f.codex(names[0], jl(dated(codex.session_meta, 0), dated(codex.send, 0),
          codexMetadata(10, { model: 'old-model', effort: 'low' }), dated(codex.task_complete, 300)));
        f.codex(names[1], jl(dated(codex.session_meta, 0), codexMetadata(200, { model: 'new-model', reasoning_effort: 'high' })));
      }
      const state = f.tracker().state();
      assert.equal(state.sessions.length, 1);
      const session = state.sessions[0];
      assert.deepEqual([session.model, session.effort, session.modelObservedAt], ['new-model', 'high', Date.parse(iso(200))]);
      assert.equal(session.lastTs, Date.parse(iso(300)));
      assert.equal(session.exec, client === 'claude' ? 'UNKNOWN' : 'IDLE');
      assert.equal(state.messages.length, 1);
      if (client === 'claude') assert.equal(session.lastText, 'Newest execution snapshot.');
    }
  }
});

test('handwritten metadata: unknown metadata is serialized as explicit null, never inferred from transcript text', () => {
  const f = fixture();
  f.claude('worker', jl(claudeSend('metadata-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join'),
    claudeMetadata(10, { content: '{"model":"claude-injected","output_config":{"effort":"max"}}' }),
    claudeMetadata(20, { model: { name: 'ignored' }, output_config: { effort: ['high'] } })));
  f.codex('worker', jl(dated(codex.session_meta, 0), dated(codex.send, 0),
    { type: 'event_msg', timestamp: iso(10), payload: { type: 'agent_message', message: 'model=gpt-injected reasoning_effort=high' } }));
  const sessions = JSON.parse(JSON.stringify(f.tracker().state())).sessions;
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session.model, null);
    assert.equal(session.effort, null);
    assert.equal(session.modelObservedAt, null);
  }
});

test('herdr: literal Bash, parallel Bash and Codex exec_command require an accepted result before advancing protocol', () => {
  const target = herdr.prompted.result.agent;
  for (const transport of ['Bash', 'parallel', 'exec_command']) {
    for (const [delivery, output] of [['accepted', herdr.prompted], ['failed', herdr.blocked], ['unknown', herdr.timeout]]) {
      const f = fixture();
      const command = "node --version && herdr agent prompt worker-a 'P:wms T:ASSIGN ID:assign FROM:leader TO:worker-a' --wait --until working --timeout 20";
      const call = transport === 'exec_command'
        ? { type: 'response_item', timestamp: iso(10), payload: { type: 'function_call', call_id: 'prompt', name: 'functions.exec_command', arguments: JSON.stringify({ cmd: command }) } }
        : { type: 'assistant', sessionId: 'sender', timestamp: iso(10), message: { content: [{ type: 'tool_use', id: 'prompt',
          name: transport === 'parallel' ? 'multi_tool_use.parallel' : 'Bash',
          input: transport === 'parallel' ? { tool_uses: [{ recipient_name: 'functions.Bash', parameters: { command } }] } : { command } }] } };
      const result = transport === 'exec_command'
        ? { type: 'response_item', timestamp: iso(20), payload: { type: 'function_call_output', call_id: 'prompt', output: JSON.stringify(output) } }
        : { ...claudeResult('sender', 20, 'prompt'), message: { content: [{ type: 'tool_result', tool_use_id: 'prompt', content: [{ type: 'text', text: JSON.stringify(output) }] }] } };
      f.claude('worker', jl(claudeSend(target.agent_session.value, 0, 'join', 'P:wms T:JOIN_REQUEST ID:join FROM:worker-a')));
      const client = transport === 'exec_command' ? 'codex' : 'claude';
      const rows = client === 'codex' ? [{ type: 'session_meta', payload: { id: 'sender' } }, call] : [call];
      f[client]('sender', jl(...rows));
      const tracker = f.tracker();
      const pending = tracker.state();
      assert.equal(pending.messages.find((m) => m.id === 'assign').delivery, 'pending');
      assert.equal(pending.sessions.find((s) => s.id === 'claude:' + target.agent_session.value).proto, 'JOINING');
      f[client]('sender', jl(...rows, result));
      const state = tracker.state(), assignment = state.messages.find((m) => m.id === 'assign');
      assert.equal(assignment.transport, 'herdr');
      assert.equal(assignment.delivery, delivery);
      assert.equal(state.sessions.find((s) => s.id === 'claude:' + target.agent_session.value).proto, delivery === 'accepted' ? 'ASSIGNED' : 'JOINING');
      assert.equal(state.sessions.some((s) => s.id === client + ':sender'), delivery === 'accepted');
      if (delivery === 'accepted') assert.equal(assignment.to, 'claude:' + target.agent_session.value);
    }
  }
});

test('herdr: failed, unknown and pending attempts alone cannot discover a project or create members', () => {
  for (const output of [null, herdr.blocked, herdr.timeout, { result: { type: 'agent_prompted', agent: { ...herdr.prompted.result.agent, name: 'wrong-target' } } }]) {
    const f = fixture();
    const call = claudeSend('sender', 0, 'prompt', 'unused');
    call.message.content[0] = { type: 'tool_use', id: 'prompt', name: 'Bash', input: {
      command: "herdr agent prompt worker-a 'P:attempt-only T:ASSIGN ID:assign FROM:leader'",
    } };
    const rows = [call];
    if (output) rows.push({ ...claudeResult('sender', 10, 'prompt'), message: { content: [{ type: 'tool_result', tool_use_id: 'prompt', content: JSON.stringify(output) }] } });
    f.claude('sender', jl(...rows));
    const state = f.tracker(undefined).state('attempt-only');
    assert.deepEqual(state.availableProjects, []);
    assert.deepEqual(state.sessions, []);
    assert.equal(state.messages.length, 1);
    assert.notEqual(state.messages[0].delivery, 'accepted');
  }
});

test('herdr registry overrides execution by exact client and full session, with its own source timestamp', () => {
  const f = fixture();
  f.claude('worker', jl(claudeSend('full-worker-session', 0, 'join', 'P:wms T:JOIN_REQUEST ID:join FROM:worker-a'),
    claudeResult('full-worker-session', 10, 'join')));
  const snapshot = { status: 'ok', observedAt: T - 1000, agents: [] };
  const tracker = f.tracker('wms', { herdrObserver: { snapshot: () => structuredClone(snapshot) } });
  const agent = { client: 'claude', session: 'full-worker-session', name: 'registry-name', status: 'working' };
  for (const status of ['working', 'idle', 'done', 'blocked']) {
    snapshot.agents = [{ ...agent, status }, { ...agent, session: 'registry-only', name: 'extra' }];
    const state = tracker.state(), worker = state.sessions[0];
    assert.equal(state.sessions.length, 1, 'the registry cannot create project membership');
    assert.equal(worker.name, 'registry-name');
    assert.equal(worker.workerId, 'worker-a');
    assert.equal(worker.exec, { working: 'RUNNING', idle: 'IDLE', done: 'IDLE', blocked: 'BLOCKED' }[status]);
    assert.equal(worker.proto, 'JOINING', 'done is execution evidence, not protocol COMPLETE');
    assert.equal(worker.execSource, 'herdr-observed');
    assert.equal(worker.execObservedAt, snapshot.observedAt);
    assert.equal(worker.lastTs, Date.parse(iso(10)));
    assert.deepEqual(state.observation, { source: 'herdr', status: 'ok', observedAt: snapshot.observedAt, error: null });
  }
  for (const agents of [
    [{ ...agent, session: 'full-worker' }], [{ ...agent, session: 'full-worker-session-extra' }],
    [{ ...agent, client: 'codex' }], [{ ...agent, session: 'other', name: 'worker-a' }],
    [agent, agent], [{ ...agent, status: 'unknown' }],
  ]) {
    snapshot.agents = agents;
    const worker = tracker.state().sessions[0];
    assert.equal(worker.exec, 'UNKNOWN');
    assert.equal(worker.execSource, 'transcript-inferred');
    assert.equal(worker.execObservedAt, Date.parse(iso(10)));
  }
  snapshot.agents = [agent];
  snapshot.observedAt = T - 11000;
  assert.equal(tracker.state().sessions[0].execSource, 'transcript-inferred', 'expired snapshots cannot claim current execution');
  snapshot.observedAt = T + 1;
  assert.equal(tracker.state().sessions[0].execSource, 'transcript-inferred', 'future snapshots cannot claim current execution');
  snapshot.status = 'unavailable';
  snapshot.error = 'fixture: registry offline';
  snapshot.agents = [agent];
  const state = tracker.state();
  assert.equal(state.sessions[0].exec, 'UNKNOWN');
  assert.equal(state.sessions[0].execSource, 'transcript-inferred');
  assert.equal(state.observation.status, 'unavailable');
  assert.equal(state.observation.error, snapshot.error);
});

test('execution without pending tools or explicit active/end turn evidence stays UNKNOWN after results', () => {
  const f = fixture();
  f.claude('worker', jl(claudeSend('claude-worker', 0, 'join', 'P:wms T:JOIN_REQUEST ID:cl'), claudeResult('claude-worker', 10, 'join')));
  f.codex('worker', jl(dated(codex.session_meta, 0), dated(codex.send, 0), dated(codex.send_output, 10)));
  const state = f.tracker().state();
  assert.equal(state.sessions.length, 2);
  for (const session of state.sessions) {
    assert.equal(session.exec, 'UNKNOWN');
    assert.equal(session.execSource, 'transcript-inferred');
  }
  assert.equal(state.observation.status, 'unavailable');
});

test('since: event timestamps exclude old and future messages and project discovery despite fresh file mtimes', () => {
  const f = fixture();
  f.claude('worker', jl(
    claudeSend('worker', -10000, 'old', 'P:old-only T:PING ID:old'),
    claudeSend('worker', -5000, 'boundary', 'P:wms T:PING ID:boundary'),
    claudeSend('worker', 0, 'fresh', 'P:wms T:PING ID:fresh'),
    claudeSend('worker', 6000, 'future', 'P:future-only T:PING ID:future'),
  ));
  f.codex('old', jl(dated(codex.session_meta, -10000), dated(codex.send, -10000)));
  for (const file of [path.join(f.claudeDir, 'proj', 'worker.jsonl'), path.join(f.codexDir, '2026', '10', '17', 'rollout-old.jsonl')]) {
    fs.utimesSync(file, new Date(T), new Date(T));
  }
  const state = f.tracker('wms', { sinceMs: 10000 }).state();
  assert.deepEqual(state.availableProjects, [{ project: 'wms', lastActivity: Date.parse(iso()) }]);
  assert.deepEqual(state.messages.map((m) => m.id), ['boundary', 'fresh']);
  assert.deepEqual(state.sessions.map((s) => s.id), ['claude:worker']);
  const old = f.tracker('old-only', { sinceMs: 10000 }).state();
  assert.deepEqual(old.sessions, []);
  assert.deepEqual(old.messages, []);
});

test('since: historical LEFT baseline survives the window cutoff and late messages cannot revive a member', () => {
  const f = fixture();
  f.claude('worker', jl(
    claudeSend('worker', -20000, 'leave', 'P:wms T:LEAVE_REQUEST ID:leave FROM:worker'),
    claudeSend('worker', 0, 'complete', 'P:wms T:COMPLETE ID:late-complete FROM:worker'),
  ));
  f.claude('leader', jl(
    claudeSend('leader', -19000, 'joined', 'P:wms T:JOIN_ACK ID:joined FROM:leader', 'worker'),
    claudeSend('leader', -18000, 'left', 'P:wms T:LEAVE_ACK ID:left RE:leave FROM:leader', 'worker'),
    claudeSend('leader', 10, 'assign', 'P:wms T:ASSIGN ID:late-assign FROM:leader', 'worker'),
  ));
  const state = f.tracker('wms', { sinceMs: 10000 }).state();
  assert.deepEqual(state.messages.map((m) => m.id), ['late-complete', 'late-assign']);
  const worker = state.sessions.find((s) => s.id === 'claude:worker');
  assert.deepEqual([worker.membership, worker.proto], ['LEFT', 'LEFT']);
  assert.equal(state.sessions.find((s) => s.id === 'claude:leader').role, 'Leader');
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

test('LEAVE_REQUEST alone keeps the Worker active while leaving', () => {
  const f = fixture();
  f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:LEAVE_REQUEST ID:lv1 FROM:fe-01 REF:branch')));
  const st = f.tracker().state();
  assert.equal(st.sessions.length, 1);
  assert.deepEqual([st.sessions[0].membership, st.sessions[0].proto], ['ACTIVE', 'LEAVING']);
  assert.deepEqual(st.messages.map((m) => m.id), ['lv1']);
});

test('Leader LEAVE_ACK retires the requesting Worker and keeps the Leader active, with or without RE', () => {
  for (const reply of [' RE:lv1', '']) {
    const f = fixture();
    f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:LEAVE_REQUEST ID:lv1 FROM:fe-01 REF:branch')));
    f.claude('l1', jl(
      claudeSend('l1', 50, 'u0', 'P:wms T:JOIN_ACK ID:join-ack FROM:leader', 'fe-01'),
      claudeSend('l1', 100, 'u2', 'P:wms T:LEAVE_ACK ID:la1' + reply, 'fe-01'),
    ));
    const st = f.tracker().state();
    const worker = st.sessions.find((s) => s.id === 'claude:w1');
    const leader = st.sessions.find((s) => s.id === 'claude:l1');
    assert.deepEqual([worker.membership, worker.proto], ['LEFT', 'LEFT'], reply);
    assert.deepEqual([leader.role, leader.membership, leader.proto], ['Leader', 'ACTIVE', 'COORDINATING'], reply);
    assert.deepEqual(st.messages.map((m) => m.id), ['lv1', 'join-ack', 'la1']);
    assert.equal(st.messages[2].to, worker.id);
  }
});

test('Worker LEAVE_ACK for RELEASE retires the sender and keeps the Leader active, with or without RE', () => {
  for (const reply of [' RE:release', '']) {
    const f = fixture();
    f.claude('l1', jl(claudeSend('l1', 50, 'u2', 'P:wms T:RELEASE ID:release FROM:leader', 'fe-01')));
    f.claude('w1', jl(
      claudeSend('w1', 0, 'u1', 'P:wms T:JOIN_REQUEST ID:join FROM:fe-01'),
      claudeSend('w1', 100, 'u3', 'P:wms T:LEAVE_ACK ID:la1' + reply),
    ));
    const st = f.tracker().state();
    const worker = st.sessions.find((s) => s.id === 'claude:w1');
    const leader = st.sessions.find((s) => s.id === 'claude:l1');
    assert.deepEqual([worker.membership, worker.proto], ['LEFT', 'LEFT'], reply);
    assert.deepEqual([leader.role, leader.membership, leader.proto], ['Leader', 'ACTIVE', 'COORDINATING'], reply);
    assert.deepEqual(st.messages.map((m) => m.id), ['join', 'release', 'la1']);
    assert.equal(st.messages[2].to, leader.id);
  }
});

test('late COMPLETE and ASSIGN cannot revive a departed Worker; a new JOIN_REQUEST can', () => {
  const f = fixture();
  f.claude('w1', jl(claudeSend('w1', 0, 'u1', 'P:wms T:LEAVE_REQUEST ID:lv1 FROM:fe-01')));
  f.claude('l1', jl(claudeSend('l1', 100, 'u2', 'P:wms T:LEAVE_ACK ID:la1 RE:lv1 FROM:leader', 'fe-01')));
  const tracker = f.tracker();
  const worker = (st) => st.sessions.find((s) => s.id === 'claude:w1');
  const initial = tracker.state();
  assert.deepEqual([worker(initial).membership, worker(initial).proto], ['LEFT', 'LEFT']);
  for (const [file, row] of [
    ['w1', claudeSend('w1', 200, 'u3', 'P:wms T:COMPLETE ID:late-complete')],
    ['l1', claudeSend('l1', 300, 'u4', 'P:wms T:ASSIGN ID:late-assign', 'fe-01')],
  ]) {
    fs.appendFileSync(path.join(f.claudeDir, 'proj', file + '.jsonl'), jl(row));
    const st = tracker.state();
    assert.deepEqual([worker(st).membership, worker(st).proto], ['LEFT', 'LEFT'], row.message.content[0].input.message);
    assert.equal(st.sessions.length, 2, 'departed sessions remain in history');
  }
  const departed = tracker.state();
  assert.deepEqual(departed.messages.map((m) => m.id), ['lv1', 'la1', 'late-complete', 'late-assign']);
  fs.appendFileSync(path.join(f.claudeDir, 'proj', 'w1.jsonl'), jl(
    claudeSend('w1', 400, 'u5', 'P:wms T:JOIN_REQUEST ID:rejoin FROM:fe-01'),
  ));
  const joined = tracker.state();
  assert.deepEqual([worker(joined).membership, worker(joined).proto], ['ACTIVE', 'JOINING']);
  assert.equal(joined.sessions.length, 2);
  assert.deepEqual(joined.messages.slice(0, -1), departed.messages);
  assert.equal(joined.messages.at(-1).id, 'rejoin');
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
    assert.equal(st.sessions[0].exec, 'UNKNOWN');
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

test('teams: discovery uses sent and received envelopes, sorted by latest protocol activity', () => {
  const f = fixture();
  f.claude('sender', jl(
    claudeSend('sender', 0, 'a', 'P:alpha T:PING ID:a'),
    claudeSend('sender', 100, 'b', 'P:beta T:PING ID:b'),
    claudeSend('sender', 100, 'c', 'P:charlie T:PING ID:c'),
    claudeMetadata(400, { content: 'P:example T:PING ID:not-a-message' }),
  ));
  f.claude('receiver', jl({ ...dated(claude.user, 200), message: {
    ...claude.user.message, content: claude.user.message.content.replace('P:wms', 'P:received-only'),
  } }));
  const tracker = f.tracker();
  const auto = createTracker({ claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => T, herdrObserver: unavailableObserver });
  const state = auto.state();
  assert.deepEqual(state.availableProjects, [
    { project: 'received-only', lastActivity: Date.parse(iso(200)) },
    { project: 'beta', lastActivity: Date.parse(iso(100)) },
    { project: 'charlie', lastActivity: Date.parse(iso(100)) },
    { project: 'alpha', lastActivity: Date.parse(iso()) },
  ]);
  assert.equal(state.project, 'received-only');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, 'claude:claude-leader');
  assert.equal(tracker.state().project, 'wms', 'an explicit default wins over latest activity');
  assert.equal(tracker.state('alpha').project, 'alpha', 'per-request selection wins over the default');
});

test('teams: no activity stays empty and explicit teams need not be discovered', () => {
  const f = fixture();
  f.claude('metadata', jl(claudeMetadata(0, { model: 'test-model' })));
  const tracker = createTracker({ claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => T, herdrObserver: unavailableObserver });
  const state = tracker.state();
  assert.equal(state.project, null);
  assert.deepEqual(state.availableProjects, []);
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.messages, []);
  assert.equal(state.ledger.status, 'unavailable');
  for (const selected of [tracker.state('unknown'), f.tracker('default-team').state()]) {
    assert.ok(selected.project);
    assert.deepEqual(selected.availableProjects, []);
    assert.deepEqual(selected.sessions, []);
    assert.deepEqual(selected.messages, []);
  }
});

test('teams: alternating selections isolate membership, routes and identical sender/message IDs', () => {
  const f = fixture();
  f.claude('worker', jl(
    claudeSend('worker', 0, 'a', 'P:alpha T:JOIN_REQUEST ID:shared FROM:worker'),
    claudeSend('worker', 10, 'b', 'P:beta T:JOIN_REQUEST ID:shared FROM:worker'),
  ));
  f.claude('alpha-leader', jl(
    claudeSend('alpha-leader', 20, 'c', 'P:alpha T:JOIN_ACK ID:ack FROM:leader', 'worker'),
    claudeSend('alpha-leader', 30, 'd', 'P:alpha T:LEAVE_ACK ID:left FROM:leader', 'worker'),
  ));
  f.claude('beta-leader', jl(
    claudeSend('beta-leader', 20, 'e', 'P:beta T:ASSIGN ID:ack FROM:leader', 'worker'),
  ));
  const tracker = f.tracker('alpha');
  const alpha = tracker.state(), beta = tracker.state('beta');
  assert.deepEqual(alpha.sessions.map((s) => s.id).sort(), ['claude:alpha-leader', 'claude:worker']);
  assert.deepEqual(beta.sessions.map((s) => s.id).sort(), ['claude:beta-leader', 'claude:worker']);
  assert.equal(alpha.sessions.find((s) => s.id === 'claude:worker').membership, 'LEFT');
  assert.equal(beta.sessions.find((s) => s.id === 'claude:worker').membership, 'ACTIVE');
  assert.equal(beta.sessions.find((s) => s.id === 'claude:worker').proto, 'ASSIGNED');
  assert.deepEqual(alpha.messages.map((m) => m.id), ['shared', 'ack', 'left']);
  assert.deepEqual(beta.messages.map((m) => m.id), ['shared', 'ack']);
  assert.equal(alpha.messages[0].to, 'claude:alpha-leader');
  assert.equal(beta.messages[0].to, 'claude:beta-leader');
  for (const team of ['alpha', 'beta', 'alpha', 'beta']) {
    assert.deepEqual(tracker.state(team), team === 'alpha' ? alpha : beta);
  }
  assert.deepEqual(tracker.state(), alpha, 'requests do not mutate the configured default');
});

test('teams: incremental append and new files discover teams without rebuilding the tracker', () => {
  const f = fixture();
  f.claude('worker', jl(claudeSend('worker', 0, 'a', 'P:alpha T:PING ID:a')));
  const tracker = createTracker({ claudeDir: f.claudeDir, codexDir: f.codexDir, now: () => T, herdrObserver: unavailableObserver });
  const alpha = tracker.state();
  fs.appendFileSync(path.join(f.claudeDir, 'proj', 'worker.jsonl'), jl(
    claudeSend('worker', 100, 'b', 'P:beta T:PING ID:b'),
  ));
  assert.equal(tracker.state().project, 'beta');
  f.codex('new', jl(dated(codex.session_meta, 0), { ...dated(codex.send, 200), payload: {
    ...codex.send.payload, arguments: JSON.stringify({ threadId: 'leader', prompt: 'P:gamma T:JOIN_REQUEST ID:g' }),
  } }));
  const latest = tracker.state();
  assert.equal(latest.project, 'gamma');
  assert.deepEqual(latest.availableProjects.map((p) => p.project), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(latest.messages.map((m) => m.id), ['g']);
  const selectedAlpha = tracker.state('alpha');
  assert.deepEqual(selectedAlpha.sessions.map((s) => [s.id, s.membership, s.proto]),
    alpha.sessions.map((s) => [s.id, s.membership, s.proto]));
  assert.deepEqual(selectedAlpha.messages, alpha.messages);
});

test('teams: ledger directories require one explicit binding and cannot be combined with a repository', () => {
  const f = fixture();
  const ledgerDir = fileURLToPath(new URL('./fixtures/team-dashboard/ledger/', import.meta.url));
  const options = { claudeDir: f.claudeDir, codexDir: f.codexDir, ledgerDir, now: () => T, herdrObserver: unavailableObserver };
  assert.throws(() => createTracker(options), /--ledger-dir requires --project/);
  assert.throws(() => createTracker({ ...options, project: 'wms', ledgerRepo: '.' }), /mutually exclusive/);
  f.claude('other', jl(claudeSend('other', 0, 'a', 'P:other T:PING ID:other')));
  const tracker = createTracker({ ...options, project: 'wms' });
  assert.equal(tracker.state().ledger.status, 'ok');
  const other = tracker.state('other');
  assert.equal(other.ledger.status, 'unavailable');
  assert.deepEqual(other.ledger.tasks, []);
  assert.deepEqual(other.ledger.diagnostics, []);
  assert.match(other.ledger.error, /wms/);
  assert.deepEqual(other.messages.map((m) => m.id), ['other']);
  assert.equal(tracker.state('missing').ledger.status, 'unavailable');
  assert.equal(tracker.state().ledger.status, 'ok', 'switching back restores the bound directory');
});

test('HTTP team queries are independent, allow undiscovered teams and reject invalid selections', async () => {
  const f = fixture();
  f.claude('alpha', jl(claudeSend('alpha', 0, 'a', 'P:alpha T:PING ID:a')));
  f.claude('beta', jl(claudeSend('beta', 100, 'b', 'P:beta T:PING ID:b')));
  const server = createServer(f.tracker('alpha'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/state`;
  const get = async (query = '') => {
    const response = await fetch(url + query);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const [beta, alpha, empty] = await Promise.all([get('?project=beta'), get(), get('?project=missing')]);
    assert.equal(beta.project, 'beta');
    assert.deepEqual(beta.messages.map((m) => m.id), ['b']);
    assert.equal(alpha.project, 'alpha');
    assert.deepEqual(alpha.messages.map((m) => m.id), ['a']);
    assert.equal(empty.project, 'missing');
    assert.deepEqual(empty.sessions, []);
    assert.deepEqual(empty.messages, []);
    assert.deepEqual((await get()).messages, alpha.messages);
    for (const invalid of ['', '\0', '\n', '\x1f', '\x7f', 'x'.repeat(201)]) {
      const response = await fetch(url + '?project=' + encodeURIComponent(invalid));
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match((await response.json()).error, /Invalid team name/);
    }
    assert.equal((await get('?project=' + 'x'.repeat(200))).project.length, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
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
  const tracker = createTracker({ project: 'wms', claudeDir: f.claudeDir, codexDir: f.codexDir, ledgerDir, now: () => T, herdrObserver: unavailableObserver });
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
  const tracker = createTracker({ project: 'wms', claudeDir: f.claudeDir, codexDir: f.codexDir, ledgerRepo, now: () => T, herdrObserver: unavailableObserver });
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
    const rules = runInNewContext(vendor.body + '\n' + script.slice(start, end) + '; ({ d3, matchingMessages, activeSessions, counts, attentionSessions, avatar, esc, messageKey, newMessages, communicationGraph, forceLayout, curvePath, edgeType, edgeState, cardState, taskColumns })', context);
    assert.equal(rules.d3.version, '7.9.0');
    await t.test('task board groups exact ledger statuses and retains unknown statuses', () => {
      const tasks = [{ id: 'a', status: 'ASSIGNED' }, { id: 'b', status: 'DONE' }, { id: 'c', status: 'CUSTOM' }, { id: 'd', status: 'ASSIGNED' }];
      const columns = rules.taskColumns(tasks);
      assert.deepEqual(Array.from(columns, (c) => c.id), ['QUEUED', 'ASSIGNED', 'REVIEW_PENDING', 'PAUSED', 'DONE', 'STOPPED', 'CUSTOM']);
      assert.deepEqual(Array.from(columns.find((c) => c.id === 'ASSIGNED').tasks, (t) => t.id), ['a', 'd']);
      assert.equal(columns.reduce((n, c) => n + c.tasks.length, 0), tasks.length);
      assert.equal(rules.taskColumns([]).length, 6);
    });
    await t.test('clearing graph focus resets both ledger selections without changing search or viewport', () => {
      const start = script.indexOf('function clearGraphFocus('), end = script.indexOf("$('#clearGraphFocus').onclick", start);
      let rendered = 0, highlighted = 'worker', focused = 0;
      const state = { sessions: [], messages: [] };
      const context = {
        selectedTaskId: 'WP-17', ledgerWorkerId: 'worker', lastState: state,
        renderLedger(st) { assert.equal(st, state); rendered++; },
        highlightGraph(id) { highlighted = id; },
        $(selector) { assert.equal(selector, '#liveScroll'); return { focus(options) { assert.equal(options.preventScroll, true); focused++; } }; },
      };
      const clear = runInNewContext(script.slice(start, end) + '; clearGraphFocus', context);
      clear(); clear();
      assert.equal(context.selectedTaskId, null);
      assert.equal(context.ledgerWorkerId, null);
      assert.equal(highlighted, null);
      assert.equal(rendered, 2);
      assert.equal(focused, 2);
      assert.doesNotMatch(script.slice(start, end), /fitGraph|zoomBehavior|\.value\s*=/);
    });
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

    await t.test('active sessions exclude membership and legacy protocol LEFT, preserving STALE and COMPLETE history', () => {
      const sessions = [
        { id: 'leaving', membership: 'ACTIVE', exec: 'RUNNING', proto: 'LEAVING' },
        { id: 'stale', membership: 'ACTIVE', exec: 'STALE', proto: 'COMPLETE' },
        { id: 'complete', exec: 'IDLE', proto: 'COMPLETE' },
        { id: 'left', membership: 'LEFT', exec: 'RUNNING', proto: 'BLOCKED' },
        { id: 'left-stale', membership: 'LEFT', exec: 'STALE', proto: 'COMPLETE' },
        { id: 'legacy-left', exec: 'STALE', proto: 'LEFT' },
      ];
      const messages = sessions.map((s) => ({ id: s.id, from: s.id, to: 'leaving', type: 'COMPLETE' }));
      const before = JSON.stringify({ sessions, messages });
      const active = rules.activeSessions(sessions);
      assert.deepEqual(Array.from(active, (s) => s.id), ['leaving', 'stale', 'complete']);
      assert.equal(active[0], sessions[0]);
      assert.deepEqual({ ...rules.counts(sessions) }, { total: 3, running: 1, blocked: 0, stale: 1 });
      assert.deepEqual(Array.from(rules.attentionSessions(sessions), (s) => s.id), ['stale']);
      assert.deepEqual(Array.from(rules.matchingMessages(messages, '', 'left', '')), [messages[3]]);
      assert.deepEqual(Array.from(rules.matchingMessages(messages, '', '', '')), messages);
      assert.equal(JSON.stringify({ sessions, messages }), before, 'display filters retain the full history');
      assert.deepEqual(Array.from(rules.activeSessions([])), []);
    });

    await t.test('member rendering hides departed members and returns from empty on rejoin without mutating history', () => {
      const renderStart = script.indexOf('function renderMembers('), renderEnd = script.indexOf('\nfunction renderAttention(', renderStart);
      assert.ok(renderStart >= 0 && renderEnd > renderStart);
      const elements = new Map(), text = new Map();
      let rendered;
      const context = {
        scope: 'all', rows: new Map(),
        activeSessions: rules.activeSessions,
        $(selector) { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); },
        setText(selector, value) { text.set(selector, value); },
        keyed(container, rows, list) { rendered = Array.from(list, (s) => s.id); },
      };
      const renderMembers = runInNewContext(script.slice(start, end) + '\n' + script.slice(renderStart, renderEnd) + '; renderMembers', context);
      const sessions = [
        { id: 'worker', name: 'worker', membership: 'ACTIVE', proto: 'LEAVING' },
        { id: 'legacy', name: 'legacy', proto: 'LEFT' },
      ];
      const state = { sessions, messages: [{ id: 'leave', from: 'worker', to: 'legacy' }] };
      renderMembers(state);
      assert.deepEqual(rendered, ['worker']);
      assert.equal(text.get('#memberCount'), '1 / 1');
      sessions[0].membership = 'LEFT';
      renderMembers(state);
      assert.deepEqual(rendered, []);
      assert.equal(text.get('#memberCount'), '0 / 0');
      assert.equal(elements.get('#membersEmpty').hidden, false);
      assert.match(text.get('#membersEmpty'), /当前项目暂无团队活动/);
      Object.assign(sessions[0], { membership: 'ACTIVE', proto: 'JOINING' });
      renderMembers(state);
      assert.deepEqual(rendered, ['worker']);
      assert.equal(text.get('#memberCount'), '1 / 1');
      assert.equal(elements.get('#membersEmpty').hidden, true);
      assert.equal(state.sessions, sessions);
      assert.equal(state.sessions.length, 2);
      assert.equal(state.messages.length, 1);
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

    await t.test('departed members and incident edges disappear from previous graphs; all-left is empty and rejoin returns', () => {
      const sessions = [
        { id: 'a', membership: 'ACTIVE', exec: 'STALE', proto: 'COMPLETE' },
        { id: 'b', membership: 'ACTIVE', exec: 'RUNNING', proto: 'LEAVING' },
        { id: 'c', exec: 'IDLE', proto: 'COMPLETE' },
      ];
      const messages = completeLinks(sessions);
      const history = JSON.stringify(messages);
      const previous = rules.communicationGraph(sessions, messages);
      const before = graphSnapshot(previous);
      assert.deepEqual(Array.from(previous.order), ['a', 'b', 'c']);
      assert.equal(previous.edges.size, 3);
      const departed = sessions.map((s) => s.id === 'b' ? { ...s, membership: 'LEFT' } : s);
      const graph = rules.communicationGraph(departed, messages, previous);
      assert.deepEqual(Array.from(graph.order), ['a', 'c']);
      assert.deepEqual(Array.from(graph.adj.keys()), ['a', 'c']);
      assert.deepEqual(Array.from(graph.edges.keys()), ['["a","c"]']);
      assert.deepEqual(Array.from(graph.adj.get('a')), ['c']);
      assert.deepEqual(Array.from(graph.adj.get('c')), ['a']);
      const allLeft = departed.map((s) => ({ ...s, membership: 'LEFT' }));
      const empty = rules.communicationGraph(allLeft, messages, graph);
      assert.deepEqual(Array.from(empty.order), []);
      assert.equal(empty.adj.size, 0);
      assert.equal(empty.edges.size, 0);
      assert.deepEqual({ ...rules.counts(allLeft) }, { total: 0, running: 0, blocked: 0, stale: 0 });
      assert.deepEqual(Array.from(rules.attentionSessions(allLeft)), []);
      const rejoined = allLeft.map((s) => s.id === 'b' ? { ...s, membership: 'ACTIVE', proto: 'JOINING' } : s);
      const joined = rules.communicationGraph(rejoined, messages, empty);
      assert.deepEqual(Array.from(joined.order), ['b']);
      assert.deepEqual(Array.from(joined.adj.keys()), ['b']);
      assert.equal(joined.adj.get('b').size, 0);
      assert.equal(joined.edges.size, 0, 'historical peers cannot return through old messages');
      assert.deepEqual({ ...rules.counts(rejoined) }, { total: 1, running: 1, blocked: 0, stale: 0 });
      assert.deepEqual(graphSnapshot(previous), before, 'the previous graph remains intact');
      assert.equal(JSON.stringify(messages), history);
      assert.equal(allLeft.length, 3, 'all departed sessions remain available as history');
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

    await t.test('polling generations ignore old success, catch and finally after switching teams', async (t) => {
      const tickStart = script.indexOf('async function tick('), tickEnd = script.indexOf("$('#pause').onclick", tickStart);
      for (const outcome of ['success', 'failure']) {
        for (const newFinished of [false, true]) {
          await t.test(outcome + (newFinished ? ' after new response' : ' during new request'), async () => {
            const requests = [], timers = new Map(), rendered = [];
            let connections = 0, nextTimer = 0;
            const previous = { project: 'alpha', sessions: [], messages: [] };
            const current = { project: 'beta / 中文', sessions: [], messages: [] };
            const context = {
              inFlight: false, paused: false, demo: false, document: { hidden: false },
              lastState: previous, lastSuccess: 1, connectionError: '',
              requestGeneration: 0, selectedProject: 'alpha', requestController: null, AbortController,
              setTimeout(fn, ms) { assert.equal(ms, 10000); timers.set(++nextTimer, fn); return nextTimer; },
              clearTimeout(id) { timers.delete(id); },
              renderConnection() { connections++; },
              render(state) { rendered.push(state); context.lastState = state; },
              fetch(url, options) {
                return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
              },
            };
            const tick = runInNewContext(script.slice(tickStart, tickEnd) + '; tick', context);
            const oldPending = tick(false), oldController = context.requestController;
            context.requestGeneration++;
            oldController.abort();
            context.inFlight = false;
            context.selectedProject = current.project;
            const newPending = tick(true), newController = context.requestController;
            assert.equal(requests[0].options.signal.aborted, true);
            assert.equal(requests[1].url, '/api/state?project=' + encodeURIComponent(current.project));
            assert.equal(requests[1].options.signal, newController.signal);
            assert.equal(timers.size, 2);
            if (newFinished) {
              requests[1].resolve({ ok: true, json: async () => current });
              await newPending;
            }
            const before = {
              state: context.lastState, success: context.lastSuccess, error: context.connectionError,
              inFlight: context.inFlight, controller: context.requestController, connections,
            };
            if (outcome === 'success') requests[0].resolve({ ok: true, json: async () => previous });
            else requests[0].reject(new Error('old request failed'));
            await oldPending;
            assert.equal(context.lastState, before.state);
            assert.equal(context.lastSuccess, before.success);
            assert.equal(context.connectionError, before.error);
            assert.equal(context.inFlight, before.inFlight);
            assert.equal(context.requestController, before.controller);
            assert.equal(connections, before.connections, 'old finally cannot update connection UI');
            assert.equal(timers.size, newFinished ? 0 : 1, 'old finally clears only its own timer');
            if (!newFinished) {
              assert.equal(context.requestController, newController);
              assert.equal(newController.signal.aborted, false);
              requests[1].resolve({ ok: true, json: async () => current });
              await newPending;
            }
            assert.deepEqual(rendered, [current]);
            assert.equal(context.lastState, current);
            assert.equal(context.inFlight, false);
            assert.equal(context.requestController, null);
            assert.equal(timers.size, 0);
          });
        }
      }
    });

    await t.test('polling deduplicates requests, retains state on failure and respects pause', async () => {
      const tickStart = script.indexOf('async function tick('), tickEnd = script.indexOf("$('#pause').onclick", tickStart);
      assert.ok(tickStart >= 0 && tickEnd > tickStart);
      let requests = 0, finish;
      const state = { sessions: [{ id: 'a' }], messages: [] };
      const context = {
        inFlight: false, paused: false, demo: false, document: { hidden: false },
        lastState: null, lastSuccess: 0, connectionError: '',
        requestGeneration: 0, selectedProject: null, requestController: null, AbortController, setTimeout, clearTimeout,
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
