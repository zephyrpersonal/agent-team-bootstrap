import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHerdrCommand, parseHerdrResult, createHerdrObserver } from './team-herdr.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/team-dashboard/herdr.json', import.meta.url), 'utf8'));
const body = 'P:demo T:ASSIGN ID:1 FROM:leader TO:worker-a task';
const command = (message = body, to = 'worker-a') => `herdr agent prompt ${to} '${message}' --wait --until working --timeout 2000`;
const expected = { client: 'claude', session: '11111111-1111-4111-8111-111111111111', name: 'worker-a', paneId: 'wExample:p1' };
const json = JSON.stringify;

test('parses only top-level herdr segments and preserves single-quoted body', () => {
  assert.deepEqual(parseHerdrCommand(command()), [{ to: 'worker-a', body }]);
  assert.deepEqual(parseHerdrCommand(`python3 -I -c 's="example"; print(len(s))'; ${command()}; git status --short`), [{ to: 'worker-a', body }]);
  assert.deepEqual(parseHerdrCommand(`${command()};`), [{ to: 'worker-a', body }]);
  const yaml = 'protocol: agent-team/native\nproject: demo\ntype: ASSIGN\nfrom: leader\nto: worker-a';
  assert.deepEqual(parseHerdrCommand(command(yaml)), [{ to: 'worker-a', body: yaml }]);
  assert.deepEqual(parseHerdrCommand(`node -e 'console.log(600)' && ${command()} && python3 -c 'print(1)'`), [{ to: 'worker-a', body }]);
  assert.deepEqual(parseHerdrCommand(`${command()} && ${command(body, 'worker-b')}`), [{ to: 'worker-a', body }, { to: 'worker-b', body }]);
  assert.deepEqual(parseHerdrCommand(`herdr agent prompt worker-a '${body}' --until blocked --until working --wait`), [{ to: 'worker-a', body }]);
  const literal = `${body} $HOME $(id) \`id\` | > # && ;`;
  assert.deepEqual(parseHerdrCommand(command(literal)), [{ to: 'worker-a', body: literal }]);
});

test('quoted echo and interpreter scripts are never mined for commands', () => {
  for (const input of [
    `echo "${command()}"`,
    `node -e "console.log(\"herdr agent prompt worker-a '${body}'\")"`,
    `python3 -c "print(\"herdr agent prompt worker-a '${body}'\")"`,
    `printf '%s' "${command()}"`,
    `not-herdr agent prompt worker-a '${body}'`,
    `env herdr agent prompt worker-a '${body}'`,
    `echo 'one && herdr agent prompt worker-a text'`,
  ]) assert.deepEqual(parseHerdrCommand(input), [], input);
});

test('rejects interpolation, shell controls, heredocs, comments and ambiguous chains', () => {
  for (const input of [
    `$(echo herdr) agent prompt worker-a '${body}'`,
    `herdr agent prompt $TARGET '${body}'`,
    `herdr agent prompt worker-* '${body}'`,
    `herdr agent prompt worker-? '${body}'`,
    `herdr agent prompt worker-a "${body} $HOME"`,
    `herdr agent prompt worker-a "${body}"`,
    `herdr agent prompt worker-a '${body}'extra`,
    `herdr agent prompt worker-a '${body}'' more'`,
    `herdr agent prompt worker-a '${body}`,
    `herdr agent prompt worker-a '${body}' | cat`,
    `${command()} > file`, `${command()} 2>&1`,
    `${command()}\necho ok`, `${command()} # comment`,
    `(${command()})`, `{ ${command()}; }`,
    `cat <<'EOF'\n${command()}\nEOF`,
    `false && ${command()}`, `if true && ${command()}`, `! true && ${command()}`,
    `[[ -f absent ]] && ${command()}`, `coproc ${command()} && echo done`,
    `true || ${command()}`, `&& ${command()}`, `${command()} &&`,
    `herdr --machine remote agent prompt worker-a '${body}'`,
    `herdr agent prompt worker-a '${body}' --timeout nope`,
    `herdr agent prompt worker-a '${body}' --until idle`,
    `herdr agent prompt worker-a '${body}' --wait --wait`,
    `herdr agent prompt worker-a '${body}' --unknown`,
    command().replace('herdr', 'herdr\u0000'),
  ]) assert.deepEqual(parseHerdrCommand(input), [], input);
});

test('candidate envelope gate and byte limits do not drop over-budget messages', () => {
  for (const input of [null, {}, '', command('hello'), command('P:demo T:ASSIGN'), command('prefix ' + body), command('protocol: native\nproject: demo')]) {
    assert.deepEqual(parseHerdrCommand(input), []);
  }
  const large = `${body} ${'字'.repeat(300)}`;
  assert.ok(Buffer.byteLength(large) > 600);
  assert.deepEqual(parseHerdrCommand(command(large)), [{ to: 'worker-a', body: large }]);
  assert.deepEqual(parseHerdrCommand(command('P:x FROM:a ' + '字'.repeat(22000))), []);
  const base = command();
  assert.equal(parseHerdrCommand(base + ' '.repeat(65536 - Buffer.byteLength(base))).length, 1);
  assert.deepEqual(parseHerdrCommand(base + ' '.repeat(65537 - Buffer.byteLength(base))), []);
});

test('only JSON result agent_prompted proves acceptance, not ACK', () => {
  assert.deepEqual(parseHerdrResult(json(fixture.prompted), false), { delivery: 'accepted', agents: [expected] });
  assert.deepEqual(parseHerdrResult([{ type: 'text', text: json(fixture.prompted) }]), { delivery: 'accepted', agents: [expected] });
  const other = structuredClone(fixture.prompted);
  other.result.agent = fixture.registry.result.agents[1];
  const result = parseHerdrResult(json(fixture.prompted) + '\n' + json(other));
  assert.equal(result.delivery, 'accepted');
  assert.deepEqual(result.agents.map((agent) => agent.name), ['worker-a', 'worker-b']);
  for (const input of ['agent_prompted', `echo '${json(fixture.prompted)}'`, json({ result: { type: 'agent_list', agents: [fixture.prompted.result.agent] } }), JSON.stringify(fixture.prompted, null, 2)]) {
    assert.deepEqual(parseHerdrResult(input), { delivery: 'unknown', agents: [] });
  }
});

test('explicit errors fail, timeouts remain unknown, accepted remains accepted', () => {
  assert.deepEqual(parseHerdrResult(json(fixture.blocked)), { delivery: 'failed', agents: [], error: 'agent_blocked: Agent is blocked' });
  assert.equal(parseHerdrResult(json(fixture.timeout), true).delivery, 'unknown');
  assert.equal(parseHerdrResult('Timed out waiting for command', true).delivery, 'unknown');
  assert.equal(parseHerdrResult('command not found', true).delivery, 'failed');
  assert.equal(parseHerdrResult('command not found', false).delivery, 'unknown');
  assert.equal(parseHerdrResult(json(fixture.prompted) + '\n' + json(fixture.timeout), true).delivery, 'accepted');
  for (const input of [null, {}, 'x'.repeat(65537), [{ type: 'text', text: '字'.repeat(22000) }]]) {
    assert.deepEqual(parseHerdrResult(input, true), { delivery: 'unknown', agents: [] });
  }
  assert.deepEqual(parseHerdrResult([{ type: 'image', text: json(fixture.prompted) }]), { delivery: 'unknown', agents: [] });
});

test('identity normalization never invents sessions or falls back to titles', () => {
  for (const patch of [{ agent_session: null }, { agent_session: { kind: 'prefix', value: '1111' } }, { agent: 'unknown' }, { pane_id: '' }]) {
    const row = structuredClone(fixture.prompted);
    Object.assign(row.result.agent, patch);
    assert.deepEqual(parseHerdrResult(json(row)), { delivery: 'accepted', agents: [] });
  }
  const row = structuredClone(fixture.prompted);
  delete row.result.agent.name;
  row.result.agent.terminal_title = 'not-a-name';
  assert.equal(parseHerdrResult(json(row)).agents[0].name, null);
});

test('observer uses local read-only execFile arguments, real schema and five-second cache', () => {
  let time = 100, calls = 0;
  const observer = createHerdrObserver({ now: () => time, run(file, args, options) {
    calls++;
    assert.equal(file, 'herdr');
    assert.deepEqual(args, ['agent', 'list']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    return json(fixture.registry);
  } });
  const first = observer.snapshot();
  assert.deepEqual(first, { status: 'ok', observedAt: 100, agents: [{ ...expected, status: 'working' }, {
    client: 'codex', session: '22222222-2222-4222-8222-222222222222', name: 'worker-b', paneId: 'wExample:p2', status: 'blocked',
  }] });
  first.agents[0].session = 'mutated';
  time = 5099;
  assert.equal(observer.snapshot().agents[0].session, expected.session);
  assert.equal(calls, 1);
  time = 5100;
  assert.equal(observer.snapshot().observedAt, 5100);
  assert.equal(calls, 2);
});

test('failed refresh replaces stale success and is cached briefly before recovery', () => {
  let time = 0, calls = 0;
  const observer = createHerdrObserver({ now: () => time, run() {
    calls++;
    if (calls === 2) throw new Error('ENOENT');
    return Buffer.from(json(fixture.registry));
  } });
  assert.equal(observer.snapshot().status, 'ok');
  time = 5000;
  assert.deepEqual(observer.snapshot(), { status: 'unavailable', observedAt: 5000, agents: [], error: 'ENOENT' });
  time = 9999;
  assert.equal(observer.snapshot().status, 'unavailable');
  assert.equal(calls, 2);
  time = 10000;
  assert.equal(observer.snapshot().status, 'ok');
  assert.equal(calls, 3);
});

test('observer rejects malformed registries and ignores unjoinable identities', () => {
  for (const output of ['not JSON', '[]', '{}', json({ agents: [] }), json({ result: { type: 'agent_prompted', agents: [] } }), json({ result: { type: 'agent_list', agents: {} } }), 'x'.repeat(1024 * 1024 + 1), undefined]) {
    const observer = createHerdrObserver({ run: () => output });
    assert.equal(observer.snapshot().status, 'unavailable');
    assert.deepEqual(observer.snapshot().agents, []);
  }
  const registry = structuredClone(fixture.registry);
  registry.result.agents[0].agent_session.kind = 'unknown';
  registry.result.agents[1].agent = 'unknown';
  assert.deepEqual(createHerdrObserver({ run: () => json(registry) }).snapshot().agents, []);
});
