import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createLedgerReader } from './team-ledger.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/team-dashboard/ledger/', import.meta.url));
const plan = '| id | title | owner | status | reviewer |\n|---|---|---|---|---|\n| 1 | Build | worker | ASSIGNED | reviewer |\n';
const roster = '| id | agent kind | session | address |\n|---|---|---|---|\n| worker | Claude Code | full-session | machine/worker |\n| reviewer | Codex | codex:review-session | machine/reviewer |\n';
const sessions = [{ id: 'claude:full-session', client: 'claude', name: 'not-worker' }, { id: 'codex:review-session', client: 'codex' }];
function fixture(t, contents = { 'plan.md': plan, 'roster.md': roster }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  for (const [name, text] of Object.entries(contents)) write(name, text);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { dir, write, git, read: (observed = sessions) => createLedgerReader({ project: 'demo', ledgerDir: dir }).read(observed, 1234) };
}
function repository(t) {
  const f = fixture(t);
  f.git('init', '-b', 'main');
  f.git('config', 'user.email', 'ledger-test@example.invalid');
  f.git('config', 'user.name', 'Ledger test');
  f.git('config', 'commit.gpgsign', 'false');
  f.git('add', '.');
  f.git('commit', '-m', 'ledger');
  f.sha = f.git('rev-parse', 'HEAD');
  f.reader = () => createLedgerReader({ project: 'demo', ledgerRepo: f.dir }).read(sessions, 1234);
  return f;
}

test('directory fixture preserves canonical fields, raw cells and exact links', () => {
  const result = createLedgerReader({ project: 'demo', ledgerDir: fixtures }).read([
    { id: 'claude:claude-worker', client: 'claude' }, { id: 'codex:codex-worker', client: 'codex' },
  ], 1234);
  assert.deepEqual([result.status, result.source, result.sourcePath, result.ref, result.commit, result.updatedAt], ['ok', 'directory', fixtures.replace(/\/$/, ''), null, null, 1234]);
  const task = result.tasks[0];
  assert.deepEqual([task.id, task.title, task.status, task.mission, task.priority, task.owner, task.reviewer], ['17', 'Read the team ledger', 'ASSIGNED', 'dashboard', 'P1', 'backend-01', 'qa-01']);
  assert.deepEqual([task.dependsOn, task.parallelGroup, task.due, task.receipts], [[], 'readers', '2026-10-20T12:00:00Z', ['assign-17', 'ack-17']]);
  assert.deepEqual([task.ownerSessionId, task.reviewerSessionId, task.ownerLink, task.reviewerLink], ['claude:claude-worker', 'codex:codex-worker', 'matched', 'matched']);
  assert.match(task.ownerLinkReason, /Exact/);
  assert.equal(task.raw['receipt IDs'], 'assign-17, ack-17');
  assert.deepEqual(result.tasks[1].dependsOn, ['17']);
  assert.equal(result.tasks[2].ownerSessionId, null);
  assert.equal(result.tasks[2].ownerLink, 'unmatched');
});

test('git picks local branch before remote and reads the same committed SHA without checkout or writes', (t) => {
  const f = repository(t);
  f.git('update-ref', 'refs/remotes/origin/team/demo', f.sha);
  f.write('plan.md', plan.replace('Build', 'Local committed'));
  f.git('add', 'plan.md'); f.git('commit', '-m', 'local ledger');
  const local = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/heads/team/demo', local);
  f.write('plan.md', plan.replace('Build', 'Uncommitted'));
  f.write('roster.md', roster.replace('full-session', 'uncommitted-session'));
  const status = f.git('status', '--porcelain=v1'), head = f.git('symbolic-ref', 'HEAD');
  const beforeIndex = fs.readFileSync(path.join(f.dir, '.git', 'index'));
  const result = f.reader();
  assert.deepEqual([result.status, result.source, result.ref, result.commit, result.tasks[0].title], ['ok', 'git', 'refs/heads/team/demo', local, 'Local committed']);
  assert.equal(result.tasks[0].ownerLink, 'matched');
  assert.equal(f.git('status', '--porcelain=v1'), status);
  assert.equal(f.git('symbolic-ref', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, '.git', 'index')), beforeIndex);
  assert.match(fs.readFileSync(path.join(f.dir, 'plan.md'), 'utf8'), /Uncommitted/);
  assert.equal(fs.existsSync(path.join(f.dir, '.git', 'FETCH_HEAD')), false);
  f.git('update-ref', '-d', 'refs/heads/team/demo');
  const remote = f.reader();
  assert.deepEqual([remote.status, remote.ref, remote.commit, remote.tasks[0].title], ['ok', 'refs/remotes/origin/team/demo', f.sha, 'Build']);
});

test('missing git, repository, branch and directory are unavailable', (t) => {
  const f = fixture(t);
  assert.equal(createLedgerReader({ project: 'demo', ledgerRepo: f.dir }).read().status, 'unavailable');
  assert.equal(createLedgerReader({ project: 'demo', ledgerDir: path.join(f.dir, 'absent') }).read().status, 'unavailable');
  const repo = repository(t);
  assert.equal(repo.reader().status, 'unavailable');
  const moduleURL = new URL('./team-ledger.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import {createLedgerReader} from ${JSON.stringify(moduleURL)}; console.log(createLedgerReader({project:'demo'}).read().status)`], { env: { ...process.env, PATH: f.dir }, encoding: 'utf8' });
  assert.equal(output.trim(), 'unavailable');
});

test('configuration and project ref validation fail closed', (t) => {
  const f = fixture(t);
  for (const project of ['', '-x', '../x', 'x..y', 'x.lock', 'x/.hidden', 'x//y', 'x/', 'x@{y}', 'x:y', 'x\ny', 'x\\y']) {
    assert.equal(createLedgerReader({ project, ledgerRepo: f.dir }).read().status, 'error', project);
  }
  assert.equal(createLedgerReader({ project: 'demo', ledgerDir: f.dir, ledgerRepo: f.dir }).read().status, 'error');
  assert.equal(createLedgerReader({ project: 'demo', ledgerDir: null }).read().status, 'error');
  assert.equal(createLedgerReader({ project: 'demo', ledgerRepo: 123 }).read().status, 'error');
});

test('explicit empty tables are ok; fenced examples cannot become tables', (t) => {
  const f = fixture(t);
  f.write('plan.md', '```markdown\n' + plan + '```\n\n| task_id | title | status | owner |\n|---|---|---|---|\n');
  f.write('roster.md', '~~~md\n' + roster + '~~~\n\n| id | agent_kind | session_id |\n|---|---|---|\n');
  assert.deepEqual([f.read().status, f.read().tasks], ['ok', []]);
  f.write('plan.md', '```markdown\n' + plan + '```\n');
  assert.match(f.read().error, /no supported Markdown table/);
});

test('missing/unsupported headers and malformed rows are errors, not empty success', (t) => {
  const f = fixture(t);
  for (const text of [plan.replace('owner', 'assignee'), plan.replace(' | reviewer', ''), plan.replace('| Build |', '| Build | extra |'), plan.replace('| 1 |', '| |'), plan.replace('| worker |', '| |'), plan.replace('status', 'owner'), plan.replace('owner', '__proto__'), 'Nothing here']) {
    f.write('plan.md', text);
    assert.equal(f.read().status, 'error', text);
  }
  f.write('plan.md', plan);
  f.write('roster.md', '| id | agent kind |\n|---|---|\n');
  const result = f.read();
  assert.equal(result.status, 'error');
  assert.equal(result.tasks[0].title, 'Build');
  assert.equal(result.tasks[0].ownerLink, 'unmatched');
});

test('unknown statuses and duplicate IDs are retained with diagnostics', (t) => {
  const f = fixture(t);
  f.write('plan.md', plan.replace('ASSIGNED', 'WAITING_FOR_MAGIC') + '| 1 | Again | worker | DONE | reviewer |\n');
  f.write('roster.md', roster.replace('address |', 'address | state |').replace('|---|---|---|---|', '|---|---|---|---|---|').replace('machine/worker |', 'machine/worker | UNKNOWN |').replace('machine/reviewer |', 'machine/reviewer | ACTIVE |'));
  const result = f.read();
  assert.equal(result.status, 'ok');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].status, 'WAITING_FOR_MAGIC');
  assert.deepEqual(result.diagnostics.map((d) => d.code), ['unknown-status', 'duplicate-id', 'unknown-status']);
});

test('missing roster preserves parsed tasks for both sources', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'roster.md'));
  assert.deepEqual([f.read().status, f.read().tasks[0].ownerLink], ['error', 'unmatched']);
  const repo = repository(t);
  repo.git('rm', 'roster.md'); repo.git('commit', '-m', 'missing roster');
  repo.git('update-ref', 'refs/heads/team/demo', repo.git('rev-parse', 'HEAD'));
  assert.deepEqual([repo.reader().status, repo.reader().tasks[0].ownerSessionId], ['error', null]);
});

test('directory reads only fixed files, rejects escaped symlinks, non-files and oversized content', (t) => {
  const f = fixture(t), outside = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'plan.md'));
  fs.symlinkSync(path.join(outside.dir, 'plan.md'), path.join(f.dir, 'plan.md'));
  assert.match(f.read().error, /symlink escapes/);
  fs.unlinkSync(path.join(f.dir, 'plan.md'));
  fs.mkdirSync(path.join(f.dir, 'plan.md'));
  assert.match(f.read().error, /not a regular file/);
  fs.rmdirSync(path.join(f.dir, 'plan.md'));
  f.write('plan.md', 'x'.repeat(1024 * 1024 + 1));
  assert.match(f.read().error, /1 MiB/);
  const originalStat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd) => ({ ...originalStat(fd), isFile: () => true, size: 0 }));
  assert.match(f.read().error, /1 MiB/); // Growth after the size check remains bounded.
  t.mock.restoreAll();
  f.write('inside.md', plan);
  fs.unlinkSync(path.join(f.dir, 'plan.md'));
  fs.symlinkSync(path.join(f.dir, 'inside.md'), path.join(f.dir, 'plan.md'));
  assert.equal(f.read().status, 'ok');
});

test('oversized Git blobs are errors and Git failures do not masquerade as absent branches', (t) => {
  const f = repository(t);
  f.write('plan.md', 'x'.repeat(2 * 1024 * 1024));
  f.git('add', '.'); f.git('commit', '-m', 'oversized');
  f.git('update-ref', 'refs/heads/team/demo', f.git('rev-parse', 'HEAD'));
  assert.equal(f.reader().status, 'error');
  fs.writeFileSync(path.join(f.dir, '.git', 'refs', 'heads', 'team', 'demo'), 'broken-ref\n');
  assert.equal(f.reader().status, 'error');
});

test('identity matches aliases and exact addresses but never names, prefixes or the other client', (t) => {
  const f = fixture(t);
  f.write('plan.md', plan.replace('| worker |', '| machine/worker |'));
  assert.equal(f.read().tasks[0].ownerLink, 'matched');
  f.write('roster.md', roster.replace('Claude Code', 'claude').replace('full-session |', 'claude:full-session |'));
  assert.equal(f.read().tasks[0].ownerSessionId, 'claude:full-session');
  for (const observed of [
    [{ id: 'codex:full-session', client: 'codex', name: 'worker' }],
    [{ id: 'claude:full-session-longer', client: 'claude', name: 'worker' }],
    [{ id: 'claude:full', client: 'claude', name: 'worker' }],
    [{ id: 'claude:full-session', client: 'codex', name: 'worker' }],
  ]) assert.equal(f.read(observed).tasks[0].ownerLink, 'unmatched');
  for (const text of [roster.replace('full-session', 'codex:full-session'), roster.replace('Claude Code', 'Gemini'), roster.replace('full-session', ''), roster.replace('| worker |', '| |').replace('machine/worker', '')]) {
    f.write('roster.md', text);
    assert.equal(f.read().tasks[0].ownerSessionId, null);
  }
});

test('duplicate IDs, colliding addresses, roster claims and observed sessions refuse guessing', (t) => {
  const f = fixture(t);
  for (const text of [
    roster + '| worker | Codex | other | other |\n',
    roster + '| other | Codex | other | worker |\n',
    roster + '| other | Claude | full-session | other |\n',
  ]) {
    f.write('roster.md', text);
    assert.deepEqual([f.read().tasks[0].ownerSessionId, f.read().tasks[0].ownerLink], [null, 'ambiguous']);
    assert.ok(f.read().diagnostics.length);
  }
  f.write('roster.md', roster);
  assert.equal(f.read([...sessions, sessions[0]]).tasks[0].ownerLink, 'ambiguous');
  assert.equal(f.read([...sessions, { id: 'codex:full-session', client: 'codex' }]).tasks[0].ownerLink, 'matched');
});

test('read errors are reported and empty roster identity cells remain valid', (t) => {
  const f = fixture(t);
  f.write('roster.md', '| id | agent kind | session |\n|---|---|---|\n| | | |\n');
  assert.deepEqual([f.read().status, f.read().tasks[0].ownerLink], ['ok', 'unmatched']);
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags) => {
    if (String(file).endsWith('roster.md')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return originalOpen(file, flags);
  });
  const result = f.read();
  assert.equal(result.status, 'error');
  assert.match(result.error, /permission denied/);
  assert.equal(result.tasks[0].id, '1');
});

test('escaped pipes and inline-code headers are supported without parsing arbitrary links', (t) => {
  const f = fixture(t);
  f.write('plan.md', plan.replace('| id |', '| `id` |').replace('Build', 'Build \\| verify'));
  const result = f.read();
  assert.equal(result.status, 'ok');
  assert.equal(result.tasks[0].title, 'Build | verify');
});
