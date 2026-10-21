// Read-only ledger snapshots; no fetch, checkout, briefs or workspace writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 1024 * 1024;
const TASK_COLUMNS = {
  id: 'id', 'task id': 'id', 'package id': 'id', mission: 'mission', priority: 'priority', title: 'title',
  owner: 'owner', 'depends on': 'dependsOn', dependencies: 'dependsOn', 'parallel group': 'parallelGroup',
  reviewer: 'reviewer', due: 'due', status: 'status', 'receipt ids': 'receipts', receipts: 'receipts',
};
const ROSTER_COLUMNS = {
  id: 'id', 'member id': 'id', address: 'address', 'agent kind': 'agentKind', client: 'agentKind', session: 'session',
  'session id': 'session', 'created by': 'createdBy', role: 'role', workspace: 'workspace', state: 'state',
  'current package': 'currentPackage', 'authorized peer contacts': 'authorizedPeerContacts',
  'last received receipt id': 'lastReceivedReceiptId', e: 'epoch', epoch: 'epoch', fo: 'failover', transport: 'transport',
};
const TASK_STATES = new Set(['QUEUED', 'ASSIGNED', 'PAUSED', 'DONE', 'STOPPED']);
const MEMBER_STATES = new Set(['ACTIVE', 'AFK', 'LOST', 'LEFT']);
const clientOf = (value) => {
  const name = String(value || '').trim().toLowerCase();
  return name === 'claude' || name === 'claude code' ? 'claude' : name === 'codex' ? 'codex' : null;
};
const empty = (value) => !value || /^(?:-|—|none|null|n\/a)$/i.test(value);
const list = (value) => empty(value) ? [] : value.split(/[,;\s]+/).filter(Boolean);
const diagnostic = (diagnostics, code, file, line, message) => diagnostics.push({ code, file, line, message });
const header = (value) => value.replace(/^`(.*)`$/, '$1').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

function cells(line) {
  let text = line.trim();
  if (!text.includes('|')) return null;
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((value) => value.trim().replace(/\\\|/g, '|'));
}

function parseTable(text, file, columns, required, diagnostics) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  let fence = null, found = false;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    const names = cells(lines[i]), separator = cells(lines[i + 1] || '');
    if (!names || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (found) throw new Error(`${file}:${i + 1}: multiple ledger tables are unsupported`);
    found = true;
    const keys = names.map((name) => Object.hasOwn(columns, header(name)) ? columns[header(name)] : undefined);
    if (keys.some((key) => !key)) throw new Error(`${file}:${i + 1}: unsupported table header`);
    if (new Set(keys).size !== keys.length) throw new Error(`${file}:${i + 1}: duplicate table header`);
    if (names.length !== separator.length || required.some((key) => !keys.includes(key))) {
      throw new Error(`${file}:${i + 1}: missing required columns or malformed separator`);
    }
    i++;
    while (i + 1 < lines.length) {
      const values = cells(lines[i + 1]);
      if (!values) break;
      i++;
      if (values.length !== keys.length) throw new Error(`${file}:${i + 1}: malformed table row`);
      const row = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
      const nonempty = file === 'plan.md' ? ['id', 'title', 'status', 'owner'] : [];
      if (nonempty.some((key) => !row[key])) throw new Error(`${file}:${i + 1}: missing required row value`);
      row.raw = Object.fromEntries(names.map((name, index) => [name, values[index]]));
      row.line = i + 1;
      rows.push(row);
    }
  }
  if (!found) throw new Error(`${file}: no supported Markdown table`);
  const ids = new Set();
  for (const row of rows) {
    if (row.id && ids.has(row.id)) diagnostic(diagnostics, 'duplicate-id', file, row.line, `Duplicate id: ${row.id}`);
    ids.add(row.id);
    const value = file === 'plan.md' ? row.status : row.state;
    const states = file === 'plan.md' ? TASK_STATES : MEMBER_STATES;
    if (value && !states.has(value.toUpperCase())) diagnostic(diagnostics, 'unknown-status', file, row.line, `Unknown ${file === 'plan.md' ? 'status' : 'state'}: ${value}`);
  }
  return rows;
}

function identity(kind, session) {
  const client = clientOf(kind);
  if (!client) return { reason: 'Unsupported or missing agent kind.' };
  if (empty(session)) return { reason: 'Roster session is missing.' };
  const colon = session.indexOf(':');
  if (colon >= 0) {
    const prefix = clientOf(session.slice(0, colon));
    if (prefix !== client) return { reason: 'Session client prefix conflicts with agent kind.' };
    session = session.slice(colon + 1);
  }
  if (!session || /\s/.test(session)) return { reason: 'Session must be a complete, nonempty session ID.' };
  return { key: `${client}:${session}` };
}

function linkTasks(tasks, roster, sessions, diagnostics) {
  const addresses = new Map(), claims = new Map(), observed = new Map();
  const add = (map, key, value) => { if (key) map.set(key, [...(map.get(key) || []), value]); };
  for (const member of roster) {
    member.identity = identity(member.agentKind, member.session);
    for (const address of new Set([member.id, member.address].filter((value) => !empty(value)))) add(addresses, address, member);
    add(claims, member.identity.key, member);
  }
  for (const session of sessions) {
    if (typeof session.id !== 'string') continue;
    const result = identity(session.client, session.id);
    add(observed, result.key, session);
  }
  for (const [address, members] of addresses) {
    if (members.length > 1) diagnostic(diagnostics, 'ambiguous-address', 'roster.md', members[0].line, `Multiple roster members use id/address: ${address}`);
  }
  for (const [key, members] of claims) {
    if (members.length > 1) diagnostic(diagnostics, 'duplicate-session', 'roster.md', members[0].line, `Multiple roster members claim session: ${key}`);
  }
  function resolve(address) {
    if (empty(address)) return [null, 'unmatched', 'No roster identity was assigned.'];
    const members = addresses.get(address) || [];
    if (!members.length) return [null, 'unmatched', 'No exact roster id or address matches.'];
    if (members.length !== 1) return [null, 'ambiguous', 'Multiple roster members match this id or address.'];
    const { key, reason } = members[0].identity;
    if (!key) return [null, 'unmatched', reason];
    if (claims.get(key).length !== 1) return [null, 'ambiguous', 'Multiple roster members claim this client/session.'];
    const matches = observed.get(key) || [];
    if (!matches.length) return [null, 'unmatched', 'No observed session matches the exact client and full session ID.'];
    if (matches.length !== 1) return [null, 'ambiguous', 'Multiple observed sessions have the same client/session.'];
    return [matches[0].id, 'matched', 'Exact roster id/address and client/full session match.'];
  }
  return tasks.map((task) => {
    const [ownerSessionId, ownerLink, ownerLinkReason] = resolve(task.owner);
    const [reviewerSessionId, reviewerLink, reviewerLinkReason] = resolve(task.reviewer);
    return {
      mission: '', priority: '', reviewer: '', parallelGroup: '', due: '', ...task,
      dependsOn: list(task.dependsOn), receipts: list(task.receipts),
      ownerSessionId, reviewerSessionId, ownerLink, reviewerLink, ownerLinkReason, reviewerLinkReason,
    };
  });
}

function validProject(project) {
  return typeof project === 'string' && project.length > 0 && project.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(project) && !project.includes('..') &&
    project.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function readFile(root, name) {
  const file = fs.realpathSync(path.join(root, name));
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`${name}: symlink escapes ledger directory`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${name}: not a regular file`);
    if (stat.size > MAX_BYTES) throw new Error(`${name}: exceeds 1 MiB limit`);
    // Read at most limit + 1, including if a file grows after fstat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, n;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += n;
    if (size > MAX_BYTES) throw new Error(`${name}: exceeds 1 MiB limit`);
    return buffer.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(fd); }
}

export function createLedgerReader(options = {}) {
  const { project, ledgerRepo = process.cwd(), ledgerDir } = options;
  const directory = ledgerDir !== undefined;
  const configError = directory && Object.hasOwn(options, 'ledgerRepo') ? 'ledgerDir and explicit ledgerRepo are mutually exclusive.'
    : !validProject(project) ? 'Invalid project for ledger Git ref.'
      : typeof (directory ? ledgerDir : ledgerRepo) !== 'string' || !(directory ? ledgerDir : ledgerRepo) ? 'Ledger path must be a nonempty string.' : null;
  const git = (args) => execFileSync('git', ['-C', ledgerRepo, ...args], {
    encoding: 'utf8', timeout: 3000, maxBuffer: MAX_BYTES + 1, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return {
    read(sessions = [], now = Date.now()) {
      const result = { status: 'ok', source: directory ? 'directory' : 'git', sourcePath: path.resolve(directory ? String(ledgerDir || '') : String(ledgerRepo || '')), ref: null, commit: null, updatedAt: now, tasks: [], diagnostics: [] };
      try {
        if (configError) throw new Error(configError);
        let plan, readRoster;
        if (directory) {
          let root;
          try { root = fs.realpathSync(ledgerDir); } catch (error) {
            if (error.code === 'ENOENT') return { ...result, status: 'unavailable', error: 'Ledger directory is unavailable.' };
            throw error;
          }
          plan = readFile(root, 'plan.md');
          readRoster = () => readFile(root, 'roster.md');
        } else {
          try { git(['rev-parse', '--git-dir']); } catch (error) {
            if (error.code === 'ENOENT' || error.status === 128) return { ...result, status: 'unavailable', error: 'Git repository is unavailable.' };
            throw error;
          }
          for (const ref of [`refs/heads/team/${project}`, `refs/remotes/origin/team/${project}`]) {
            try {
              result.commit = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
              result.ref = ref;
              break;
            } catch (error) { if (error.status !== 1 || String(error.stderr || '').trim()) throw error; }
          }
          if (!result.commit) return { ...result, status: 'unavailable', error: 'Ledger branch is unavailable locally; no fetch was attempted.' };
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commit)) throw new Error('Git returned an invalid commit ID.');
          plan = git(['show', `${result.commit}:plan.md`]);
          readRoster = () => git(['show', `${result.commit}:roster.md`]);
          if (Buffer.byteLength(plan) > MAX_BYTES) throw new Error('Ledger file exceeds 1 MiB limit.');
        }
        const tasks = parseTable(plan, 'plan.md', TASK_COLUMNS, ['id', 'title', 'status', 'owner'], result.diagnostics);
        result.tasks = linkTasks(tasks, [], sessions, result.diagnostics);
        const roster = readRoster();
        if (Buffer.byteLength(roster) > MAX_BYTES) throw new Error('roster.md exceeds 1 MiB limit.');
        const members = parseTable(roster, 'roster.md', ROSTER_COLUMNS, ['id', 'agentKind', 'session'], result.diagnostics);
        result.tasks = linkTasks(tasks, members, sessions, result.diagnostics);
        return result;
      } catch (error) {
        return { ...result, status: 'error', error: error.message || String(error) };
      }
    },
  };
}
