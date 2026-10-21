#!/usr/bin/env node
// Human-run, read-only dashboard for agent-team-bootstrap. It passively reads Claude Code / Codex
// session transcripts; agents never start, read or depend on it (it is not a transport or inbox).
// Usage: node team-dashboard.mjs --project <id> [--port 4317] [--since 24h]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLedgerReader } from './team-ledger.mjs';

const STALE_MS = 30 * 60 * 1000;
const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const safeJSON = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'message']) {
    const v = input[k];
    if (v) return clip(Array.isArray(v) ? v.join(' ') : v, 80);
  }
  return clip(JSON.stringify(input), 80);
}

// Compact `P:wms T:ASSIGN ID:17 ...` or the YAML-style envelope from references/protocol.md.
export function parseEnvelope(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bP:(\S+)\s+T:([A-Z_]+)/);
  if (m) {
    const f = {};
    for (const [, k, v] of text.matchAll(/\b(ID|TO|FROM|RE|STATUS|REF):(\S+)/g)) f[k] ??= v;
    return { project: m[1], type: m[2], id: f.ID, to: f.TO, from: f.FROM, re: f.RE, status: f.STATUS, ref: f.REF };
  }
  const y = (k) => {
    const v = text.match(new RegExp('^\\s*' + k + ':\\s*(\\S+)', 'm'))?.[1];
    return v === 'null' ? undefined : v;
  };
  const project = y('project'), type = y('type');
  return project && type
    ? { project, type: type.toUpperCase(), id: y('message_id'), to: y('to'), from: y('from'), re: y('in_reply_to') }
    : null;
}

// Normalised events: {ts, kind: text|tool_call|tool_result|turn_start|turn_end|send|recv, ...}
export function parseClaudeLine(d, ctx) {
  const ev = [];
  if (d.isSidechain) return ev;
  if (d.sessionId && !ctx.session) ctx.session = d.sessionId;
  if (d.cwd) ctx.cwd = d.cwd;
  const ts = Date.parse(d.timestamp) || 0;
  const queued = d.type === 'attachment' && d.attachment?.type === 'queued_command';
  const c = queued ? d.attachment.prompt : d.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  for (const b of blocks) {
    if (d.type === 'assistant') {
      if (b.type === 'text') ev.push({ ts, kind: 'text', role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') {
        ev.push({ ts, kind: 'tool_call', callId: b.id, name: b.name, input: b.input });
        if (b.name === 'SendMessage') ev.push({ ts, kind: 'send', to: b.input?.to, body: b.input?.message });
      }
    } else if (d.type === 'user' || queued) {
      if (b.type === 'tool_result') ev.push({ ts, kind: 'tool_result', callId: b.tool_use_id });
      else if (b.type === 'text') {
        ev.push({ ts, kind: 'text', role: 'user', text: b.text });
        // Claude 2.1.296 delivers queued attachments or user text with this fixed prefix.
        const r = String(b.text).match(/^\s*(?:Another Claude session sent a message:\s*)?<cross-session-message\b[^>]*\bfrom="([^"]*)"[^>]*>([\s\S]*?)<\/cross-session-message>/);
        if (r) ev.push({ ts, kind: 'recv', from: r[1], body: r[2] });
      }
    }
  }
  return ev;
}

export function parseCodexLine(d, ctx) {
  const ev = [];
  const ts = Date.parse(d.timestamp) || 0;
  const p = d.payload || {};
  if (d.type === 'session_meta') {
    if (p.id) ctx.session = p.id;
    if (p.cwd) ctx.cwd = p.cwd;
  } else if (d.type === 'response_item') {
    if (p.type === 'message' && (p.role === 'assistant' || p.role === 'user')) {
      const text = (p.content || []).map((x) => x.text || '').join('');
      ev.push({ ts, kind: 'text', role: p.role, text });
    } else if (p.type === 'function_call') {
      const input = safeJSON(p.arguments);
      ev.push({ ts, kind: 'tool_call', callId: p.call_id, name: p.name, input });
      if (/(?:^|\.|__)send_message_to_thread$/.test(p.name || '')) {
        ev.push({ ts, kind: 'send', to: input?.threadId, body: input?.prompt });
      }
    } else if (p.type === 'custom_tool_call') {
      ev.push({ ts, kind: 'tool_call', callId: p.call_id, name: p.name, input: { command: p.input } });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      ev.push({ ts, kind: 'tool_result', callId: p.call_id });
    }
  } else if (d.type === 'event_msg') {
    if (p.type === 'task_started') ev.push({ ts, kind: 'turn_start' });
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') ev.push({ ts, kind: 'turn_end' });
    else if (p.type === 'agent_message') ev.push({ ts, kind: 'text', role: 'assistant', text: p.message });
  }
  return ev;
}

function newRec(file, client) {
  return {
    file, client, base: path.basename(file, '.jsonl'), ctx: {}, offset: 0, rest: Buffer.alloc(0),
    s: { lastTs: 0, pending: new Map(), last: 'idle', tools: [], lastText: '' }, sent: [], recvd: [],
  };
}

function ingest(rec, ev) {
  const s = rec.s;
  if (ev.ts > s.lastTs) s.lastTs = ev.ts;
  switch (ev.kind) {
    case 'tool_call': {
      const t = { name: ev.name, summary: summarize(ev.input) };
      s.pending.set(ev.callId, t);
      s.tools.push(t);
      if (s.tools.length > 5) s.tools.shift();
      s.last = 'tool';
      break;
    }
    case 'tool_result': s.pending.delete(ev.callId); s.last = 'result'; break;
    case 'turn_start': s.turnActive = true; s.last = 'busy'; break;
    case 'turn_end': s.turnActive = false; s.pending.clear(); s.last = 'idle'; break;
    case 'text':
      s.last = ev.role === 'assistant' && !s.turnActive ? 'idle' : 'busy';
      if (ev.role === 'assistant' && ev.text) s.lastText = clip(ev.text, 160);
      break;
    case 'send': {
      const env = parseEnvelope(ev.body);
      if (env) rec.sent.push({ ...env, ts: ev.ts, toRaw: ev.to });
      break;
    }
    case 'recv': {
      const env = parseEnvelope(ev.body);
      if (env) rec.recvd.push({ ...env, ts: ev.ts, fromRaw: ev.from });
      break;
    }
  }
}

function readNew(rec, size) {
  const fd = fs.openSync(rec.file, 'r');
  try {
    const b = Buffer.alloc(Math.min(64 * 1024, size - rec.offset));
    const parse = rec.client === 'codex' ? parseCodexLine : parseClaudeLine;
    while (rec.offset < size) {
      const n = fs.readSync(fd, b, 0, Math.min(b.length, size - rec.offset), rec.offset);
      if (!n) break;
      rec.offset += n;
      const buf = Buffer.concat([rec.rest, b.subarray(0, n)]);
      const nl = buf.lastIndexOf(10);
      // shortcut: retain one incomplete JSONL line; bound line size if malformed logs become a problem.
      rec.rest = Buffer.from(buf.subarray(nl + 1));
      if (nl < 0) continue;
      for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        for (const ev of parse(d, rec.ctx)) ingest(rec, ev);
      }
    }
  } finally { fs.closeSync(fd); }
}

const SENDER_STATE = {
  JOIN_REQUEST: 'JOINING', ACK_RECEIVED: 'ACTIVE', ASSIGN_ACK: 'ASSIGNED', BLOCKED: 'BLOCKED',
  REVIEW_REQUEST: 'IN_REVIEW', REVIEW_FEEDBACK: 'IN_REVIEW', REVIEW_RESULT: 'IN_REVIEW',
  REVIEW_VERDICT: 'REVIEWED', COMPLETE: 'COMPLETE', LEAVE_REQUEST: 'LEAVING',
};
const RECEIVER_STATE = {
  JOIN_ACK: 'JOINING', ASSIGN: 'ASSIGNED', LEAVE_ACK: 'LEFT', RELEASE: 'LEAVING', REVIEW_REQUEST: 'IN_REVIEW', REVIEW_FEEDBACK: 'IN_REVIEW', REVIEW_RESULT: 'IN_REVIEW',
};

function roleOf({ sentT, recvT }) {
  if (['JOIN_ACK', 'ASSIGN', 'RELEASE', 'SKILL_REFRESH'].some((t) => sentT.has(t)) ||
      ['JOIN_REQUEST', 'COMPLETE', 'REVIEW_VERDICT', 'BLOCKED', 'REVIEWER_NEEDED', 'LEAVE_REQUEST'].some((t) => recvT.has(t))) return 'Leader';
  if (['REVIEW_RESULT', 'REVIEW_VERDICT', 'REVIEW_FEEDBACK'].some((t) => sentT.has(t))) return 'Reviewer';
  return 'Worker';
}

export function aggregate(recs, project, now) {
  const info = new Map();
  const member = (r) => {
    if (!info.has(r.key)) info.set(r.key, { r, sentT: new Set(), recvT: new Set(), name: null });
    return info.get(r.key);
  };
  const sent = new Map();
  const recvAll = [];
  let anon = 0;
  for (const r of recs) {
    r.key = `${r.client}:${r.ctx.session || r.base}`;
    for (const m of r.sent) {
      if (m.project !== project) continue;
      const mi = member(r);
      mi.sentT.add(m.type);
      if (m.from && !mi.name) mi.name = m.from;
      sent.set(m.id ?? `${r.key}#${m.ts}#${anon++}`, { ...m, fromSession: r.key });
    }
    for (const m of r.recvd) {
      if (m.project !== project) continue;
      member(r).recvT.add(m.type);
      recvAll.push({ m, key: r.key });
    }
  }
  // Resumed sessions can span files; keep all messages and the most recent execution state.
  for (const r of recs) {
    const mi = info.get(r.key);
    if (mi && r.s.lastTs > mi.r.s.lastTs) mi.r = r;
  }
  // Join receive records onto sends by message ID; a receive with no local sender stays sender-less.
  for (const { m, key } of recvAll) {
    const msg = m.id != null ? sent.get(m.id) : null;
    if (msg) msg.toSession ??= key;
    else sent.set(m.id ?? `${key}#${m.ts}#${anon++}`, { ...m, fromSession: null, toSession: key });
  }
  const byName = new Map();
  for (const [k, mi] of info) if (mi.name) byName.set(mi.name, k);
  const stripRef = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');
  const resolveTo = (msg) => {
    const target = `codex:${msg.toRaw}`;
    let k = msg.toSession || (info.has(target) ? target : null) || byName.get(msg.to) || byName.get(stripRef(msg.toRaw));
    if (!k) {
      const ref = String(msg.toRaw ?? '').match(/\[([0-9a-f]+)\]/)?.[1];
      if (ref) k = [...info.keys()].find((x) => x.split(':')[1].startsWith(ref));
    }
    if (!k && msg.re) k = sent.get(msg.re)?.fromSession; // a reply goes back to whoever sent the original
    return k && k !== msg.fromSession ? k : null;
  };
  const msgs = [...sent.values()].map((m) => ({ ...m, toSession: resolveTo(m) })).sort((a, b) => a.ts - b.ts);

  const out = new Map();
  for (const [key, mi] of info) {
    const role = roleOf(mi);
    const { s } = mi.r;
    const lastTs = s.lastTs || mi.r.mtime || 0;
    const pend = [...s.pending.values()].pop();
    let exec = 'IDLE', tool = '';
    if (now - lastTs > STALE_MS) exec = 'STALE';
    else if (pend) { exec = 'RUNNING'; tool = `${pend.name}: ${pend.summary}`; }
    else if (s.last === 'busy' || s.last === 'result') exec = 'RUNNING';
    out.set(key, {
      id: key, short: key.split(':')[1].slice(0, 6), client: mi.r.client, cwd: mi.r.ctx.cwd || '',
      workerId: mi.name, name: mi.name || (role === 'Leader' ? 'leader' : key.split(':')[1].slice(0, 6)), role,
      proto: role === 'Leader' ? 'COORDINATING' : 'NONE', exec, tool, lastText: s.lastText,
      recentTools: s.tools.map((t) => clip(`${t.name}: ${t.summary}`, 80)), lastTs,
    });
  }
  const label = (k, fallback) => out.get(k)?.name || fallback || null;
  const messages = msgs.map((m) => {
    if (out.has(m.fromSession)) { const st = SENDER_STATE[m.type]; if (st) out.get(m.fromSession).proto = st; }
    if (out.has(m.toSession)) { const st = RECEIVER_STATE[m.type]; if (st) out.get(m.toSession).proto = st; }
    const leaderEnd = [m.fromSession, m.toSession].some((k) => out.get(k)?.role === 'Leader');
    return {
      ts: m.ts, type: m.type, id: m.id, re: m.re, status: m.status, ref: m.ref,
      from: m.fromSession, to: m.toSession,
      fromLabel: label(m.fromSession, m.from || m.fromRaw), toLabel: label(m.toSession, m.to || stripRef(m.toRaw)),
      p2p: !!(out.has(m.fromSession) && out.has(m.toSession) && !leaderEnd),
    };
  });
  return { project, now, sessions: [...out.values()], messages: messages.slice(-300) };
}

export function createTracker({ project, claudeDir, codexDir, sinceMs = 24 * 3600e3, now = Date.now, ledgerRepo, ledgerDir }) {
  const files = new Map();
  const ledger = createLedgerReader({ project, ...(ledgerRepo !== undefined ? { ledgerRepo } : {}), ...(ledgerDir !== undefined ? { ledgerDir } : {}) });
  const walk = (dir, client, match) => {
    try { return fs.readdirSync(dir, { recursive: true }).map(String).filter(match).map((f) => ({ file: path.join(dir, f), client })); }
    catch { return []; }
  };
  const discover = () => {
    const found = [];
    try {
      for (const d of fs.readdirSync(claudeDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of walk(path.join(claudeDir, d.name), 'claude', (f) => !f.includes(path.sep) && f.endsWith('.jsonl'))) found.push(f);
      }
    } catch { /* no Claude transcripts */ }
    found.push(...walk(codexDir, 'codex', (f) => path.basename(f).startsWith('rollout-') && f.endsWith('.jsonl')));
    return found;
  };
  return {
    state() {
      const t = now();
      const live = new Set();
      for (const { file, client } of discover()) {
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (st.mtimeMs < t - sinceMs) continue;
        live.add(file);
        let rec = files.get(file);
        if (!rec || st.size < rec.offset) { rec = newRec(file, client); files.set(file, rec); }
        rec.mtime = st.mtimeMs;
        if (st.size > rec.offset) readNew(rec, st.size);
      }
      for (const f of files.keys()) if (!live.has(f)) files.delete(f);
      const state = aggregate([...files.values()], project, t);
      return { ...state, ledger: ledger.read(state.sessions, t) };
    },
  };
}

export function createServer(tracker) {
  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: the state endpoint exposes tool arguments and assistant output.
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/state') {
      try {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(tracker.state()));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message) }));
      }
    } else if (url.pathname === '/vendor/d3-7.9.0.min.js') {
      try {
        const script = fs.readFileSync(new URL('./vendor/d3-7.9.0.min.js', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=86400' }).end(script);
      } catch { res.writeHead(500).end('D3 resource unavailable'); }
    } else if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      }).end(HTML);
    } else res.writeHead(404).end('not found');
  });
  return server;
}

function parseSince(s) {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) throw new Error(`bad --since "${s}" (use e.g. 90m, 24h, 7d)`);
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

function main() {
  const a = { port: '4317', since: '24h' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!a.project) {
    console.error('Usage: node team-dashboard.mjs --project <id> [--port 4317] [--since 24h] [--claude-dir DIR] [--codex-dir DIR] [--ledger-repo DIR | --ledger-dir DIR]');
    process.exit(2);
  }
  const tracker = createTracker({
    project: a.project,
    sinceMs: parseSince(a.since),
    ledgerRepo: a['ledger-repo'], ledgerDir: a['ledger-dir'],
    claudeDir: a['claude-dir'] || path.join(os.homedir(), '.claude', 'projects'),
    codexDir: a['codex-dir'] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  });
  const server = createServer(tracker);
  server.on('error', (e) => { console.error(`dashboard: ${e.message}`); process.exit(1); });
  server.listen(Number(a.port), '127.0.0.1', () => {
    console.log(`Agent Team Dashboard for project "${a.project}": http://127.0.0.1:${server.address().port}/  (add ?demo=1 for a scripted demo)`);
  });
}

const HTML = String.raw`
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Team · 团队监控</title>
<style>
:root{color-scheme:light;--bg:#fafafa;--panel:#fff;--soft:#f6f7f8;--ink:#202124;--muted:#71767d;--line:#e7e8eb;--accent:#0875dc;--wash:#eaf4ff;--good:#147b45;--warn:#95601f;--warn-bg:#fff6e7;--bad:#b13c35;--bad-bg:#fff0ed;--avatar-bg:#f1f4ef;--avatar-fill:#bfd0b1;--avatar-ink:#405139;--wire:#8dbdff;--shadow:0 1px 3px #2021240a}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#17191d;--panel:#202329;--soft:#282c32;--ink:#edf0f4;--muted:#adb3bc;--line:#363b44;--accent:#82bbff;--wash:#253b54;--good:#8bd5a5;--warn:#eac58c;--warn-bg:#3b3020;--bad:#f2aaa2;--bad-bg:#412a27;--avatar-bg:#303b30;--avatar-fill:#95b388;--avatar-ink:#233120;--wire:#638fc4;--shadow:0 1px 3px #0002}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}button,input,select{font:inherit;color:inherit}button,a,input,select{min-height:44px}button{cursor:pointer;border:1px solid var(--line);background:var(--panel);border-radius:7px;padding:8px 12px}button:hover{background:var(--soft)}button:disabled{opacity:.5;cursor:default}a{color:inherit;text-decoration:none}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:3px}h1,h2,h3,p{margin:0}h1{font-size:19px;font-weight:600;letter-spacing:-.4px}h2{font-size:16px;font-weight:600}h3{font-size:12px;font-weight:500;color:var(--muted)}code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}small,.sub,.muted{color:var(--muted);font-size:12px}[hidden]{display:none!important}.main{width:min(100%,1560px);margin:0 auto;padding:32px 28px;min-width:0}.app-header{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.app-brand{display:flex;align-items:center;gap:11px}.brand-icon{color:var(--accent);font-size:22px}.app-brand .sub{font-size:12px}.top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.top-actions button{font-size:11px;background:transparent}.connection{font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;margin-right:6px}.connection:before{content:"";width:5px;height:5px;background:var(--good);border-radius:50%}.connection[data-state="error"]:before{background:var(--bad)}.connection[data-state="paused"]:before{background:var(--warn)}.badge{display:inline-flex;border:1px solid var(--line);border-radius:5px;padding:2px 6px;font-size:10px;line-height:1.5}.demo-badge{background:var(--warn-bg);color:var(--warn)}.summary-bar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:22px 0 12px;flex-wrap:wrap}.stats{display:flex;gap:5px;flex-wrap:wrap}.stat{border:0;background:transparent;padding:7px 11px;font-size:12px;color:var(--muted)}.stat strong{font-weight:500;color:var(--ink);margin-right:5px}.stat[aria-pressed="true"]{background:var(--wash);color:var(--accent)}.stat[aria-pressed="true"] strong{color:var(--accent)}.summary-info{display:flex;gap:15px;align-items:center;font-size:11px;color:var(--muted)}.notice{padding:12px 16px;border:1px solid var(--bad);background:var(--bad-bg);color:var(--bad);border-radius:7px;font-size:12px;margin:16px 0}.live-section{margin:8px 0 32px}.graph-intro{display:flex;justify-content:space-between;gap:15px;align-items:center;padding:6px 10px 16px;font-size:11px;color:var(--muted)}.graph-intro h2{font-size:12px;color:var(--muted);font-weight:400}.live-room{position:relative;min-width:0}.live-scroll{position:relative;overflow:auto;max-height:min(760px,78vh);min-height:220px;border-radius:8px}.graph-canvas{position:relative;margin-inline:auto}.live-grid{position:relative;z-index:1;width:100%;height:100%;pointer-events:none}.live-seat{position:absolute;pointer-events:auto;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px;width:280px;height:174px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:8px;min-width:0}.live-seat:hover{background:var(--panel);border-color:var(--wire);box-shadow:0 3px 12px #52779b12}.card-top{display:flex;align-items:center;gap:8px;min-width:0}.seat-art{flex:none}.live-seat .avatar{width:34px;height:38px;overflow:visible;display:block}.card-identity{flex:1;min-width:0}.card-identity strong{font-size:13px;display:block;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}.seat-tags{font-size:10px;display:block;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.seat-state{flex:none;align-self:start;margin-top:1px}.seat-state .raw{display:none}.seat-state .status{font-size:10px;padding:2px 6px;border-radius:4px;background:var(--soft)}.seat-state .status.good{background:var(--wash);color:var(--accent)}.live-seat[data-proto="COMPLETE"]:not([data-exec="RUNNING"]) .seat-state .status.good{background:#e7f5eb;color:#147b45}.card-activity{color:var(--muted);font-size:12px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;min-height:36px}.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:var(--muted);margin-top:auto}.card-proto{font-size:10px;line-height:1.3;color:var(--muted)}.card-proto .raw{display:none}.card-proto .status{font-size:10px}.card-bottom .peer-count{color:var(--accent)}.graph-lines,.mail-layer{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}.graph-lines{z-index:0}.mail-layer{z-index:2}.graph-lines path{fill:none;stroke:var(--wire);stroke-width:1.4;stroke-linejoin:round}.graph-lines circle{fill:var(--panel);stroke:var(--wire);stroke-width:1.4}.live-foot{padding:12px 10px;font-size:10px;color:var(--muted);display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}.scene-symbol{display:none}.seat-bubble{position:absolute;top:-25px;left:50%;transform:translateX(-50%);font-size:9px;white-space:nowrap;background:var(--panel);border:1px solid var(--wire);border-radius:5px;padding:2px 6px;z-index:3}.live-room.motion-off *{animation:none!important}.live-room.motion-off .mail-layer,.live-room.motion-off .seat-bubble{display:none}.avatar{width:44px;height:48px;flex:none;display:block}.avatar .lens{display:none}.live-seat[data-proto="IN_REVIEW"] .lens{display:block}.live-seat .figure{transform-origin:32px 56px;animation:character-breathe 3s ease-in-out infinite;animation-delay:var(--phase)}.live-seat .eyes{transform-origin:center;transform-box:fill-box;animation:character-blink 4.7s infinite;animation-delay:var(--phase)}.live-seat .limb{transform-box:fill-box;transform-origin:50% 0%}.live-seat[data-exec="RUNNING"] .figure{animation:character-type .65s ease-in-out infinite}.live-seat[data-exec="RUNNING"] .limb{animation:character-tap .3s ease-in-out infinite alternate}.live-seat[data-exec="RUNNING"] .limb.right{animation-delay:-.15s}.live-seat:hover .limb.right,.live-seat:focus-visible .limb.right{animation:character-wave .5s ease-in-out infinite alternate}.live-seat[data-proto="BLOCKED"] .figure{animation:character-puzzle 2.5s ease-in-out infinite}.live-seat[data-proto="COMPLETE"]:not([data-exec="RUNNING"]) .limb{transform:rotate(130deg)}.live-seat[data-proto="COMPLETE"]:not([data-exec="RUNNING"]) .limb.right{transform:rotate(-130deg)}.live-seat[data-exec="STALE"] .figure{animation:character-sleep 4s ease-in-out infinite;opacity:.65}.reacting .figure{animation:character-hop .7s ease-out!important}
@keyframes character-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.025,.975)}}@keyframes character-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}@keyframes character-type{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-1.5px) rotate(1deg)}}@keyframes character-tap{from{transform:rotate(-12deg)}to{transform:rotate(12deg)}}@keyframes character-wave{from{transform:rotate(-110deg)}to{transform:rotate(-150deg)}}@keyframes character-puzzle{0%,75%,100%{transform:rotate(0)}80%{transform:rotate(-5deg)}90%{transform:rotate(5deg)}}@keyframes character-sleep{0%,100%{transform:translateY(0)}50%{transform:translateY(2px) scale(1.02,.97)}}@keyframes character-hop{0%,100%{transform:translateY(0)}35%{transform:translateY(-9px) rotate(-5deg)}65%{transform:translateY(-3px) rotate(4deg)}}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:20px;align-items:start;border-top:1px solid var(--line);padding-top:24px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;min-height:30px}.count{font-size:11px;color:var(--muted);margin-left:7px;font-weight:400}.panel{background:var(--panel);border:1px solid var(--line);border-radius:9px;min-width:0;overflow:hidden}.members-head,.member-row{display:grid;grid-template-columns:minmax(180px,1.2fr) 105px 105px minmax(110px,1fr);gap:14px;align-items:center;padding:14px 16px}.members-head{font-size:10px;color:var(--muted);background:var(--soft);padding-block:10px}.member-row{border-top:1px solid var(--line);min-height:90px}.member-row:hover{background:var(--soft)}.member-id{display:flex;gap:10px;align-items:center;min-width:0}.identity{min-width:0}.member-name{background:none!important;border:0;padding:0;min-height:30px;display:block;text-align:left;font-size:12px;font-weight:600;overflow-wrap:anywhere;max-width:100%}.identity .sub{font-size:10px;display:flex;flex-wrap:wrap;gap:4px 7px}.identity code{font-size:9px}.status{font-size:11px;display:inline-flex;gap:5px;align-items:center;font-weight:500}.status:before{content:attr(data-symbol);font-size:12px;line-height:1}.status.good{color:var(--good)}.status.warn{color:var(--warn)}.status.bad{color:var(--bad)}.status.neutral{color:var(--muted)}.raw{display:block;font-size:9px;color:var(--muted);margin-top:2px}.activity{font-size:11px;overflow-wrap:anywhere;min-width:0}.activity-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.activity .sub{font-size:10px}.member-actions{display:flex;justify-content:space-between;gap:8px;margin-top:4px}.text-button{border:0;background:none;color:var(--accent);padding:0;min-height:30px;font-size:10px}.text-button:hover{background:none;text-decoration:underline}.empty{padding:32px 20px;text-align:center;color:var(--muted);font-size:12px}.attention-head{font-size:11px;color:var(--muted);display:flex;justify-content:space-between;padding:13px 16px;background:var(--soft);border-bottom:1px solid var(--line)}.attention-list{padding:0 15px}.attention-item{padding:14px 0;border-bottom:1px solid var(--line)}.attention-item:last-child{border:0}.attention-item button{padding:0;border:0;min-height:28px;background:none;text-align:left;font-weight:600;font-size:11px;overflow-wrap:anywhere}.attention-item p{font-size:11px;color:var(--muted);margin-top:4px}.reason{font-size:10px;display:inline-flex;gap:5px;color:var(--warn);margin-top:6px}.reason.bad{color:var(--bad)}.guide{margin-top:16px;padding:16px;border:1px solid var(--line);border-radius:9px;font-size:11px;color:var(--muted)}.guide h3{color:var(--ink);margin-bottom:8px}.guide p+p{margin-top:8px}.guide strong{color:var(--ink);font-weight:500}.messages{margin-top:28px}.message-title{display:flex;align-items:center;gap:9px}.filters{padding:16px;display:flex;gap:10px;align-items:end;flex-wrap:wrap;border-bottom:1px solid var(--line)}.field{display:flex;flex-direction:column;gap:5px;font-size:10px;color:var(--muted)}.field.search{flex:1;min-width:175px}.field input,.field select{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:9px 11px;max-width:100%;min-width:0;font-size:11px}.field select{width:165px}.filters>button{font-size:11px}.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;table-layout:fixed;min-width:760px;font-size:11px}th{text-align:left;font-size:10px;font-weight:500;color:var(--muted);background:var(--soft);padding:10px 16px}td{padding:13px 16px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}td code{font-size:10px}th:nth-child(1){width:11%}th:nth-child(2){width:23%}th:nth-child(3){width:19%}th:nth-child(4){width:17%}th:nth-child(5){width:14%}th:nth-child(6){width:16%}.route{display:flex;gap:6px;flex-direction:column}.route span:last-child{color:var(--muted)}.type-label{font-size:10px;font-weight:600}.type-label small{display:block;font-size:9px;font-weight:400;margin-top:3px}.table-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 16px;border-top:1px solid var(--line);font-size:10px;color:var(--muted)}.footer{display:flex;justify-content:space-between;gap:16px;margin-top:24px;font-size:10px;color:var(--muted)}dialog{position:fixed;inset:0 0 0 auto;margin:0;border:0;border-left:1px solid var(--line);padding:0;width:min(490px,100%);max-width:100%;height:100dvh;max-height:100dvh;background:var(--panel);color:var(--ink);box-shadow:0 10px 60px #0002}dialog::backdrop{background:#101d184f}.drawer-top{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--line)}.drawer-top p{font-size:11px;color:var(--muted)}.drawer-top button{font-size:20px;width:44px;padding:0}.drawer-content{padding:24px}.drawer-identity{display:flex;gap:16px;align-items:center;margin-bottom:20px}.drawer-identity .avatar{width:76px;height:82px}.drawer-identity h2{overflow-wrap:anywhere;font-size:22px}.drawer-identity .badge{margin:7px 4px 0 0}.drawer-status{display:flex;gap:28px;padding:16px 0;border-block:1px solid var(--line);margin-bottom:20px}.drawer-content h3{margin:22px 0 8px}.detail-box{padding:13px;border:1px solid var(--line);background:var(--soft);border-radius:6px;overflow-wrap:anywhere;font-size:12px;white-space:pre-wrap}.drawer-content dl{display:grid;grid-template-columns:70px minmax(0,1fr);gap:10px;margin:0;font-size:11px}.drawer-content dt{color:var(--muted)}.drawer-content dd{margin:0;overflow-wrap:anywhere}.tools{padding:0;list-style:none;font-size:11px}.tools li{padding:9px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.peers{display:flex;gap:7px;flex-wrap:wrap}.peers button{font-size:11px}.drawer-content .primary{width:100%;margin-top:22px;background:var(--accent);color:var(--panel);border-color:var(--accent)}.drawer-message{padding:11px 0;border-bottom:1px solid var(--line);font-size:11px}.drawer-message small{display:block;margin-top:3px}
@media(max-width:1100px){.workspace{grid-template-columns:minmax(0,1fr)}.aside{display:grid;grid-template-columns:1fr 1fr;gap:16px}.guide{margin:0}}
@media(max-width:750px){.main{padding:20px 16px}.member-list-wrap{overflow-x:auto}.member-list{min-width:620px}.summary-bar{margin-top:14px}.graph-intro{align-items:start;flex-wrap:wrap}.top-actions{gap:6px}.summary-info{flex-wrap:wrap}}
@media(max-width:560px){.app-header{gap:12px}.top-actions{width:100%;justify-content:flex-end}.connection{margin-right:auto}.top-actions button{font-size:10px;padding:7px}.summary-bar{gap:8px}.stat{font-size:11px;padding:6px 8px}.summary-info{font-size:10px}.live-scroll{max-height:650px}.live-foot{padding-inline:0}.workspace{padding-top:20px}.members-head{display:none}.member-list{min-width:0}.member-row{grid-template-columns:minmax(0,1fr) minmax(100px,.6fr);gap:12px;padding:16px}.member-id{grid-column:1/-1}.member-row>.activity{grid-column:1/-1;padding-top:8px;border-top:1px solid var(--line)}.identity{flex:1}.member-row .raw{display:inline;margin-left:6px}.aside{grid-template-columns:minmax(0,1fr)}.filters{padding:14px}.field.search{flex-basis:100%}.field:not(.search){flex:1;min-width:0}.field select{width:100%}.footer{flex-direction:column;gap:4px}.drawer-content{padding:20px}.drawer-top{padding:14px 20px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}

:root{--type-assign:#2a78d6;--type-peer:#eb6834;--type-review:#1baf7a;--type-other:#797d85;--state-blocked:#d03b3b;--state-complete:#0ca30c}
@media(prefers-color-scheme:dark){:root{--type-assign:#3987e5;--type-peer:#d95926;--type-review:#199e70;--type-other:#a1a7b0}}
.main{padding-top:18px}.summary-bar{margin:10px 0 4px}.graph-intro{padding-bottom:8px}.live-scroll{overflow:visible;max-height:none;min-height:0}.graph-canvas{margin:0}.live-section{margin-top:0}.live-seat{height:auto;width:auto;gap:3px;padding:9px 11px;justify-content:space-between}.live-seat .avatar{width:42px;height:44px}.card-top{gap:7px}.card-identity strong{font-size:12px}.seat-tags{font-size:9px}.card-activity{min-height:0;font-size:11px;-webkit-line-clamp:1}.card-bottom{margin:0;font-size:9px}.card-proto .status{font-size:10px}.seat-state .status{font-size:9px;padding:2px 4px}.live-foot{padding:5px 6px;font-size:9px}.graph-legend{display:flex;gap:7px 16px;flex-wrap:wrap;align-items:center;font-size:10px;color:var(--muted);padding:4px 8px 10px}.graph-legend span{display:inline-flex;gap:5px;align-items:center}.graph-legend i{display:inline-block;width:20px;border-top:2px solid var(--edge-color);height:0}.edge{pointer-events:stroke}.edge .edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke}.edge .edge-line{stroke:var(--edge-color);stroke-width:1.8;opacity:.65;pointer-events:none}.edge[data-state="blocked"] .edge-line{stroke-dasharray:5 4}.edge[data-state="complete"] .edge-line{stroke-dasharray:2 3}.edge:hover .edge-line,.edge:focus .edge-line{opacity:1;stroke-width:3}.edge:focus{outline:none}.edge .edge-marker{stroke:var(--edge-color);fill:var(--panel);stroke-width:1.6}.edge[data-state="blocked"] .edge-marker{stroke:var(--state-blocked);fill:var(--state-blocked)}.edge[data-state="complete"] .edge-marker{stroke:var(--state-complete);fill:var(--state-complete)}.graph-lines{pointer-events:none}.graph-lines .edge{pointer-events:stroke}.legend-dot{width:7px;height:7px;border-radius:50%;background:var(--state-blocked);display:inline-block}.legend-dot.complete{background:var(--state-complete)}.graph-lines text{fill:var(--panel);font-size:7px;font-weight:700;text-anchor:middle;pointer-events:none}.live-seat.sending{box-shadow:0 0 0 2px var(--accent)}.live-seat.sending .figure{animation:character-speak .25s ease-in-out infinite alternate}.live-seat.reacting{border-color:var(--accent);box-shadow:0 0 0 2px var(--wash)}.seat-bubble{top:-19px;font-size:8px;max-width:100%;overflow:hidden;text-overflow:ellipsis}.mail-token{filter:drop-shadow(0 2px 2px #0003)}
@keyframes character-speak{from{transform:translateY(0) rotate(-3deg)}to{transform:translateY(-3px) rotate(3deg)}}
@media(max-width:600px){.main{padding:10px 12px}.app-header{gap:4px}.app-brand h1{font-size:16px}.top-actions{gap:4px}.top-actions button{font-size:9px;padding:5px 7px;min-height:34px}.connection{font-size:9px}.summary-bar{margin:5px 0 0;gap:2px}.stat{padding:5px 7px;font-size:10px;min-height:32px}.summary-info{font-size:9px}.graph-intro{padding:3px 3px 4px;gap:3px}.graph-intro h2,.graph-intro>span{font-size:9px}.graph-legend{font-size:8px;gap:3px 8px;padding:2px 3px 5px}.graph-legend i{width:13px}.live-seat{padding:5px 6px;gap:2px;border-radius:8px}.live-seat .card-top{gap:4px;flex-wrap:wrap}.live-seat .avatar{width:28px;height:30px}.live-seat .card-identity{min-width:0;flex-basis:65px}.live-seat .card-identity strong{font-size:10px}.live-seat .seat-tags{font-size:8px}.live-seat .seat-state{position:absolute;right:5px;bottom:5px}.live-seat .seat-state .status{font-size:8px;padding:1px 3px}.live-seat .card-proto{font-size:8px;padding-right:53px;white-space:nowrap}.live-seat .card-proto .status{font-size:8px}.live-seat .card-activity,.live-seat .card-bottom{display:none}.live-foot{font-size:8px;gap:3px;padding:4px 2px}.live-section{margin-bottom:14px}}

#graphCanvas{overflow:hidden;touch-action:none;background-image:radial-gradient(var(--line) .8px,transparent .8px);background-size:18px 18px;border:1px solid var(--line);border-radius:10px}#graphWorld{position:absolute;left:0;top:0;transform-origin:0 0}.graph-intro button{min-height:30px;padding:3px 9px;font-size:10px}.edge.dimmed{opacity:.1}.edge.highlighted .edge-line{opacity:1;stroke-width:3}.edge .edge-line{opacity:.48}.edge .edge-marker{r:3}.live-seat{cursor:grab;touch-action:none}.live-seat:active{cursor:grabbing}.graph-lines,.mail-layer{overflow:visible}.live-grid{overflow:visible}.graph-lines{z-index:0}.live-grid{z-index:1}.mail-layer{z-index:2}
.live-seat{--card-tint:var(--panel);--card-stroke:var(--line);--leader-ring:0 0 0 0 transparent;background:var(--card-tint);border-color:var(--card-stroke);box-shadow:var(--leader-ring),var(--shadow)}.live-seat:hover{background:var(--card-tint);border-color:var(--card-stroke);box-shadow:var(--leader-ring),0 4px 16px #28466020}.live-seat[data-card-state="running"]{--card-tint:#edf6ff;--card-stroke:#6dace8}.live-seat[data-card-state="review"]{--card-tint:#f4f0ff;--card-stroke:#ad96d8}.live-seat[data-card-state="blocked"]{--card-tint:#fff0ed;--card-stroke:#d66a5b;border-width:2px}.live-seat[data-card-state="complete"]{--card-tint:#eef8f0;--card-stroke:#81b992}.live-seat[data-card-state="stale"]{--card-tint:#f0f1f3;--card-stroke:#a4a9b1;border-style:dashed}.live-seat[data-card-state="idle"]{--card-tint:#fafbfc}.live-seat[data-role="Leader"]{--leader-ring:0 0 0 3px #c6953840;--card-stroke:#b78a32;border-width:2px}.live-seat[data-role="Leader"] .seat-art{position:relative}.live-seat[data-role="Leader"] .seat-art:after{content:"L";position:absolute;right:-3px;bottom:0;background:#856019;color:#fff;border:1.5px solid var(--panel);width:15px;height:15px;border-radius:5px;text-align:center;font-size:9px;line-height:13px;font-weight:700}.live-seat[data-role="Leader"] .card-identity strong{font-weight:750}.live-seat[data-role="Leader"] .seat-tags{color:#7c591a;font-weight:600}.live-seat[data-role="Leader"][data-card-state="blocked"]{border-color:#d66a5b}.live-seat.sending{box-shadow:var(--leader-ring),0 0 0 2px var(--accent)}.live-seat.reacting{box-shadow:var(--leader-ring),0 0 0 2px var(--wash)}
@media(prefers-color-scheme:dark){.live-seat[data-card-state="running"]{--card-tint:#1e3043;--card-stroke:#568fc0}.live-seat[data-card-state="review"]{--card-tint:#30283f;--card-stroke:#9b82c2}.live-seat[data-card-state="blocked"]{--card-tint:#402a29;--card-stroke:#d68b80}.live-seat[data-card-state="complete"]{--card-tint:#23372b;--card-stroke:#6d9f7d}.live-seat[data-card-state="stale"]{--card-tint:#272a30;--card-stroke:#737b87}.live-seat[data-card-state="idle"]{--card-tint:#22262c}.live-seat[data-role="Leader"]{--leader-ring:0 0 0 3px #e5bc5845;--card-stroke:#d4ad53}.live-seat[data-role="Leader"] .seat-tags{color:#e7c67b}}

.collaboration-layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start}.ledger-panel{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:15px;position:sticky;top:12px;max-height:calc(100dvh - 145px);overflow:auto}.ledger-heading{display:flex;justify-content:space-between;gap:12px;align-items:start}.ledger-heading h2{font-size:15px}.ledger-heading .sub{font-size:10px}.ledger-source{font:10px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;margin:12px 0 5px;color:var(--muted)}.ledger-notice{font-size:10px;color:var(--muted);overflow-wrap:anywhere;margin-bottom:12px}.ledger-toolbar{display:flex;gap:8px}.ledger-toolbar .field:first-child{flex:1;min-width:0}.ledger-toolbar input{width:100%}.ledger-toolbar select{width:100px}.ledger-toolbar input,.ledger-toolbar select{font-size:10px;min-height:36px;padding:6px 8px}.ledger-tasks{display:grid;gap:8px;margin-top:12px}.ledger-task{text-align:left;padding:10px 11px;display:grid;gap:5px}.ledger-task[aria-pressed="true"]{border-color:var(--accent);background:var(--wash)}.task-meta{display:flex;gap:8px;font-size:9px;color:var(--muted);align-items:center}.task-meta code{font-size:10px}.task-status{margin-left:auto;color:var(--accent)}.ledger-task[data-status="DONE"] .task-status{color:var(--good)}.ledger-task[data-status="PAUSED"] .task-status{color:var(--warn)}.ledger-task strong{font-size:12px;overflow-wrap:anywhere}.task-owner{font-size:10px;color:var(--muted);overflow-wrap:anywhere}.task-owner>span{font-size:9px;margin-left:4px}.ledger-selection{display:flex;justify-content:space-between;gap:8px;font-size:10px;align-items:center;padding-top:10px}.ledger-selection button{font-size:10px;min-height:30px;padding:3px 7px}.ledger-task-detail{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.ledger-task-detail h3{color:var(--ink);margin-bottom:10px}.ledger-task-detail dl{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;font-size:10px}.ledger-task-detail dt{color:var(--muted)}.ledger-task-detail dd{margin:0;overflow-wrap:anywhere}.ledger-task-detail dd button{min-height:30px;font-size:10px;padding:3px 7px}.ledger-task-detail .sub{font-size:9px}.detail-tasks{display:flex;flex-wrap:wrap;gap:6px}.detail-tasks button{font-size:11px}.live-seat.task-linked{outline:3px solid var(--accent);outline-offset:4px}.live-seat.task-unrelated{opacity:.4}.cli-icon{position:relative;border:1px solid #bfc5cf;border-radius:8px;display:inline-flex!important;align-items:center;justify-content:center;background:#f6f7f9;color:#263342;overflow:visible}.cli-icon .terminal-bar{position:absolute;top:0;left:5px;font-size:7px;letter-spacing:1px;color:#7d8490;line-height:10px}.cli-icon b{font:650 16px/1 ui-monospace,monospace;padding-top:5px}.cli-icon.claude{background:#fff0e7;border-color:#d4a68a;color:#8d4e32}.cli-icon.codex{background:#edf2f7;border-color:#a6b8ca;color:#314a61}.live-seat[data-exec="RUNNING"] .cli-icon{animation:cli-running 1.8s ease-in-out infinite}.live-seat.sending .cli-icon,.live-seat.reacting .cli-icon{animation:character-hop .7s ease-out}.live-seat .cli-icon{width:38px;height:38px}.live-seat[data-role="Leader"] .seat-art:after{z-index:1}@keyframes cli-running{0%,100%{box-shadow:0 0 0 0 #4e9fe340}50%{box-shadow:0 0 0 4px #4e9fe31a}}
@media(prefers-color-scheme:dark){.cli-icon{background:#2a2f36;color:#dbe4ee;border-color:#5b6675}.cli-icon.claude{background:#422e25;color:#efc7ae;border-color:#9b735b}.cli-icon.codex{background:#263441;color:#c4d8ea;border-color:#637c94}}
@media(max-width:1000px){.collaboration-layout{grid-template-columns:minmax(0,1fr)}.ledger-panel{position:static;max-height:500px;margin-bottom:22px}.ledger-toolbar select{width:140px}}
@media(max-width:600px){.live-seat .cli-icon{width:26px;height:27px;border-radius:6px}.cli-icon b{font-size:11px}.cli-icon .terminal-bar{font-size:5px;left:3px;line-height:7px}.ledger-panel{padding:12px}.collaboration-layout{gap:8px}}
</style></head><body>
<main class="main" id="overview">
<header class="app-header"><div class="app-brand"><span class="brand-icon" aria-hidden="true">✦</span><div><h1>Agents <span class="sub">团队协作</span></h1><p class="sub"><span id="project">正在读取…</span> <span class="badge" id="sourceBadge">本地 · 只读</span></p></div></div><div class="top-actions"><span id="connection" class="connection" role="status">正在连接</span><button id="motionToggle" type="button" aria-pressed="true">暂停动画</button><button id="pause" type="button" aria-pressed="false">暂停刷新</button><button id="refresh" type="button">↻ 立即刷新</button></div></header>
<div class="summary-bar"><section class="stats" aria-label="成员状态筛选"><button class="stat" data-scope="all" aria-pressed="true"><strong id="total">—</strong>位成员</button><button class="stat" data-scope="running" aria-pressed="false"><strong id="running">—</strong>执行中</button><button class="stat" data-scope="blocked" aria-pressed="false"><strong id="blocked">—</strong>协作阻塞</button><button class="stat" data-scope="stale" aria-pressed="false"><strong id="stale">—</strong>久未活动</button></section><div class="summary-info"><span id="updated">等待首次数据</span><a href="#messages">查看通信记录 ↓</a></div></div>
<div id="error" class="notice" role="alert" hidden></div>
<div class="collaboration-layout"><section class="live-section" aria-labelledby="liveTitle"><div class="graph-intro"><h2 id="liveTitle">成员协作图 · 拖动调整位置</h2><span><button type="button" id="fitGraph">适配全员</button> <button type="button" id="relayoutGraph">重新布局</button></span></div><div class="graph-legend" aria-label="连线类型与最近消息状态图例"><span><i style="--edge-color:var(--type-assign)"></i>协调 / 分配</span><span><i style="--edge-color:var(--type-peer)"></i>成员协作</span><span><i style="--edge-color:var(--type-review)"></i>审查</span><span><i style="--edge-color:var(--type-other)"></i>其他</span><span><b class="legend-dot"></b>! 最近阻塞 · 虚线</span><span><b class="legend-dot complete"></b>✓ 最近完成 · 点线</span></div><div class="live-room" id="liveRoom"><div class="live-scroll" id="liveScroll" tabindex="0" role="region" aria-label="全员通信概览"><div class="graph-canvas" id="graphCanvas"><div id="graphWorld"><svg class="graph-lines" id="graphLines" role="group" aria-label="成员通信连线，可聚焦查看类型与状态"></svg><div class="live-grid" id="liveGrid"></div><svg class="mail-layer" id="mailLayer" aria-hidden="true"></svg></div></div><p class="empty" id="liveEmpty">等待小伙伴加入…</p></div><div class="live-foot"><span id="graphSummary">正在读取通信联系…</span><span id="liveCaption">成员动作映射当前活动 · 信封只播放新增消息</span></div></div></section><aside class="ledger-panel" aria-labelledby="ledgerTitle"><div class="ledger-heading"><div><h2 id="ledgerTitle">任务账本</h2><p class="sub">任务状态以账本为准</p></div><span class="badge">只读</span></div><p id="ledgerSource" class="ledger-source">正在读取账本来源…</p><p id="ledgerNotice" class="ledger-notice"></p><div class="ledger-toolbar"><label class="field">筛选任务<input id="ledgerSearch" type="search" placeholder="任务 ID、标题或 Owner" autocomplete="off"></label><label class="field">状态<select id="ledgerStatus"><option value="">全部状态</option></select></label></div><div class="ledger-selection" id="ledgerSelection" hidden><span id="ledgerSelectionText"></span><button type="button" id="clearLedgerSelection">清除</button></div><div id="ledgerTasks" class="ledger-tasks"></div><p id="ledgerEmpty" class="empty">等待账本数据</p><div id="ledgerTaskDetail" class="ledger-task-detail" hidden></div></aside></div>
<div class="workspace"><section id="members" aria-labelledby="membersTitle"><div class="section-head"><h2 id="membersTitle" tabindex="-1">团队成员<span class="count" id="memberCount"></span></h2><button type="button" id="clearScope" class="text-button" hidden>显示全部成员</button></div><div class="panel member-list-wrap"><div class="member-list"><div class="members-head"><span>成员 / 角色</span><span>执行活动</span><span>协议阶段</span><span>最近活动</span></div><div id="memberRows"></div><div class="empty" id="membersEmpty">正在读取团队活动…</div></div></div></section><aside class="aside"><section aria-labelledby="attentionTitle"><div class="section-head"><h2 id="attentionTitle">待关注</h2><span class="badge" id="attentionCount">—</span></div><div class="panel"><div class="attention-head"><span>当前状态提醒</span><span aria-hidden="true">◷</span></div><div class="attention-list" id="attention"></div><p class="empty" id="attentionEmpty">等待首次数据</p></div></section><section class="guide"><h3>如何理解这些状态？</h3><p><strong>执行活动</strong>来自工具与输出记录；<strong>协议阶段</strong>来自最近协作消息，二者独立。</p><p>“已完成”后仍可能执行工具。“久未活动”不能区分会话关闭和空闲。</p><p>角色根据通信推断；Leader 标签不代表唯一现任负责人。</p></section></aside></div>
<section class="messages" id="messages" aria-labelledby="messagesTitle"><div class="section-head"><div class="message-title"><h2 id="messagesTitle" tabindex="-1">通信记录</h2><span class="badge">原生协议消息</span></div><span class="sub" id="retained"></span></div><div class="panel"><div class="filters"><label class="field search">搜索记录<input type="search" id="search" placeholder="搜索成员、消息 ID、类型或引用…" autocomplete="off"></label><label class="field">消息类型<select id="typeFilter"><option value="">全部类型</option></select></label><label class="field">相关成员<select id="memberFilter"><option value="">全部成员</option></select></label><button type="button" id="clearFilters">清除</button></div><div class="tablewrap" tabindex="0" role="region" aria-label="消息记录，可横向滚动"><table><thead><tr><th scope="col">时间</th><th scope="col">发送 → 接收</th><th scope="col">消息类型</th><th scope="col">消息 ID</th><th scope="col">回复 RE</th><th scope="col">状态 / 引用</th></tr></thead><tbody id="msgs"><tr><td colspan="6" class="empty">正在读取通信记录…</td></tr></tbody></table></div><div class="table-foot"><span id="resultCount">等待首次数据</span><span>仅保留最近 300 条 · 最多显示 100 条匹配记录</span></div></div></section>
<footer class="footer"><span>基于本机 session transcripts 推断 · 不包含 herdr 与其他机器上的通信</span><span>Agent Team Bootstrap / Local Dashboard</span></footer>
</main>
<dialog id="detail" aria-labelledby="detailTitle"><div class="drawer-top"><p>成员详情 / SESSION DETAILS</p><button type="button" id="closeDetail" aria-label="关闭成员详情" autofocus>×</button></div><div class="drawer-content"><div class="drawer-identity"><div id="detailAvatar"></div><div><h2 id="detailTitle"></h2><div id="detailTags"></div></div></div><p id="missing" class="notice" hidden>该会话已不在当前数据范围。</p><div id="detailData"><div class="drawer-status"><div><h3>执行活动</h3><div id="detailExec"></div></div><div><h3>协议阶段</h3><div id="detailProto"></div></div></div><h3>当前工具 / 执行活动</h3><div id="detailTool" class="detail-box mono"></div><h3>最近输出</h3><div id="detailText" class="detail-box"></div><h3>会话信息</h3><dl><dt>Session</dt><dd id="detailId" class="mono"></dd><dt>工作目录</dt><dd id="detailCwd" class="mono"></dd><dt>最后活动</dt><dd id="detailTime"></dd></dl><h3>近期工具</h3><ul id="detailTools" class="tools"></ul><h3>关联账本任务</h3><div id="detailTasks" class="detail-tasks"></div><h3>通信对象 <span class="muted">· 当前消息窗口内</span></h3><div id="detailPeers" class="peers"></div><h3>最近相关消息</h3><div id="detailMessages"></div></div><button type="button" class="primary" id="viewMessages">查看该成员的通信记录 →</button></div></dialog>
<script src="/vendor/d3-7.9.0.min.js"></script>
<script>
(function(){
'use strict';
// 纯显示与筛选规则同时由浏览器和测试使用。
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function hms(t){return new Date(t).toLocaleTimeString('zh-CN',{hour12:false})}
function ago(ms){var s=Math.max(0,Math.floor(ms/1000));return s<60?s+' 秒前':s<3600?Math.floor(s/60)+' 分钟前':s<86400?Math.floor(s/3600)+' 小时前':Math.floor(s/86400)+' 天前'}
function hash(str){var h=0;for(var i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))>>>0;return h}
var EXEC={RUNNING:['执行中','◉','good'],IDLE:['暂无执行','○','neutral'],STALE:['久未活动','◷','warn']};
var PROTO={NONE:['暂无阶段','—','neutral'],COORDINATING:['协调中','◇','neutral'],JOINING:['加入中','+','neutral'],ACTIVE:['已就绪','✓','good'],ASSIGNED:['已分配','↗','neutral'],BLOCKED:['协作阻塞','!','bad'],IN_REVIEW:['审查中','◎','neutral'],REVIEWED:['已审查','✓','good'],COMPLETE:['已完成','✓','good']};
function status(value,kind){var info=(kind==='exec'?EXEC:PROTO)[value]||[value||'未知','◇','neutral'];return '<span class="status '+info[2]+'" data-symbol="'+info[1]+'">'+esc(info[0])+'</span><span class="raw mono">'+esc(value||'UNKNOWN')+'</span>'}
function scopeMatches(s,scope){return scope==='running'?s.exec==='RUNNING':scope==='blocked'?s.proto==='BLOCKED':scope==='stale'?s.exec==='STALE':true}
function counts(sessions){return {total:sessions.length,running:sessions.filter(function(s){return scopeMatches(s,'running')}).length,blocked:sessions.filter(function(s){return scopeMatches(s,'blocked')}).length,stale:sessions.filter(function(s){return scopeMatches(s,'stale')}).length}}
function attentionSessions(sessions){return sessions.filter(function(s){return s.proto==='BLOCKED'||s.exec==='STALE'})}
function matchingMessages(messages,type,member,query){var q=query.trim().toLowerCase();return messages.filter(function(m){return (!type||m.type===type)&&(!member||m.from===member||m.to===member)&&(!q||[m.type,m.fromLabel,m.toLabel,m.from,m.to,m.id,m.re,m.status,m.ref].join(' ').toLowerCase().includes(q))})}
function avatar(client){var known={claude:['CC','Claude Code'],codex:['CX','Codex CLI']},item=known[client]||['>_','CLI'];return '<span class="avatar cli-icon '+(known[client]?client:'generic')+'" role="img" aria-label="'+item[1]+'"><span class="terminal-bar" aria-hidden="true">•••</span><b>'+item[0]+'</b></span>'}
function cardState(s){return s.proto==='BLOCKED'?'blocked':s.exec==='STALE'?'stale':s.exec==='RUNNING'?'running':s.proto==='IN_REVIEW'?'review':s.proto==='COMPLETE'?'complete':'idle'}
function messageKey(m){return JSON.stringify([m.from,m.id||[m.ts,m.type,m.to]])}
function newMessages(messages,previous){return previous===null?[]:messages.filter(function(m){return !previous.has(messageKey(m))}).slice(-4)}
function edgeType(type){return /REVIEW/.test(type||'')?'review':/^(PEER|SCOPE)/.test(type||'')?'peer':/^(ASSIGN|JOIN|ACK|COORDINAT)|_ACK$/.test(type||'')?'assign':'other'}
function edgeState(m){return m.type==='BLOCKED'||/blocked|reject|fail/i.test(m.status||'')?'blocked':m.type==='COMPLETE'||/approved|complete|success/i.test(m.status||'')?'complete':'observed'}
function communicationGraph(sessions,messages,previous,viewport){
  var ids=sessions.map(function(s){return s.id}).sort(),valid=new Set(ids),adj=new Map(ids.map(function(id){return [id,new Set()]})),edges=new Map();
  messages.forEach(function(m){if(m.from===m.to||!valid.has(m.from)||!valid.has(m.to))return;var pair=[m.from,m.to].sort(),key=JSON.stringify(pair),edge=edges.get(key);if(!edge){edge={pair:pair,latest:m,count:0};edges.set(key,edge)}edge.count++;if((m.ts||0)>=(edge.latest.ts||0))edge.latest=m;adj.get(m.from).add(m.to);adj.get(m.to).add(m.from)});
  var order=previous?previous.order.filter(function(id){return valid.has(id)}):[],placed=new Set(order);ids.forEach(function(id){if(!placed.has(id))order.push(id)});edges.forEach(function(e){e.category=edgeType(e.latest.type);e.state=edgeState(e.latest)});
  return {order:order,edges:edges,adj:adj};
}
function forceLayout(d3lib,graph,previous,width,height,mobile){
  var cardW=mobile?132:210,cardH=mobile?74:116,radius=Math.hypot(cardW,cardH)/2+18,spread=Math.max(radius*1.6,graph.order.length*radius/Math.PI),nodes=graph.order.map(function(id,i){var old=previous?.get(id),angle=i/Math.max(1,graph.order.length)*Math.PI*2;return {id:id,x:old?.x??Math.cos(angle)*spread,y:old?.y??Math.sin(angle)*spread,width:cardW,height:cardH}}),links=Array.from(graph.edges.values(),function(e){return {source:e.pair[0],target:e.pair[1]}});
  var simulation=d3lib.forceSimulation(nodes).stop().force('link',d3lib.forceLink(links).id(function(n){return n.id}).distance(radius*2.8).strength(.035)).force('charge',d3lib.forceManyBody().strength(-160)).force('collision',d3lib.forceCollide(radius).strength(1).iterations(4)).force('x',d3lib.forceX(0).strength(mobile?.12:.012)).force('y',d3lib.forceY(0).strength(mobile?.008:.08));
  simulation.tick(220);return {nodes:nodes,simulation:simulation};
}
function curvePath(a,b,nodes){
  var dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,best=null;
  [-.22,.22,-.48,.48,0].forEach(function(bend){var cx=(a.x+b.x)/2-dy*bend,cy=(a.y+b.y)/2+dx*bend;function port(n,x,y){var vx=x-n.x,vy=y-n.y,k=1/Math.max(Math.abs(vx)/(n.width/2+3),Math.abs(vy)/(n.height/2+3),.001);return {x:n.x+vx*k,y:n.y+vy*k}}var p=port(a,cx,cy),q=port(b,cx,cy),hits=0;for(var i=1;i<24;i++){var t=i/24,u=1-t,x=u*u*p.x+2*u*t*cx+t*t*q.x,y=u*u*p.y+2*u*t*cy+t*t*q.y;nodes.forEach(function(n){if(n!==a&&n!==b&&Math.abs(x-n.x)<n.width/2+5&&Math.abs(y-n.y)<n.height/2+5)hits++})}if(!best||hits<best.hits)best={hits:hits,d:'M '+p.x+' '+p.y+' Q '+cx+' '+cy+' '+q.x+' '+q.y,end:q}});return best;
}
// DOM 与轮询状态。
var $=function(s){return document.querySelector(s)},params=new URLSearchParams(location.search),demo=params.get('demo')==='1';
var lastState=null,scope='all',selectedId=null,opener=null,paused=false,inFlight=false,lastSuccess=0,connectionError='',rows=new Map(),attentionRows=new Map(),peerRows=new Map();
var detail=$('#detail');
var stageRows=new Map(),seenMessages=null,motionEnabled=true,motion=matchMedia('(prefers-reduced-motion: reduce)'),flights=new Set();
function motionAllowed(){return motionEnabled&&!motion.matches&&!paused&&!document.hidden&&!connectionError}
function syncMotion(){var enabled=motionAllowed();$('#liveRoom').classList.toggle('motion-off',!enabled);$('#motionToggle').setAttribute('aria-pressed',String(motionEnabled&&!motion.matches));$('#motionToggle').textContent=motion.matches?'系统已减少动态':motionEnabled?'暂停动画':'开启动画';$('#motionToggle').disabled=motion.matches;setText('#liveCaption',enabled?'成员动作映射当前活动 · 信封只播放新增消息':'动画已暂停 · 姓名、状态与记录仍可查看');if(!enabled){flights.forEach(function(f){f.cancel()});if(simulation)simulation.stop()}}
$('#motionToggle').onclick=function(){motionEnabled=!motionEnabled;syncMotion()};motion.addEventListener('change',syncMotion);
var graph=null,pendingGraphFrame=0,forceNodes=new Map(),simulation=null,layoutSignature='',viewTransform=null,zoomBehavior=null,edgeRows=new Map();
function graphViewport(){var region=$('#liveScroll'),top=region.getBoundingClientRect().top+window.scrollY;return {width:region.clientWidth,height:Math.max(300,innerHeight-top-55)}}
function applyView(transform){viewTransform=transform;$('#graphWorld').style.transform='translate('+transform.x+'px,'+transform.y+'px) scale('+transform.k+')'}
function fitGraph(){if(!forceNodes.size)return;var box=graphViewport(),nodes=Array.from(forceNodes.values()),x0=Math.min.apply(null,nodes.map(function(n){return n.x-n.width/2})),x1=Math.max.apply(null,nodes.map(function(n){return n.x+n.width/2})),y0=Math.min.apply(null,nodes.map(function(n){return n.y-n.height/2})),y1=Math.max.apply(null,nodes.map(function(n){return n.y+n.height/2})),k=Math.min(1.1,(box.width-24)/(x1-x0),(box.height-24)/(y1-y0));d3.select($('#graphCanvas')).call(zoomBehavior.transform,d3.zoomIdentity.translate(box.width/2-(x0+x1)/2*k,box.height/2-(y0+y1)/2*k).scale(k))}
function highlightGraph(id){edgeRows.forEach(function(el,key){var pair=JSON.parse(key);el.classList.toggle('dimmed',!!id&&!pair.includes(id));el.classList.toggle('highlighted',!!id&&pair.includes(id))})}
function positionGraph(){if(!graph)return;graph.paths=new Map();stageRows.forEach(function(seat,id){var n=forceNodes.get(id);if(!n)return;seat.style.left=(n.x-n.width/2)+'px';seat.style.top=(n.y-n.height/2)+'px';seat.style.width=n.width+'px';seat.style.height=n.height+'px'});graph.edges.forEach(function(edge,key){var a=forceNodes.get(edge.pair[0]),b=forceNodes.get(edge.pair[1]),curve=curvePath(a,b,Array.from(forceNodes.values()));graph.paths.set(key,curve.d);var el=edgeRows.get(key);if(el){el.querySelector('.edge-hit').setAttribute('d',curve.d);el.querySelector('.edge-line').setAttribute('d',curve.d);var marker=el.querySelector('circle');marker.setAttribute('cx',curve.end.x);marker.setAttribute('cy',curve.end.y)}})}
function drawGraph(){if(!graph||!lastState||typeof d3==='undefined')return;var box=graphViewport(),canvas=$('#graphCanvas');canvas.style.width=box.width+'px';canvas.style.height=box.height+'px';$('#graphWorld').style.width=box.width+'px';$('#graphWorld').style.height=box.height+'px';
  var signature=JSON.stringify([graph.order,Array.from(graph.edges.keys()).sort(),Math.round(box.width),Math.round(box.height)]),changed=signature!==layoutSignature;
  if(changed){flights.forEach(function(f){f.cancel()});if(simulation)simulation.stop();var layout=forceLayout(d3,graph,forceNodes,box.width,box.height,box.width<600);forceNodes=new Map(layout.nodes.map(function(n){return [n.id,n]}));simulation=layout.simulation;layoutSignature=signature;simulation.on('tick',positionGraph).on('end',fitGraph)}
  keyed($('#graphLines'),edgeRows,Array.from(graph.edges,function(entry){return {id:entry[0],edge:entry[1]}}),function(item){var g=document.createElementNS('http://www.w3.org/2000/svg','g');g.setAttribute('class','edge');g.setAttribute('tabindex','0');g.setAttribute('role','img');g.innerHTML='<title></title><path class="edge-hit"/><path class="edge-line"/><circle class="edge-marker" r="4"/>';g.addEventListener('pointerenter',function(){g.classList.add('highlighted')});g.addEventListener('pointerleave',function(){g.classList.remove('highlighted')});return g},function(el,item){var e=item.edge,m=e.latest,label=e.pair.map(function(id){return lastState.sessions.find(function(s){return s.id===id}).name}).join(' ↔ ')+'；最近 '+m.type+'；'+(m.status||e.state);el.setAttribute('aria-label',label);el.querySelector('title').textContent=label;el.dataset.state=e.state;el.style.setProperty('--edge-color','var(--type-'+e.category+')')});
  stageRows.forEach(function(seat,id){if(seat._dragBound)return;seat._dragBound=true;seat.addEventListener('pointerenter',function(){highlightGraph(id)});seat.addEventListener('pointerleave',function(){highlightGraph(null)});seat.addEventListener('focus',function(){highlightGraph(id)});seat.addEventListener('blur',function(){highlightGraph(null)});d3.select(seat).call(d3.drag().container(function(){return $('#graphWorld')}).subject(function(){return forceNodes.get(id)}).clickDistance(5).on('start',function(e){flights.forEach(function(f){f.cancel()});var n=forceNodes.get(id);n.fx=n.x;n.fy=n.y;if(motionAllowed())simulation.alphaTarget(.15).restart()}).on('drag',function(e){var n=forceNodes.get(id);n.fx=n.x+=(e.sourceEvent?.movementX||e.dx)/(viewTransform?.k||1);n.fy=n.y+=(e.sourceEvent?.movementY||e.dy)/(viewTransform?.k||1);positionGraph()}).on('end',function(){var n=forceNodes.get(id);n.fx=null;n.fy=null;simulation.alphaTarget(0).stop();positionGraph()}))});
  positionGraph();if(changed)fitGraph();setText('#graphSummary',graph.order.length+' 位成员 · '+graph.edges.size+' 条通信联系 · 拖动成员，滚轮缩放');
}
function initializeCanvas(){if(typeof d3==='undefined'){setText('#liveEmpty','图布局库未加载，请检查本地 vendor 文件。');return}zoomBehavior=d3.zoom().scaleExtent([.2,3]).filter(function(e){return !e.target.closest('.live-seat,.edge')&&(!e.ctrlKey||e.type==='wheel')&&!e.button}).on('zoom',function(e){flights.forEach(function(f){f.cancel()});applyView(e.transform)});d3.select($('#graphCanvas')).call(zoomBehavior).on('dblclick.zoom',null);$('#fitGraph').onclick=fitGraph;$('#relayoutGraph').onclick=function(){forceNodes=new Map();layoutSignature='';drawGraph()}}
initializeCanvas();
function renderStage(st){
  graph=communicationGraph(st.sessions,st.messages,graph);
  $('#liveEmpty').hidden=!!st.sessions.length;
  var list=graph.order.map(function(id){return st.sessions.find(function(s){return s.id===id})});
  keyed($('#liveGrid'),stageRows,list,function(s){var seat=document.createElement('button');seat.type='button';seat.className='live-seat';seat.dataset.open=s.id;seat.style.setProperty('--phase',-(hash(s.id)%45)/10+'s');seat.innerHTML='<span class="card-top"><span class="seat-art"></span><span class="card-identity"><strong></strong><span class="seat-tags"></span></span><span class="seat-state"></span></span><span class="card-activity"></span><span class="card-proto"></span><span class="card-bottom"><span class="seat-time"></span><span class="peer-count"></span></span>';return seat},function(seat,s){setHTML(seat.querySelector('.seat-art'),avatar(s.client));seat.dataset.exec=s.exec;seat.dataset.proto=s.proto;seat.dataset.role=s.role;seat.dataset.cardState=cardState(s);seat.querySelector('strong').textContent=s.name;seat.querySelector('strong').title=s.name;seat.querySelector('.seat-tags').textContent=clientName(s)+' · '+s.role+' · '+s.short;setHTML(seat.querySelector('.seat-state'),status(s.exec,'exec'));setHTML(seat.querySelector('.card-proto'),status(s.proto,'proto'));var text=s.exec==='RUNNING'?(s.tool||'正在生成内容或处理工具结果'):(s.lastText||'暂无最近输出');seat.querySelector('.card-activity').textContent=text;seat.querySelector('.card-activity').title=text;seat.querySelector('.seat-time').textContent=s.lastTs?'活动于 '+ago(Date.now()-s.lastTs):'活动时间未知';seat.querySelector('.peer-count').textContent=graph.adj.get(s.id).size+' 位通信对象 ›';seat.setAttribute('aria-label','查看 '+s.name+' 的成员详情，'+(EXEC[s.exec]?.[0]||s.exec)+'，'+(PROTO[s.proto]?.[0]||s.proto))});
  drawGraph();
  var fresh=newMessages(st.messages,seenMessages);seenMessages=new Set(st.messages.map(messageKey));if(motionAllowed())fresh.forEach(fly);syncMotion();
}
var selectedTaskId=null,ledgerWorkerId=null,taskRows=new Map();
var TASK_LABELS={QUEUED:'待执行',ASSIGNED:'已分配',PAUSED:'已暂停',DONE:'已完成',STOPPED:'已停止',REVIEW_PENDING:'待审查'};
function ledgerTasksFor(st,id){return (st.ledger?.tasks||[]).filter(function(t){return t.ownerSessionId===id||t.reviewerSessionId===id})}
function applyTaskHighlight(){var task=lastState?.ledger?.tasks?.find(function(t){return t.id===selectedTaskId}),ids=task?[task.ownerSessionId,task.reviewerSessionId].filter(Boolean):ledgerWorkerId?[ledgerWorkerId]:[];stageRows.forEach(function(seat,id){seat.classList.toggle('task-linked',ids.includes(id));seat.classList.toggle('task-unrelated',!!ids.length&&!ids.includes(id))});if(ids.length===1)highlightGraph(ids[0]);else highlightGraph(null)}
function selectLedgerTask(id){selectedTaskId=id;ledgerWorkerId=null;if(detail.open)detail.close();renderLedger(lastState);applyTaskHighlight()}
function renderLedger(st){var ledger=st.ledger||{status:'unavailable',tasks:[],error:'未配置账本'},tasks=ledger.tasks||[],query=$('#ledgerSearch').value.trim().toLowerCase(),statusFilter=$('#ledgerStatus').value;setText('#ledgerSource',ledger.source==='git'?(ledger.ref||'Git')+' · '+(ledger.commit||'').slice(0,10):ledger.source==='directory'?'工作区快照 · 非固定 commit':ledger.source==='demo'?'演示账本 · 模拟数据':'账本未接入');$('#ledgerSource').title=ledger.sourcePath||'';setText('#ledgerNotice',ledger.error||(ledger.diagnostics||[]).map(function(d){return d.message||String(d)}).join('；')||(ledger.source==='git'?'本地 Git 快照，不自动拉取远端':'任务状态与 Worker 执行活动分别记录'));updateOptions($('#ledgerStatus'),[['','全部状态']].concat(Array.from(new Set(tasks.map(function(t){return t.status}))).map(function(s){return [s,TASK_LABELS[s]||s]})));
  var list=tasks.filter(function(t){return (!query||[t.id,t.title,t.owner,t.reviewer].join(' ').toLowerCase().includes(query))&&(!statusFilter||t.status===statusFilter)&&(!ledgerWorkerId||t.ownerSessionId===ledgerWorkerId||t.reviewerSessionId===ledgerWorkerId)});$('#ledgerEmpty').hidden=!!list.length;setText('#ledgerEmpty',tasks.length?'没有匹配的任务。':ledger.status==='ok'?'账本暂无任务。':'未读取到任务。请使用 --ledger-repo 指向账本仓库，或 --ledger-dir 指定包含 plan.md / roster.md 的目录。');$('#ledgerSelection').hidden=!selectedTaskId&&!ledgerWorkerId;setText('#ledgerSelectionText',ledgerWorkerId?'筛选成员：'+(st.sessions.find(function(s){return s.id===ledgerWorkerId})?.name||ledgerWorkerId):selectedTaskId?'选中任务：'+selectedTaskId:'');
  keyed($('#ledgerTasks'),taskRows,list,function(t){var b=document.createElement('button');b.type='button';b.className='ledger-task';b.dataset.task=t.id;return b},function(b,t){b.dataset.status=t.status;b.setAttribute('aria-pressed',String(t.id===selectedTaskId));var ownerSession=st.sessions.find(function(s){return s.id===t.ownerSessionId});setHTML(b,'<span class="task-meta"><code>'+esc(t.id)+'</code><span>'+esc(t.priority||'—')+'</span><span class="task-status">'+esc(TASK_LABELS[t.status]||t.status)+'</span></span><strong>'+esc(t.title)+'</strong><span class="task-owner">Owner · '+esc(t.owner||'未记录')+' <span>'+esc(ownerSession?'已关联 · '+(EXEC[ownerSession.exec]?.[0]||ownerSession.exec):'未关联')+'</span></span>')});
  var t=tasks.find(function(t){return t.id===selectedTaskId});$('#ledgerTaskDetail').hidden=!t;if(t){var member=function(kind){var id=t[kind+'SessionId'],name=t[kind]||'未记录';return id?'<button type="button" data-open="'+esc(id)+'">'+esc(name)+' ↗</button>':esc(name)+' · '+esc(t[kind+'LinkReason']||'未关联当前会话')};setHTML($('#ledgerTaskDetail'),'<h3>'+esc(t.id)+' · 任务详情</h3><dl><dt>状态</dt><dd>'+esc(TASK_LABELS[t.status]||t.status)+' <code>'+esc(t.status)+'</code></dd><dt>Owner</dt><dd>'+member('owner')+'</dd><dt>Reviewer</dt><dd>'+member('reviewer')+'</dd><dt>Mission</dt><dd>'+esc(t.mission||'未记录')+'</dd><dt>依赖</dt><dd>'+esc((t.dependsOn||[]).join(' · ')||'未记录')+'</dd><dt>DUE</dt><dd>'+esc(t.due||'未记录')+'</dd><dt>回执 / 证据</dt><dd>'+esc((t.receipts||[]).join(' · ')||'未记录')+'</dd></dl><p class="sub">任务状态来自账本；成员活动不代表该任务的执行证据。</p>')}
  applyTaskHighlight();
}
$('#detailTasks').addEventListener('click',function(e){var t=e.target.closest('[data-task]');if(t)selectLedgerTask(t.dataset.task)});
$('#ledgerTasks').addEventListener('click',function(e){var t=e.target.closest('[data-task]');if(t)selectLedgerTask(t.dataset.task)});['#ledgerSearch','#ledgerStatus'].forEach(function(s){$(s).addEventListener(s==='#ledgerSearch'?'input':'change',function(){if(lastState)renderLedger(lastState)})});$('#clearLedgerSelection').onclick=function(){selectedTaskId=null;ledgerWorkerId=null;renderLedger(lastState)};
function reactSeat(seat,type){seat.classList.remove('reacting');void seat.offsetWidth;seat.classList.add('reacting');var bubble=document.createElement('span');bubble.className='seat-bubble';bubble.textContent=type;seat.appendChild(bubble);setTimeout(function(){bubble.remove()},1500)}
function fly(m){
  var from=stageRows.get(m.from),to=stageRows.get(m.to);if(!from||!to||flights.size>=4||!motionAllowed())return;
  var d=graph.paths.get(JSON.stringify([m.from,m.to].sort()));if(!d){reactSeat(from,m.type);reactSeat(to,m.type);return}
  var scroll=$('#liveScroll'),base=scroll.getBoundingClientRect(),a=from.getBoundingClientRect(),b=to.getBoundingClientRect();if(a.bottom<base.top||b.bottom<base.top||a.top>base.bottom||b.top>base.bottom||a.right<base.left||b.right<base.left||a.left>base.right||b.left>base.right)return;
  var NS='http://www.w3.org/2000/svg',path=document.createElementNS(NS,'path');path.setAttribute('d',d);path.setAttribute('visibility','hidden');$('#mailLayer').appendChild(path);var length=path.getTotalLength(),reverse=m.from!==graph.edges.get(JSON.stringify([m.from,m.to].sort())).pair[0],g=document.createElementNS(NS,'g');g.setAttribute('class','mail-token');g.style.setProperty('--accent','var(--type-'+edgeType(m.type)+')');g.innerHTML='<rect x="-10" y="-7" width="20" height="14" rx="3" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.5"/><path d="M-8 -5L0 1L8 -5" fill="none" stroke="var(--accent)" stroke-width="1.5"/>';$('#mailLayer').appendChild(g);
  from.classList.add('sending');var frame,started=null,bubble=document.createElement('span');bubble.className='seat-bubble';bubble.textContent=m.type;from.appendChild(bubble);var flight={cancel:function(){cancelAnimationFrame(frame);g.remove();path.remove();bubble.remove();from.classList.remove('sending');flights.delete(flight)}};flights.add(flight);
  function step(t){if(!motionAllowed()||!from.isConnected||!to.isConnected){flight.cancel();return}if(started===null)started=t;var p=Math.min(1,(t-started)/1500),point=path.getPointAtLength((reverse?1-p:p)*length);g.setAttribute('transform','translate('+point.x+','+point.y+')');if(p<1)frame=requestAnimationFrame(step);else{flight.cancel();reactSeat(to,m.type)}}frame=requestAnimationFrame(step);
}
$('#liveGrid').addEventListener('animationend',function(e){if(e.animationName==='character-hop')e.target.closest('.live-seat')?.classList.remove('reacting')});
$('#liveScroll').addEventListener('scroll',function(){flights.forEach(function(f){f.cancel()})});new ResizeObserver(function(){flights.forEach(function(f){f.cancel()});cancelAnimationFrame(pendingGraphFrame);pendingGraphFrame=requestAnimationFrame(drawGraph)}).observe($('#liveScroll'));window.addEventListener('resize',function(){cancelAnimationFrame(pendingGraphFrame);pendingGraphFrame=requestAnimationFrame(drawGraph)});
function setText(selector,text){var node=$(selector);if(node.textContent!==String(text))node.textContent=text}
function setHTML(node,html){if(node._html!==html){node.innerHTML=html;node._html=html}}
function clientName(s){return s.client==='codex'?'Codex':s.client==='claude'?'Claude':s.client}
function roleName(s){return ({Leader:'协调者',Worker:'执行者',Reviewer:'审查者'})[s.role]||s.role}
function updateOptions(select,options){var selected=select.value,available=new Set(options.map(function(o){return o[0]}));if(selected&&!available.has(selected))options.push([selected,(select.selectedOptions[0]?.textContent||selected)+'（当前无数据）']);var signature=JSON.stringify(options);if(select._options===signature)return;select._options=signature;select.replaceChildren.apply(select,options.map(function(o){var n=document.createElement('option');n.value=o[0];n.textContent=o[1];return n}));select.value=selected}
function keyed(container,map,items,make,update){var alive=new Set();items.forEach(function(item,index){alive.add(item.id);var row=map.get(item.id);if(!row){row=make(item);map.set(item.id,row)}update(row,item);var at=container.children[index];if(at!==row)container.insertBefore(row,at||null)});map.forEach(function(row,id){if(!alive.has(id)){if(row.contains(document.activeElement))$(detail.open?'#closeDetail':'#membersTitle').focus();row.remove();map.delete(id)}})}
function renderMembers(st){var list=st.sessions.filter(function(s){return scopeMatches(s,scope)}).slice().sort(function(a,b){return (b.role==='Leader')-(a.role==='Leader')||a.name.localeCompare(b.name)||a.id.localeCompare(b.id)});setText('#memberCount',list.length+' / '+st.sessions.length);$('#clearScope').hidden=scope==='all';$('#membersEmpty').hidden=!!list.length;setText('#membersEmpty',st.sessions.length?'没有符合当前状态的成员。':'当前项目暂无团队活动。请确认项目名、日志目录与启动时间范围；成员需有对应项目的协议通信。');
keyed($('#memberRows'),rows,list,function(s){var row=document.createElement('article');row.className='member-row';row.innerHTML='<div class="member-id"><div class="member-avatar"></div><div class="identity"><button type="button" class="member-name" data-open=""></button><div class="sub"><span class="member-role"></span><span class="member-client badge"></span><code class="member-short"></code></div></div></div><div class="member-exec"></div><div class="member-proto"></div><div class="activity"><div class="activity-text"></div><div class="member-actions"><span class="sub member-time"></span><button type="button" class="text-button" data-messages="">查看消息 ↗</button></div></div>';row.querySelector('[data-open]').dataset.open=s.id;row.querySelector('[data-messages]').dataset.messages=s.id;return row},function(row,s){setHTML(row.querySelector('.member-avatar'),avatar(s.client));var name=row.querySelector('.member-name');name.textContent=s.name;name.setAttribute('aria-label','查看 '+s.name+' 的成员详情');row.querySelector('.member-role').textContent=s.role+' · '+roleName(s);row.querySelector('.member-client').textContent=clientName(s);row.querySelector('.member-short').textContent=s.short;row.querySelector('.member-short').title=s.id;setHTML(row.querySelector('.member-exec'),status(s.exec,'exec'));setHTML(row.querySelector('.member-proto'),status(s.proto,'proto'));var activity=row.querySelector('.activity-text');activity.textContent=s.exec==='RUNNING'?(s.tool||'正在生成内容或处理工具结果'):s.lastText||'暂无输出记录';activity.title=activity.textContent;var time=row.querySelector('.member-time');time.textContent=s.lastTs?ago(Date.now()-s.lastTs):'时间未知';time.title=s.lastTs?new Date(s.lastTs).toLocaleString('zh-CN'):''})}
function renderAttention(st){var list=attentionSessions(st.sessions);setText('#attentionCount',list.length);$('#attentionEmpty').hidden=!!list.length;setText('#attentionEmpty','当前未发现协作阻塞或久未活动的成员。');keyed($('#attention'),attentionRows,list,function(s){var row=document.createElement('div');row.className='attention-item';row.innerHTML='<button type="button" data-open=""></button><p></p><div class="reasons"></div>';row.querySelector('button').dataset.open=s.id;return row},function(row,s){row.querySelector('button').textContent=s.name;row.querySelector('p').textContent=s.lastTs?'最后活动 '+ago(Date.now()-s.lastTs):'暂无活动时间';setHTML(row.querySelector('.reasons'),(s.proto==='BLOCKED'?'<span class="reason bad">! 协议阻塞</span> ':'')+(s.exec==='STALE'?'<span class="reason">◷ 超过 30 分钟无活动</span>':''))})}
function renderMessages(st){updateOptions($('#typeFilter'),[['','全部类型']].concat(Array.from(new Set(st.messages.map(function(m){return m.type}))).sort().map(function(t){return [t,t]})));updateOptions($('#memberFilter'),[['','全部成员']].concat(st.sessions.map(function(s){return [s.id,s.name+' · '+s.short]})));var matches=matchingMessages(st.messages,$('#typeFilter').value,$('#memberFilter').value,$('#search').value),list=matches.slice(-100).reverse();setText('#retained',st.messages.length+' 条保留记录');setText('#resultCount','显示 '+list.length+' 条 / 匹配 '+matches.length+' 条');setHTML($('#msgs'),list.map(function(m){return '<tr><td class="mono" title="'+esc(new Date(m.ts).toLocaleString('zh-CN'))+'">'+esc(hms(m.ts))+'</td><td><div class="route"><span>'+esc(m.fromLabel||'身份未解析')+'</span><span>→ '+esc(m.toLabel||'身份未解析')+'</span></div></td><td><span class="type-label mono">'+esc(m.type)+(m.p2p?'<small>成员间通信 · P2P</small>':'')+'</span></td><td><code>'+esc(m.id||'—')+'</code></td><td><code>'+esc(m.re||'—')+'</code></td><td><code>'+esc([m.status,m.ref].filter(Boolean).join(' · ')||'—')+'</code></td></tr>'}).join('')||'<tr><td colspan="6" class="empty">'+(st.messages.length?'没有匹配记录，请调整或清除筛选。':'当前消息窗口暂无协议记录。')+'</td></tr>')}
function renderDetail(st){if(!selectedId)return;var s=st.sessions.find(function(x){return x.id===selectedId});$('#missing').hidden=!!s;$('#detailData').hidden=!s;$('#viewMessages').disabled=!s;if(!s)return;setText('#detailTitle',s.name);setHTML($('#detailAvatar'),avatar(s.client));setHTML($('#detailTags'),'<span class="badge">'+esc(s.role)+' · '+esc(roleName(s))+'</span><span class="badge">'+esc(clientName(s))+'</span>');setHTML($('#detailExec'),status(s.exec,'exec'));setHTML($('#detailProto'),status(s.proto,'proto'));setText('#detailTool',s.exec==='RUNNING'?(s.tool||'正在生成内容或处理工具结果'):'当前没有执行中的工具记录');setText('#detailText',s.lastText||'暂无输出记录');setText('#detailId',s.id);setText('#detailCwd',s.cwd||'未记录');setText('#detailTime',s.lastTs?new Date(s.lastTs).toLocaleString('zh-CN')+' · '+ago(Date.now()-s.lastTs):'未记录');setHTML($('#detailTools'),s.recentTools.slice().reverse().map(function(t){return '<li class="mono">'+esc(t)+'</li>'}).join('')||'<li class="muted">暂无工具记录</li>');setHTML($('#detailTasks'),ledgerTasksFor(st,s.id).map(function(t){return '<button type="button" data-task="'+esc(t.id)+'">'+esc(t.id)+' · '+esc(t.title)+' · '+esc(t.ownerSessionId===s.id?'负责':'审查')+'</button>'}).join('')||'<span class="muted">无已关联任务</span>');var mine=st.messages.filter(function(m){return m.from===s.id||m.to===s.id}),peers=new Map();mine.forEach(function(m){var id=m.from===s.id?m.to:m.from;if(id)peers.set(id,(peers.get(id)||0)+1)});var peerItems=Array.from(peers,function(p){return {id:p[0],count:p[1],session:st.sessions.find(function(x){return x.id===p[0]})}});keyed($('#detailPeers'),peerRows,peerItems,function(p){var b=document.createElement('button');b.type='button';b.dataset.open=p.id;return b},function(b,p){b.textContent=(p.session?p.session.name:p.id)+' · '+p.count;b.disabled=!p.session});var peerEmpty=$('#detailPeers').querySelector('span');if(!peerItems.length&&!peerEmpty){peerEmpty=document.createElement('span');peerEmpty.className='muted';peerEmpty.textContent='暂无已解析的通信对象';$('#detailPeers').appendChild(peerEmpty)}else if(peerItems.length&&peerEmpty)peerEmpty.remove();setHTML($('#detailMessages'),mine.slice(-12).reverse().map(function(m){return '<div class="drawer-message"><b class="mono">'+esc(m.type)+'</b><small>'+esc(m.from===s.id?'→ '+(m.toLabel||'身份未解析'):'← '+(m.fromLabel||'身份未解析'))+' · '+esc(hms(m.ts))+'</small></div>'}).join('')||'<p class="muted">暂无相关消息</p>')}
function render(st){if(demo)st.ledger=demoLedger(st);lastState=st;setText('#project',st.project);var c=counts(st.sessions);Object.keys(c).forEach(function(k){setText('#'+k,c[k])});renderStage(st);renderMembers(st);renderAttention(st);renderMessages(st);renderDetail(st);renderLedger(st)}
function openDetail(id,trigger){if(!lastState)return;ledgerWorkerId=id;selectedTaskId=null;renderLedger(lastState);if(!detail.open)opener=trigger||document.activeElement;selectedId=id;renderDetail(lastState);if(!detail.open)detail.showModal()}
function showMessages(id){$('#memberFilter').value=id;if(detail.open)detail.close('messages');if(lastState)renderMessages(lastState);$('#messagesTitle').focus();$('#messages').scrollIntoView({block:'start'})}
document.addEventListener('click',function(e){var open=e.target.closest('[data-open]'),messages=e.target.closest('[data-messages]');if(open)openDetail(open.dataset.open,open);if(messages)showMessages(messages.dataset.messages)});
$('#closeDetail').onclick=function(){detail.close()};detail.addEventListener('close',function(){selectedId=null;if(detail.returnValue!=='messages'){if(opener&&opener.isConnected)opener.focus();else $('#membersTitle').focus()}detail.returnValue=''});
Array.from(document.querySelectorAll('[data-scope]')).forEach(function(b){b.onclick=function(){scope=b.dataset.scope;document.querySelectorAll('[data-scope]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});if(lastState)renderMembers(lastState)}});
$('#clearScope').onclick=function(){document.querySelector('[data-scope="all"]').click();$('#membersTitle').focus()};
['#typeFilter','#memberFilter'].forEach(function(selector){$(selector).addEventListener('change',function(){if(lastState)renderMessages(lastState)})});$('#search').addEventListener('input',function(){if(lastState)renderMessages(lastState)});$('#clearFilters').onclick=function(){$('#search').value=$('#typeFilter').value=$('#memberFilter').value='';if(lastState)renderMessages(lastState);$('#search').focus()};
function renderConnection(){var label=connectionError?'连接失败':demo?(demoAt!==null?'演示已冻结':paused?'演示已暂停':'演示数据'):paused?'刷新已暂停':inFlight?'正在刷新':'自动刷新 · 3 秒';setText('#connection',label);$('#connection').dataset.state=connectionError?'error':paused?'paused':'ok';$('#pause').textContent=paused?'继续刷新':'暂停刷新';$('#pause').setAttribute('aria-pressed',String(paused));$('#pause').disabled=demo&&demoAt!==null;$('#refresh').disabled=inFlight||(demo&&demoAt!==null);$('#error').hidden=!connectionError;setText('#error',connectionError?'无法连接 dashboard 服务（'+connectionError+'）。'+(lastSuccess?'当前保留 '+hms(lastSuccess)+' 的数据，可能已过期。':'尚未获取到数据，请确认服务已启动。'):'');setText('#updated',lastSuccess?'最后成功更新 '+hms(lastSuccess):'等待首次数据');syncMotion()}
async function tick(manual){if(inFlight||(!manual&&(paused||document.hidden)))return;if(demo){if(demoAt!==null){if(!lastState){for(var i=0;i<=demoAt;i++)DEMO[i]();render(JSON.parse(JSON.stringify(demoSt)));var id=params.get('open');if(id&&demoSt.sessions.some(function(s){return s.id===id}))openDetail(id)}}else demoTick();lastSuccess=Date.now();renderConnection();return}inFlight=true;renderConnection();try{var response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('HTTP '+response.status);var st=await response.json();render(st);lastSuccess=Date.now();connectionError=''}catch(e){connectionError=e.message;if(!lastState){setText('#membersEmpty','暂时无法读取团队数据，请检查连接后重试。');setText('#attentionEmpty','尚未获取到数据');setHTML($('#msgs'),'<tr><td colspan="6" class="empty">尚未获取到通信记录。</td></tr>')}}finally{inFlight=false;renderConnection()}}
$('#pause').onclick=function(){paused=!paused;renderConnection();if(!paused)tick(true)};$('#refresh').onclick=function(){tick(true)};document.addEventListener('visibilitychange',function(){syncMotion();if(!document.hidden)tick(false)});
// 沿用协议演示，固定步骤便于复查布局与交互。
var demoStep=0,demoSt=null,demoN=0;
function dsess(id,client,role,name){return {id:id,short:id,client:client,cwd:'/work/'+(name||'leader'),workerId:name,name:name||'leader',role:role,proto:role==='Leader'?'COORDINATING':'NONE',exec:'IDLE',tool:'',lastText:'',recentTools:[],lastTs:Date.now()}}
function dmsg(type,from,to,extra){var f=demoSt.sessions.find(function(s){return s.id===from}),t=demoSt.sessions.find(function(s){return s.id===to});var m={ts:Date.now(),type:type,id:'d'+(++demoN),re:null,status:null,ref:null,from:from,to:to,fromLabel:f&&f.name,toLabel:t&&t.name,p2p:!!(f&&t&&f.role!=='Leader'&&t.role!=='Leader')};Object.assign(m,extra||{});demoSt.messages.push(m)}
function dset(id,patch){demoSt.sessions.forEach(function(s){if(s.id===id){Object.assign(s,patch);if(patch.lastTs==null)s.lastTs=Date.now();if(patch.tool)s.recentTools.push(patch.tool)}})}
var DEMO=[
function(){demoSt={project:'demo',sessions:[dsess('L','claude','Leader')],messages:[]};dset('L',{lastText:'等待成员加入团队。'})},
function(){demoSt.sessions.push(dsess('B','claude','Worker','backend-01'));dmsg('JOIN_REQUEST','B','L');dset('B',{proto:'JOINING',exec:'RUNNING',tool:'Bash: git status'})},
function(){dmsg('JOIN_ACK','L','B');demoSt.sessions.push(dsess('F','codex','Worker','frontend-01'));dmsg('JOIN_REQUEST','F','L');dset('F',{proto:'JOINING',exec:'RUNNING',tool:'Read: AGENTS.md'})},
function(){dmsg('ACK_RECEIVED','B','L');dset('B',{proto:'ACTIVE',exec:'IDLE',tool:''});dmsg('JOIN_ACK','L','F');demoSt.sessions.push(dsess('Q','claude','Reviewer','qa-01'));dmsg('JOIN_REQUEST','Q','L');dset('Q',{proto:'JOINING'})},
function(){dmsg('ASSIGN','L','B');dmsg('ASSIGN','L','F');dset('B',{proto:'ASSIGNED',exec:'RUNNING',tool:'Edit: src/api/orders.ts'});dset('F',{proto:'ASSIGNED',exec:'RUNNING',tool:'Edit: ui/OrderList.tsx'});dset('Q',{proto:'ACTIVE'})},
function(){dmsg('PEER_REQUEST','F','B');dset('B',{lastText:'订单状态：pending、paid、cancelled。'})},
function(){dmsg('PEER_REPLY','B','F');dmsg('REVIEW_REQUEST','B','Q',{ref:'PR#42'});dset('B',{proto:'IN_REVIEW',exec:'IDLE',tool:''});dset('Q',{proto:'IN_REVIEW',exec:'RUNNING',tool:'Read: PR#42 diff'})},
function(){dmsg('REVIEW_FEEDBACK','Q','B',{ref:'PR#42#c3'});dset('B',{exec:'RUNNING',tool:'Bash: npm test'})},
function(){dmsg('BLOCKED','F','L');dset('F',{proto:'BLOCKED',exec:'IDLE',tool:''});dmsg('REVIEW_RESULT','Q','B',{status:'approved',ref:'PR#42'})},
function(){dmsg('REVIEW_VERDICT','Q','L',{status:'approved',ref:'PR#42'});dset('Q',{proto:'REVIEWED',exec:'IDLE',tool:''});dmsg('COMPLETE','B','L',{ref:'PR#42'});dset('B',{proto:'COMPLETE',exec:'IDLE',tool:''});dset('F',{proto:'ASSIGNED',exec:'RUNNING',tool:'Bash: npm run build'})},
function(){dset('F',{proto:'ASSIGNED',exec:'IDLE',tool:''});dset('B',{proto:'ACTIVE'});dset('Q',{exec:'STALE',lastTs:Date.now()-31*60000})},
function(){}
];
function demoLedger(st){var has=function(id){return st.sessions.some(function(s){return s.id===id})},worker=st.sessions.find(function(s){return s.id==='B'}),front=st.sessions.find(function(s){return s.id==='F'});return {status:'ok',source:'demo',ref:'team/demo',commit:null,updatedAt:Date.now(),diagnostics:[],tasks:[{id:'WP-17',title:'实现订单 API 与状态校验',priority:'P1',mission:'orders',status:worker?.proto==='COMPLETE'?'DONE':has('B')?'ASSIGNED':'QUEUED',owner:'backend-01',reviewer:'qa-01',ownerSessionId:has('B')?'B':null,reviewerSessionId:has('Q')?'Q':null,dependsOn:[],receipts:worker?.proto==='COMPLETE'?['COMPLETE:d17','REVIEW_VERDICT:d18']:[],due:'未设置'},{id:'WP-18',title:'订单列表与交互',priority:'P1',mission:'orders',status:front?.proto==='BLOCKED'?'PAUSED':has('F')?'ASSIGNED':'QUEUED',owner:'frontend-01',reviewer:'qa-01',ownerSessionId:has('F')?'F':null,reviewerSessionId:has('Q')?'Q':null,dependsOn:['WP-17'],receipts:[],due:''},{id:'WP-19',title:'更新发布操作说明',priority:'P2',status:'QUEUED',owner:'docs-01',reviewer:'none',ownerSessionId:null,reviewerSessionId:null,ownerLinkReason:'演示成员未加入',dependsOn:['WP-17','WP-18'],receipts:[]}]}}
function demoTick(){if(demoStep===0){seenMessages=null;graph=null;layoutSignature='';forceNodes=new Map();flights.forEach(function(f){f.cancel()})}DEMO[demoStep]();demoStep=(demoStep+1)%DEMO.length;render(JSON.parse(JSON.stringify(demoSt)))}
var demoAt=params.has('at')?Math.max(0,Math.min(DEMO.length-1,Number.parseInt(params.get('at'),10)||0)):null;
if(demo){$('#sourceBadge').textContent='演示 · 模拟数据';$('#sourceBadge').classList.add('demo-badge')}
tick(false);setInterval(function(){tick(false)},3000);
})();
</script></body></html>
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
