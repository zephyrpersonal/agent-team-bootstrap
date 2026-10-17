#!/usr/bin/env node
// Human-run, read-only dashboard for agent-team-bootstrap. It passively reads Claude Code / Codex
// session transcripts; agents never start, read or depend on it (it is not a transport or inbox).
// Usage: node team-dashboard.mjs --project <id> [--port 4317] [--since 24h]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

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
  REVIEW_VERDICT: 'REVIEWED', COMPLETE: 'COMPLETE',
};
const RECEIVER_STATE = {
  JOIN_ACK: 'JOINING', ASSIGN: 'ASSIGNED', REVIEW_REQUEST: 'IN_REVIEW', REVIEW_FEEDBACK: 'IN_REVIEW', REVIEW_RESULT: 'IN_REVIEW',
};

function roleOf({ sentT, recvT }) {
  if (['JOIN_ACK', 'ASSIGN'].some((t) => sentT.has(t)) ||
      ['JOIN_REQUEST', 'COMPLETE', 'REVIEW_VERDICT', 'BLOCKED', 'REVIEWER_NEEDED'].some((t) => recvT.has(t))) return 'Leader';
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

export function createTracker({ project, claudeDir, codexDir, sinceMs = 24 * 3600e3, now = Date.now }) {
  const files = new Map();
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
      return aggregate([...files.values()], project, t);
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
    } else if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
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
    console.error('Usage: node team-dashboard.mjs --project <id> [--port 4317] [--since 24h] [--claude-dir DIR] [--codex-dir DIR]');
    process.exit(2);
  }
  const tracker = createTracker({
    project: a.project,
    sinceMs: parseSince(a.since),
    claudeDir: a['claude-dir'] || path.join(os.homedir(), '.claude', 'projects'),
    codexDir: a['codex-dir'] || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
  });
  const server = createServer(tracker);
  server.on('error', (e) => { console.error(`dashboard: ${e.message}`); process.exit(1); });
  server.listen(Number(a.port), '127.0.0.1', () => {
    console.log(`Agent Team Office for project "${a.project}": http://127.0.0.1:${server.address().port}/  (add ?demo=1 for a scripted demo)`);
  });
}

const HTML = String.raw`
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Team Office</title>
<style>
:root{--bg:#fff3dc;--panel:#fffdf7;--text:#2b2540;--muted:#6b6483;--line:#2b2540;--void:#fbe3c0;--wall:#ffe6bd;--wallL:#ffe3b3;--wallR:#ffd699;--floor:#f0c383;--tileA:#f4cd94;--tileB:#ecbd7a;--floorline:#d9a55f;--desktop:#e0a566;--desk:#b8793f;--desk2:#9c612c;--claude:#ff9f5a;--claude2:#ffd9b8;--codex:#4fcf85;--codex2:#cdf4dc;--accent:#845ef7;--card-b:#2b2540}
@media (prefers-color-scheme:dark){:root{--bg:#171424;--panel:#221d36;--text:#f3efff;--muted:#a79fc4;--line:#120f1d;--void:#1d1830;--wall:#2d2748;--wallL:#2f2a4d;--wallR:#262042;--floor:#3b3360;--tileA:#413866;--tileB:#383060;--floorline:#2f2850;--desktop:#8a6aa8;--desk:#6b4a8c;--desk2:#573a77;--card-b:#5a4f8a}}
*{box-sizing:border-box}
body{margin:0;padding:0 16px 40px;background:var(--bg);color:var(--text);font:15px/1.45 ui-rounded,"Nunito","Segoe UI",system-ui,sans-serif}
.top{max-width:1000px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;padding-top:16px}
h1{margin:0;font-size:26px}h2{margin:24px 0 8px;font-size:18px}
#meta{color:var(--muted);font-size:13px}
.hint{max-width:1000px;margin:4px auto 12px;color:var(--muted);font-size:12.5px}
main{max-width:1000px;margin:0 auto}
.stagewrap{position:relative}
#stage{width:100%;height:auto;display:block;border:4px solid var(--card-b);border-radius:28px;background:var(--void);user-select:none}
#empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px;font-weight:700;color:var(--muted);pointer-events:none}
/* backdrop: isometric office */
.wallr{fill:var(--wall)}.floorr{fill:var(--floor)}.baseb{fill:var(--floorline)}.flat{display:none}.compact .flat{display:block}.compact .iso{display:none}
.tile0{fill:var(--tileA)}.tile1{fill:var(--tileB)}.tile{stroke:var(--floorline);stroke-width:1.5}
.wallL{fill:var(--wallL)}.wallR{fill:var(--wallR)}.edge{fill:none;stroke:var(--line);stroke-width:3;stroke-linejoin:round}
.frame{fill:#fff;stroke:var(--line);stroke-width:3}.sky{fill:url(#skyDay)}.night .sky{fill:url(#skyNight)}
.sun,.moon{display:none}.day .sun{display:block}.night .moon,.night .stars{display:block}.stars{display:none}
.stars circle{fill:#fff;animation:twinkle 2.4s ease-in-out infinite}
@keyframes twinkle{0%,100%{opacity:.3}50%{opacity:1}}
.wcloud{fill:#fff;opacity:.85;animation:drift 26s linear infinite}.wcloud.c2{animation-duration:40s;animation-delay:-14s}
@keyframes drift{from{transform:translateX(-70px)}to{transform:translateX(200px)}}
.clockf{fill:#fff;stroke:var(--line);stroke-width:3}.hand{stroke:var(--line);stroke-width:3;stroke-linecap:round}
.boardf{fill:#fff;stroke:var(--line);stroke-width:3}.boardt{font-size:13px;font-weight:800;fill:#2b2540;text-anchor:start}
.pot{fill:#d9480f;stroke:var(--line);stroke-width:3}.leaf{fill:#40c057;stroke:var(--line);stroke-width:3;stroke-linejoin:round}
.sway{animation:sway 5s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
@keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
.mote{fill:#fff;opacity:0;animation:mote 9s ease-in-out infinite}
@keyframes mote{0%{opacity:0;transform:translate(0,0)}30%{opacity:.7}100%{opacity:0;transform:translate(24px,-70px)}}
/* characters */
.chr{cursor:pointer;outline:none;transition:transform 1.2s cubic-bezier(.3,1.35,.5,1),opacity .6s}
.lab{transition:transform 1.2s cubic-bezier(.3,1.35,.5,1);pointer-events:none}.lab.focus .npr{stroke:var(--accent);stroke-width:4}
.chr text,.lab text{fill:var(--text);text-anchor:middle;font-family:inherit}
.lab .name{font-size:14px;font-weight:800}.lab .st{font-size:11px;font-weight:700}
.npr{fill:var(--panel);stroke:var(--line);stroke-width:2.5}
.fx,.seat,.inner,.body,.gear,.mag,.zzz text,.conf rect,.arm,.foot,.eo,.sparks circle,.say,.talkmouth,.steam path,.tint{transform-box:fill-box}
.fx{transform-origin:50% 100%}
.ol{stroke:var(--line);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}
.claude .fill{fill:var(--claude)}.claude .belly{fill:var(--claude2)}.codex .fill{fill:var(--codex)}.codex .belly{fill:var(--codex2)}
.shadow{fill:#000;opacity:.16}.white{fill:#fff}.pupil{fill:var(--line);transition:transform .18s}.cheek{fill:#ff7a8a;opacity:.45}
.mouth{fill:none}.talkmouth{fill:#7a2f3c}
.frown,.ec,.gear,.zzz,.bang,.conf,.mag,.bubble,.say,.talkmouth,.sparks{display:none}
.eo{animation:blink 5s infinite;transform-origin:center}
@keyframes blink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.1)}}
.m-running .gear,.m-idle .zzz,.m-stale .zzz,.m-blocked .bang,.m-complete .conf,.m-review .mag,.r-reviewer .mag{display:block}
.m-idle:not(.stretch) .eo,.m-stale .eo{display:none}.m-idle:not(.stretch) .ec,.m-stale .ec{display:block}
.m-blocked .smile{display:none}.m-blocked .frown{display:block}
.talk .smile,.talk .frown{display:none}.talk .talkmouth{display:block;animation:yap .24s infinite alternate;transform-origin:center}
@keyframes yap{from{transform:scaleY(.35)}to{transform:scaleY(1)}}
.has-tool .bubble{display:block}.saying .say{display:block;animation:pop2 .3s cubic-bezier(.3,1.6,.5,1);transform-origin:50% 100%}
@keyframes pop2{from{transform:scale(.2);opacity:0}to{transform:scale(1);opacity:1}}
.seated .seat{transform:translateY(16px)}.ready .seat{transition:transform .35s cubic-bezier(.4,1.6,.5,1)}
/* motion by state */
.m-running .body{animation:type .5s ease-in-out infinite}
@keyframes type{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.m-running.seated .arm.l{animation:tapl .22s ease-in-out infinite alternate}.m-running.seated .arm.r{animation:tapr .22s ease-in-out .11s infinite alternate}
@keyframes tapl{from{transform:rotate(-8deg)}to{transform:rotate(10deg)}}@keyframes tapr{from{transform:rotate(8deg)}to{transform:rotate(-10deg)}}
.arm{transform-origin:50% 8%}.foot{transform-origin:50% 50%}
.m-idle .body{animation:breathe 3.2s ease-in-out infinite;transform-origin:50% 100%}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04,.97)}}
.m-blocked .inner{animation:shake .35s ease-in-out infinite;transform-origin:50% 100%}
@keyframes shake{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}
.m-blocked .arm.l{transform:rotate(120deg)}.m-blocked .arm.r{transform:rotate(-120deg)}
.m-stale{opacity:.5;filter:grayscale(.9)}.m-stale .inner{animation:ghost 4s ease-in-out infinite}
@keyframes ghost{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.m-complete .arm.l{animation:armsl .5s ease-in-out infinite alternate}.m-complete .arm.r{animation:armsr .5s ease-in-out infinite alternate}
@keyframes armsl{from{transform:rotate(110deg)}to{transform:rotate(150deg)}}@keyframes armsr{from{transform:rotate(-110deg)}to{transform:rotate(-150deg)}}
.m-complete .body{animation:cheerbob .5s ease-in-out infinite}
@keyframes cheerbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
.gear{animation:spin 1.2s linear infinite;transform-origin:center}@keyframes spin{to{transform:rotate(360deg)}}
.zzz text{font-size:15px;font-weight:800;fill:var(--muted);opacity:0;animation:zz 3s ease-out infinite}
.zzz text:nth-child(2){animation-delay:1s}.zzz text:nth-child(3){animation-delay:2s}
@keyframes zz{0%{opacity:0;transform:translate(0,8px)}30%{opacity:1}100%{opacity:0;transform:translate(14px,-22px)}}
.bang circle{fill:#fa5252}.bang text{fill:#fff;font-size:18px;font-weight:900}
.m-review .mag,.r-reviewer.m-review .mag{animation:sweep 1.1s ease-in-out infinite;transform-origin:0% 100%}
@keyframes sweep{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(22deg)}}
.conf rect{opacity:0;animation:fall 1.8s ease-in infinite}
@keyframes fall{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--dx),70px) rotate(360deg)}}
.joining .arm.r{animation:wave .5s ease-in-out infinite alternate}
.chr:hover .arm.r{animation:wave .45s ease-in-out infinite alternate}
@keyframes wave{from{transform:rotate(-100deg)}to{transform:rotate(-145deg)}}
.walking .body{animation:waddle .45s ease-in-out infinite;transform-origin:50% 100%}
@keyframes waddle{0%,100%{transform:rotate(-6deg) translateY(0)}50%{transform:rotate(6deg) translateY(-5px)}}
.walking .foot.l{animation:stepl .45s ease-in-out infinite}.walking .foot.r{animation:stepl .45s ease-in-out -.225s infinite}
@keyframes stepl{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.walking .arm.l{animation:swingl .45s ease-in-out infinite alternate}.walking .arm.r{animation:swingr .45s ease-in-out infinite alternate}
@keyframes swingl{from{transform:rotate(-25deg)}to{transform:rotate(25deg)}}@keyframes swingr{from{transform:rotate(25deg)}to{transform:rotate(-25deg)}}
.stretch .fx{animation:stretch 1.4s ease-in-out}
@keyframes stretch{0%,100%{transform:scale(1)}40%,60%{transform:scale(.94,1.1)}}
.stretch .arm.l{animation:upl 1.4s ease-in-out}.stretch .arm.r{animation:upr 1.4s ease-in-out}
@keyframes upl{0%,100%{transform:rotate(0)}40%,60%{transform:rotate(150deg)}}@keyframes upr{0%,100%{transform:rotate(0)}40%,60%{transform:rotate(-150deg)}}
.react-pop .fx{animation:pop .7s ease-out}.react-cheer .fx{animation:cheer 1s ease-out}.react-shake .fx{animation:shakeh .5s ease-in-out}
@keyframes pop{0%{transform:scale(1)}20%{transform:scale(1.15,.85)}45%{transform:translateY(-26px) scale(.92,1.1)}70%{transform:scale(1.1,.9)}100%{transform:scale(1)}}
@keyframes cheer{0%{transform:scale(1)}15%{transform:scale(1.15,.85)}35%{transform:translateY(-30px) scale(.92,1.1)}55%{transform:scale(1.1,.9)}70%{transform:translateY(-18px)}100%{transform:scale(1)}}
@keyframes shakeh{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}
.react-cheer .arm.l{animation:armsl .25s ease-in-out 4 alternate}.react-cheer .arm.r{animation:armsr .25s ease-in-out 4 alternate}
.react-cheer .sparks{display:block}.sparks circle{fill:#ffd43b;stroke:var(--line);stroke-width:1.5;animation:spark .9s ease-out forwards}
@keyframes spark{0%{opacity:1;transform:translate(0,0) scale(.6)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(1.1)}}
.ring{fill:none;stroke:var(--accent);stroke-width:4;opacity:0;transform-box:fill-box;transform-origin:center}
.got .ring{animation:ring .7s ease-out}
@keyframes ring{0%{opacity:.9;transform:scale(.7)}100%{opacity:0;transform:scale(1.35)}}
.bubble rect,.say rect{fill:var(--panel);stroke:var(--line);stroke-width:2.5}.say path{fill:var(--panel);stroke:var(--line);stroke-width:2.5}
.bubble text{font-size:11px;font-weight:700;text-anchor:start}.say text{font-size:12px;font-weight:800}
.halo{display:none;fill:none;stroke:var(--accent);stroke-width:3.5;stroke-dasharray:8 7;animation:dash 1.1s linear infinite}.selected .halo{display:block}
.lab.selected .npr{stroke:var(--accent);stroke-width:4}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 4px 0;font-size:12px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:5px}.legend i{width:18px;height:0;border-top:3px dashed;display:inline-block}
/* details panel */
.panel{position:fixed;top:0;right:0;height:100%;width:min(380px,92vw);background:var(--panel);color:var(--text);border-left:4px solid var(--card-b);box-shadow:-14px 0 36px rgba(0,0,0,.2);transform:translateX(105%);visibility:hidden;transition:transform .35s cubic-bezier(.3,1.2,.5,1),visibility 0s linear .35s;overflow-y:auto;padding:18px 18px 32px;z-index:10}
.panel.open{transform:none;visibility:visible;transition:transform .35s cubic-bezier(.3,1.2,.5,1),visibility 0s}
.pclose{position:absolute;top:10px;right:10px;width:44px;height:44px;border-radius:50%;border:3px solid var(--card-b);background:var(--bg);color:var(--text);font-family:inherit;font-weight:800;font-size:24px;line-height:1;cursor:pointer}
.phead{display:flex;gap:12px;align-items:center;margin:0 48px 10px 0}.pav{width:96px;height:112px;flex:none;background:var(--bg);border:3px solid var(--card-b);border-radius:18px}
.phead h2{margin:0 0 6px;font-size:20px;overflow-wrap:anywhere}.phead .tags{display:flex;flex-wrap:wrap;gap:5px}
.panel h3{margin:16px 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.panel .now{background:var(--bg);border:2px solid var(--card-b);border-radius:12px;padding:8px 10px;font:12.5px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.panel .said{font-style:italic;overflow-wrap:anywhere}
.panel dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:0;font-size:12.5px}.panel dt{color:var(--muted)}.panel dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace}
.panel ul{list-style:none;margin:0;padding:0;font-size:12.5px}.panel li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px dashed var(--card-b)}.panel li:last-child{border-bottom:0}
.panel .dot{width:10px;height:10px;border-radius:50%;flex:none;border:2px solid var(--card-b)}.panel .t{color:var(--muted);margin-left:auto;white-space:nowrap}
.peers{display:flex;flex-wrap:wrap;gap:6px}.peers button{font:inherit;font-size:12px;font-weight:800;border:2px solid var(--card-b);background:var(--bg);color:var(--text);border-radius:99px;padding:4px 10px;min-height:36px;cursor:pointer}
.card{cursor:pointer}
@media (min-width:1100px){body{transition:padding-right .35s}body.panel-open{padding-right:396px}}
/* desks: front-facing furniture with a visible top face */
.dtop{fill:var(--desktop)}.dfront{fill:var(--desk)}.dside{fill:var(--desk2)}.dline{stroke:var(--line);stroke-width:2;opacity:.45}.knob{fill:#ffd43b;stroke:var(--line);stroke-width:1.5}
.dshadow{fill:#000;opacity:.14}
.desk{transition:transform 1.2s cubic-bezier(.3,1.35,.5,1),opacity .8s}.desk.front{pointer-events:none}
.desk.front .dparts{opacity:0}.ready .desk.front .dparts{transition:opacity .25s}.desk.front.seated .dparts{opacity:1}
.desk.back.seated .dparts{display:none}
.bezel{fill:#343a40}.scr{fill:#0b132b}.m-stale .scr{fill:#222}.saver,.xmark,.tick,.code{display:none}
.m-running .code{display:block}.m-idle .saver{display:block}.m-blocked .xmark{display:block}.m-complete .tick{display:block}
.code rect{fill:#6ee7b7}.code{animation:codeflow .8s steps(2) infinite}
@keyframes codeflow{to{transform:translateY(-14px)}}
.saver{fill:#4dabf7;animation:saver 4s linear infinite}
@keyframes saver{0%,100%{transform:translate(0,0)}25%{transform:translate(10px,6px)}50%{transform:translate(0,12px)}75%{transform:translate(-10px,5px)}}
.xmark{stroke:#ff6b6b;stroke-width:3;stroke-linecap:round;fill:none}.tick{stroke:#51cf66;stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;fill:none}
.kbd{fill:#343a40}.keys rect{fill:#868e96}.m-running.seated .keys rect{animation:key .25s ease-in-out infinite alternate}
.keys rect:nth-child(2){animation-delay:.08s!important}.keys rect:nth-child(3){animation-delay:.16s!important}.keys rect:nth-child(4){animation-delay:.04s!important}
@keyframes key{from{fill:#868e96}to{fill:#e9ecef}}
.mug{fill:#fff;stroke:var(--line);stroke-width:2}.steam{display:none}.steam path{fill:none;stroke:#fff;stroke-width:2;opacity:0;stroke-linecap:round;animation:steam 2.4s ease-out infinite}
.steam path:nth-child(2){animation-delay:1.1s}.m-idle .steam{display:block}
@keyframes steam{0%{opacity:0;transform:translateY(0)}30%{opacity:.8}100%{opacity:0;transform:translateY(-12px)}}
/* links: dashed arcs lifted off the floor, with a flat shadow on the ground */
.linkbg{fill:none;stroke:#fff;stroke-linecap:round;opacity:.55}
.link{fill:none;stroke-linecap:round;stroke-dasharray:9 8;animation:dash 1.1s linear infinite}
.link.rev{animation-direction:reverse}
@keyframes dash{to{stroke-dashoffset:-17}}
.linksh{fill:none;stroke:#000;stroke-linecap:round;stroke-dasharray:2 9;opacity:.2}
.node{stroke:#fff;stroke-width:2}
/* panels */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(270px,100%),1fr));gap:12px}
.card{background:var(--panel);border:3px solid var(--card-b);border-radius:18px;padding:12px 14px;min-width:0;transition:box-shadow .3s,transform .3s}
.card.hl{box-shadow:0 0 0 5px var(--accent);transform:translateY(-3px)}
.card header{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}.card b{font-size:16px;overflow-wrap:anywhere;min-width:0}
.tag,.pill{font-size:11px;font-weight:800;border-radius:99px;padding:1px 9px;border:2px solid var(--card-b)}
.tag.claude{background:var(--claude2);color:#2b2540}.tag.codex{background:var(--codex2);color:#2b2540}
.pill.RUNNING{background:#d3f9d8;color:#1b5e20}.pill.IDLE{background:#e7f5ff;color:#1c4e80}.pill.STALE{background:#e9ecef;color:#495057}.pill.BLOCKED{background:#ffe3e3;color:#a61e1e}
.pill.proto{background:#f3ecff;color:#4c2a9a}
.kv{display:flex;gap:8px;font-size:12.5px;margin-top:3px;min-width:0}.kv span{color:var(--muted);flex:none;width:34px}.kv code,.kv i{min-width:0;overflow-wrap:anywhere;font-style:normal}
.kv code{font:12px ui-monospace,Menlo,monospace}
#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
#chips button{font:inherit;font-size:12px;font-weight:800;border:2px solid var(--card-b);background:var(--panel);color:var(--text);border-radius:99px;padding:2px 10px;min-height:44px;cursor:pointer}
#chips button[aria-pressed=true]{background:var(--accent);color:#fff}
.tablewrap{overflow-x:auto;background:var(--panel);border:3px solid var(--card-b);border-radius:18px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--card-b);white-space:nowrap}th{color:var(--muted)}
.env rect{stroke:var(--line);stroke-width:2.5}.env text{fill:#fff;font-size:10px;font-weight:800;text-anchor:middle}
@media (prefers-reduced-motion:reduce){#stage *,.panel{animation:none!important;transition:none!important}.m-stale{opacity:.5}.zzz text:first-child,.conf rect{opacity:1}.zzz text:not(:first-child){display:none}.env{display:none}}
</style></head><body>
<div class="top"><h1>🏢 Agent Team Office</h1><div id="meta"></div></div>
<p class="hint">Read-only view inferred from session transcripts · 只读观察，基于 transcript 推断；会话关闭与空闲无法区分（30 分钟无活动记为 STALE）。点击角色可定位到它的卡片；虚线弧线表示两个会话之间的消息往来。</p>
<main>
<section class="stagewrap">
<svg id="stage" class="day" viewBox="0 0 900 668" role="group" aria-label="Team office">
<defs>
<linearGradient id="skyDay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd3ff"/><stop offset="1" stop-color="#e3f6ff"/></linearGradient>
<linearGradient id="skyNight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#171a4a"/><stop offset="1" stop-color="#3d4380"/></linearGradient>
<clipPath id="winclip"><rect x="48" y="40" width="130" height="90" rx="5"/></clipPath>
<clipPath id="scrclip"><rect x="29" y="-3" width="30" height="22"/></clipPath>
</defs>
<g class="flat"><rect id="flatwall" class="wallr" width="900" height="668"/><rect id="flatfloor" class="floorr" x="0" y="60" width="900" height="608"/><rect id="flatbase" class="baseb" x="0" y="54" width="900" height="8"/></g>
<g class="iso">
<polygon class="wallL" points="75,377.5 450,190 450,30 75,217.5"/>
<polygon class="wallR" points="450,190 825,377.5 825,217.5 450,30"/>
<g id="isofloor"></g>
<polyline class="edge" points="75,217.5 450,30 825,217.5"/><line class="edge" x1="450" y1="30" x2="450" y2="190"/><line class="edge" x1="75" y1="217.5" x2="75" y2="377.5"/><line class="edge" x1="825" y1="217.5" x2="825" y2="377.5"/>
<g transform="matrix(1,-0.5,0,1,75,377.5)"><g transform="translate(20,-180)">
<rect class="frame" x="40" y="32" width="146" height="106" rx="8"/>
<g clip-path="url(#winclip)"><rect class="sky" x="48" y="40" width="130" height="90"/>
<g class="stars"><circle cx="70" cy="58" r="1.8"/><circle cx="110" cy="52" r="1.4" style="animation-delay:-.8s"/><circle cx="150" cy="70" r="1.8" style="animation-delay:-1.5s"/><circle cx="92" cy="94" r="1.4" style="animation-delay:-.4s"/><circle cx="162" cy="106" r="1.6" style="animation-delay:-1.9s"/></g>
<circle id="sun" class="sun" r="13" fill="#ffd43b"/><circle id="moon" class="moon" r="11" fill="#fff3bf"/>
<g class="wcloud"><ellipse cx="0" cy="62" rx="22" ry="7"/><ellipse cx="12" cy="56" rx="13" ry="7"/></g>
<g class="wcloud c2"><ellipse cx="0" cy="100" rx="18" ry="6"/><ellipse cx="-9" cy="95" rx="10" ry="6"/></g></g>
<line x1="113" y1="40" x2="113" y2="130" stroke="#2b2540" stroke-width="3"/><line x1="48" y1="85" x2="178" y2="85" stroke="#2b2540" stroke-width="3"/>
</g></g>
<g transform="matrix(1,0.5,0,1,450,190)">
<g transform="translate(-605,-172)"><circle class="clockf" cx="700" cy="62" r="25"/><line id="hh" class="hand" x1="700" y1="62" x2="700" y2="48"/><line id="mh" class="hand" x1="700" y1="62" x2="700" y2="43" style="stroke-width:2"/><circle cx="700" cy="62" r="2.5" fill="#2b2540"/></g>
<g transform="translate(-568,-176)"><rect class="boardf" x="738" y="34" width="132" height="86" rx="8"/><text id="b1" class="boardt" x="750" y="62">TEAM</text><text id="b2" class="boardt" x="750" y="84">MSGS</text><text id="b3" class="boardt" x="750" y="106">BUSY</text></g>
</g>
<g transform="translate(786,372)"><rect class="pot" x="-17" y="-26" width="34" height="26" rx="4"/><g class="sway"><path class="leaf" d="M0 -26 Q-30 -50 -18 -82 Q2 -62 0 -26Z"/><path class="leaf" d="M0 -26 Q30 -56 20 -90 Q-4 -66 0 -26Z"/><path class="leaf" d="M0 -26 Q-4 -62 6 -100 Q16 -62 0 -26Z"/></g></g>
<g transform="translate(116,372) scale(.85)"><rect class="pot" x="-17" y="-26" width="34" height="26" rx="4"/><g class="sway" style="animation-delay:-2s"><path class="leaf" d="M0 -26 Q-30 -50 -18 -82 Q2 -62 0 -26Z"/><path class="leaf" d="M0 -26 Q30 -56 20 -90 Q-4 -66 0 -26Z"/></g></g>
</g>
<g id="motes"></g>
<g id="scene"></g><g id="links"></g><g id="labels"></g><g id="envs"></g>
</svg>
<div id="empty"></div>
<div class="legend" aria-label="Arc colours show the latest message type"><span><i style="color:#339af0"></i>join / ack</span><span><i style="color:#7950f2"></i>assign</span><span><i style="color:#12b886"></i>peer</span><span><i style="color:#e64980"></i>review</span><span><i style="color:#40c057"></i>complete</span><span><i style="color:#f03e3e"></i>blocked</span><span><i style="color:#868e96"></i>other</span></div>
</section>
<h2>Team</h2><div id="cards" class="cards"></div>
<h2>Messages</h2><div id="chips"></div>
<div class="tablewrap"><table><thead><tr><th>Time</th><th>From → To</th><th>Type</th><th>ID</th><th>RE</th><th>Status / Ref</th></tr></thead><tbody id="msgs"></tbody></table></div>
</main>
<aside id="panel" class="panel" role="dialog" aria-labelledby="pTitle" aria-hidden="true"><button type="button" id="pClose" class="pclose" aria-label="Close details">×</button><div id="pBody"></div></aside>
<script>
(function(){
'use strict';
var NS='http://www.w3.org/2000/svg';
var demo=/[?&]demo=1/.test(location.search);
var motion=matchMedia('(prefers-reduced-motion: reduce)');
var $=function(s){return document.querySelector(s)};
var stage=$('#stage'),scene=$('#scene'),linksG=$('#links'),labelsG=$('#labels'),envsG=$('#envs');
motion.addEventListener('change',function(e){if(e.matches)envsG.textContent=''});
function el(tag,attrs,parent){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function hms(t){return new Date(t).toTimeString().slice(0,8)}
function ago(ms){var s=Math.max(0,Math.round(ms/1000));return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'}
function clip(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}
function hash(str){var h=0;for(var i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))>>>0;return h}
function rnd(a,b){return a+Math.random()*(b-a)}

var ICON={running:'⚙',idle:'💤',stale:'👻',blocked:'⛔',review:'🔍',complete:'🎉'};
var HATS=['#ffd23f','#ff922b','#4dabf7','#f06595'];
function modeOf(s){
  if(s.exec==='STALE')return 'stale';
  if(s.proto==='BLOCKED')return 'blocked';
  if(s.proto==='COMPLETE'&&s.exec!=='RUNNING')return 'complete';
  if(s.proto==='IN_REVIEW')return 'review';
  return s.exec==='RUNNING'?'running':'idle';
}

var S=.78,selId=null; // character scale; labels stay full size
var chars={},seen={},pairs={},linkEls={},firstLoad=true,rendered=false,filterType=null,lastState={project:'',sessions:[],messages:[]};

// ---- isometric floor: 3x3 grid of 250x125 diamonds, back corner at (450,190) ----
(function(){
  var fl=$('#isofloor');
  function c(x,y){return (450+(x-y)*125)+','+(190+(x+y)*62.5)}
  for(var gx=0;gx<3;gx++)for(var gy=0;gy<3;gy++)el('polygon',{points:[c(gx,gy),c(gx+1,gy),c(gx+1,gy+1),c(gx,gy+1)].join(' '),'class':'tile tile'+((gx+gy)%2)},fl);
  el('polygon',{points:[c(0,0),c(3,0),c(3,3),c(0,3)].join(' '),'class':'edge'},fl);
})();
// ---- ambient: day/night window, clock, motes ----
(function(){for(var i=0;i<9;i++)el('circle',{cx:rnd(60,840),cy:rnd(190,400),r:rnd(1.5,3),'class':'mote',style:'animation-delay:'+(-rnd(0,9))+'s;animation-duration:'+rnd(7,12)+'s'},$('#motes'))})();
function ambient(st,live){
  var d=new Date(),h=d.getHours()+d.getMinutes()/60,night=h<6||h>=19;
  stage.setAttribute('class',(night?'night':'day')+(stage._compact?' compact':'')+(stage._ready?' ready':''));
  if(rendered&&!stage._readyT)stage._readyT=setTimeout(function(){stage._ready=1;stage.classList.add('ready')},700);
  var t=Math.min(1,Math.max(0,(night?(h>=19?h-19:h+5)/11:(h-6)/13)));
  var x=48+130*t,y=118-Math.sin(t*Math.PI)*70;
  $('#sun').setAttribute('cx',x);$('#sun').setAttribute('cy',y);$('#moon').setAttribute('cx',x);$('#moon').setAttribute('cy',y);
  $('#hh').setAttribute('transform','rotate('+((d.getHours()%12+d.getMinutes()/60)*30)+' 700 62)');
  $('#mh').setAttribute('transform','rotate('+(d.getMinutes()*6)+' 700 62)');
  var busy=st.sessions.filter(function(s){return s.exec==='RUNNING'}).length;
  $('#b1').textContent='TEAM  '+st.sessions.length;$('#b2').textContent='MSGS  '+st.messages.length;$('#b3').textContent='BUSY  '+busy;
}

// ---- character construction ----
function buildHat(g,role,h){
  g.textContent='';
  if(role==='Leader'){el('path',{d:'M-18 -40 L-22 -64 L-9 -52 L0 -68 L9 -52 L22 -64 L18 -40 Z',fill:'#ffd43b','class':'ol'},g)}
  else if(role==='Worker'){
    var c=HATS[h%HATS.length];
    el('path',{d:'M-26 -34 Q-26 -62 0 -62 Q26 -62 26 -34 Z',fill:c,'class':'ol'},g);
    el('rect',{x:-32,y:-37,width:64,height:8,rx:4,fill:c,'class':'ol'},g);
    el('rect',{x:-4,y:-62,width:8,height:24,fill:'#fff',opacity:.55},g);
  }else{
    el('circle',{cx:-15,cy:-8,r:13,fill:'none',stroke:'#2b2540','stroke-width':3},g);
    el('circle',{cx:15,cy:-8,r:13,fill:'none',stroke:'#2b2540','stroke-width':3},g);
    el('line',{x1:-2,y1:-8,x2:2,y2:-8,stroke:'#2b2540','stroke-width':3},g);
  }
}

function deskParts(parent,withMug){
  var d=el('g',{'class':'dparts'},parent);
  el('polygon',{points:'-54,26 54,26 68,56 -68,56','class':'dtop ol'},d);
  el('rect',{x:-68,y:56,width:136,height:36,rx:7,'class':'dfront ol'},d);
  el('line',{x1:-68,y1:73,x2:68,y2:73,'class':'dline'},d);
  [[-32,64],[32,64],[-32,83],[32,83]].forEach(function(k){el('circle',{cx:k[0],cy:k[1],r:3,'class':'knob'},d)});
  var kb=el('g',{},d);el('rect',{x:-22,y:34,width:44,height:8,rx:3,'class':'kbd'},kb);
  var keys=el('g',{'class':'keys'},kb);for(var k=0;k<5;k++)el('rect',{x:-18+k*8,y:35.5,width:6,height:3,rx:1},keys);
  var mug=el('g',{transform:'translate(-42,42)'},d);
  el('rect',{x:-6,y:-10,width:12,height:10,rx:3,'class':'mug'},mug);el('path',{d:'M6 -8 Q11 -7 6 -3',fill:'none','class':'ol',style:'stroke-width:2'},mug);
  var steam=el('g',{'class':'steam'},mug);el('path',{d:'M-2 -12 Q-5 -17 -2 -21'},steam);el('path',{d:'M2 -12 Q5 -17 2 -21'},steam);
}
function makeDesk(){
  var back=el('g',{'class':'desk back',style:'opacity:0'},scene),front=el('g',{'class':'desk front',style:'opacity:0'},scene);
  el('ellipse',{cx:0,cy:96,rx:92,ry:16,'class':'dshadow'},back);
  deskParts(back);deskParts(front);
  // monitor sits behind the far edge of the desk
  var mon=el('g',{},back);
  el('rect',{x:41,y:20,width:8,height:8,fill:'#495057'},mon);
  el('rect',{x:24,y:-8,width:38,height:30,rx:5,'class':'bezel ol'},mon);el('rect',{x:27,y:-5,width:32,height:24,rx:2,'class':'scr'},mon);
  var cg=el('g',{'class':'code'},el('g',{'clip-path':'url(#scrclip)'},mon));
  for(var i=0;i<8;i++)el('rect',{x:30,y:-3+7*i,width:i%2?12:22,height:4,rx:2},cg);
  el('circle',{cx:43,cy:8,r:3,'class':'saver'},mon);
  el('path',{d:'M36 2 L50 14 M50 2 L36 14','class':'xmark'},mon);el('path',{d:'M35 9 L41 15 L52 3','class':'tick'},mon);
  return {back:back,front:front};
}

function makeChar(s){
  var h=hash(s.id);
  var desk=makeDesk(),g=el('g',{role:'button',tabindex:0,'data-id':s.id},scene);
  g._desk=desk;g._lab=el('g',{'class':'lab'},labelsG);
  el('ellipse',{cx:0,cy:54,rx:34,ry:8,'class':'shadow'},g);
  var fx=el('g',{'class':'fx'},g),seat=el('g',{'class':'seat'},fx),inner=el('g',{'class':'inner'},seat);
  var tint=el('g',{'class':'tint',style:'filter:hue-rotate('+((h%50)-25)+'deg)'},inner),body=el('g',{'class':'body'},tint);
  el('ellipse',{cx:-12,cy:50,rx:13,ry:7,'class':'fill ol foot l'},body);el('ellipse',{cx:12,cy:50,rx:13,ry:7,'class':'fill ol foot r'},body);
  el('ellipse',{cx:-40,cy:10,rx:9,ry:15,'class':'fill ol arm l'},body);el('ellipse',{cx:40,cy:10,rx:9,ry:15,'class':'fill ol arm r'},body);
  el('ellipse',{cx:0,cy:4,rx:40,ry:46,'class':'fill ol'},body);
  el('ellipse',{cx:0,cy:22,rx:23,ry:22,'class':'belly'},body);
  var eo=el('g',{'class':'eo',style:'animation-delay:'+(-(h%50)/10)+'s'},body);g._pup=[];
  [-15,15].forEach(function(x){el('circle',{cx:x,cy:-8,r:10,'class':'white ol',style:'stroke-width:2.5'},eo);g._pup.push(el('circle',{cx:x+1,cy:-7,r:5,'class':'pupil'},eo))});
  var ec=el('g',{'class':'ec'},body);
  el('path',{d:'M-24 -8 Q-15 -1 -6 -8','class':'ol',fill:'none'},ec);el('path',{d:'M6 -8 Q15 -1 24 -8','class':'ol',fill:'none'},ec);
  el('circle',{cx:-28,cy:6,r:5,'class':'cheek'},body);el('circle',{cx:28,cy:6,r:5,'class':'cheek'},body);
  el('path',{d:'M-8 6 Q0 15 8 6','class':'ol mouth smile'},body);
  el('path',{d:'M-8 13 Q0 4 8 13','class':'ol mouth frown'},body);
  el('ellipse',{cx:0,cy:9,rx:6,ry:5,'class':'talkmouth ol',style:'stroke-width:2'},body);
  g._hat=el('g',{'class':'hat'},body);g._h=h;
  var mag=el('g',{'class':'mag'},el('g',{transform:'translate(46,22)'},body));
  el('line',{x1:0,y1:0,x2:10,y2:-18,'class':'ol'},mag);el('circle',{cx:13,cy:-26,r:11,fill:'#e7f5ff','fill-opacity':.7,'class':'ol'},mag);
  var gear=el('g',{'class':'gear'},el('g',{transform:'translate(-30,-72)'},inner));
  el('circle',{cx:0,cy:0,r:8,fill:'#adb5bd','class':'ol'},gear);
  for(var i=0;i<6;i++)el('rect',{x:-2.5,y:-13,width:5,height:6,fill:'#adb5bd','class':'ol',transform:'rotate('+(i*60)+')'},gear);
  var z=el('g',{'class':'zzz',transform:'translate(26,-60)'},inner);['z','Z','z'].forEach(function(t){var e=el('text',{x:0,y:0},z);e.textContent=t});
  var b=el('g',{'class':'bang',transform:'translate(0,-76)'},inner);el('circle',{cx:0,cy:0,r:12,'class':'ol'},b);var bt=el('text',{x:0,y:6},b);bt.textContent='!';
  var cf=el('g',{'class':'conf',transform:'translate(0,-60)'},inner);
  ['#fa5252','#ffd43b','#51cf66','#4dabf7','#f783ac','#845ef7','#ffa94d','#20c997'].forEach(function(c,i){el('rect',{x:(i-4)*8,y:0,width:6,height:9,fill:c,style:'--dx:'+((i-3.5)*12)+'px;animation-delay:'+(i*60)+'ms'},cf)});
  var sp=el('g',{'class':'sparks',transform:'translate(0,-20)'},fx);
  for(var j=0;j<7;j++){var a=j/7*Math.PI*2;el('circle',{cx:0,cy:0,r:5,style:'--dx:'+Math.round(Math.cos(a)*62)+'px;--dy:'+Math.round(Math.sin(a)*52)+'px'},sp)}
  g._bub=el('g',{'class':'bubble'},g._lab);g._bubR=el('rect',{x:0,y:-48,width:80,height:22,rx:9},g._bub);g._bubT=el('text',{x:8,y:-33},g._bub);
  var sayW=el('g',{transform:'translate(0,-82)'},g._lab);g._say=el('g',{'class':'say'},sayW);
  g._sayP=el('path',{d:'M-6 10 L0 18 L6 10'},g._say);g._sayR=el('rect',{x:-20,y:-12,width:40,height:24,rx:10},g._say);g._sayT=el('text',{x:0,y:4},g._say);
  g._ring=el('circle',{cx:0,cy:6,r:56,'class':'ring'},g);el('ellipse',{cx:0,cy:58,rx:56,ry:14,'class':'halo'},g);
  g._np=el('g',{'class':'np'},g._lab);g._npr=el('rect',{x:-40,y:80,width:80,height:36,rx:12,'class':'npr'},g._np);
  g._name=el('text',{x:0,y:95,'class':'name'},g._np);g._st=el('text',{x:0,y:110,'class':'st'},g._np);
  g._title=el('title',{},g);
  g._x={};g._off={x:0,y:0};g._home={x:0,y:0};g._busy=false;
  g.addEventListener('click',function(){poke(g,s.id)});
  g.addEventListener('focus',function(){flag(g,'focus',true)});g.addEventListener('blur',function(){flag(g,'focus',false)});
  g.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();poke(g,s.id)}});
  return g;
}

// ---- state flags -> classes (the same mode classes drive the desk, so monitor/mug follow the character) ----
function applyClass(g){
  var x=Object.keys(g._x).filter(function(k){return g._x[k]}).join(' ');
  var seated=g._seatable&&!g._busy;
  var cls=g._cls+(seated?' seated':'');
  g.setAttribute('class','chr '+g._client+' '+cls+' '+x);
  g._desk.back.setAttribute('class','desk back '+cls);g._desk.front.setAttribute('class','desk front '+cls);
  g._lab.setAttribute('class','lab '+cls+' '+x);
}
function flag(g,k,on){g._x[k]=on;applyClass(g)}
function flash(g,k,ms){flag(g,k,true);setTimeout(function(){flag(g,k,false)},ms)}
function place(g){var t='translate('+(g._home.x+g._off.x)+'px,'+(g._home.y+g._off.y)+'px)';g.style.transform=t+' scale('+S+')';g._lab.style.transform=t;queueLinks()}
function placeDesk(g){var t='translate('+g._home.x+'px,'+g._home.y+'px) scale('+S+')';g._desk.back.style.transform=t;g._desk.front.style.transform=t}
function wpos(id){var g=chars[id];return g?{x:g._home.x+g._off.x,y:g._home.y+g._off.y}:null}

function say(g,text,ms){
  clearTimeout(g._sayT);
  var w=Math.max(34,Math.min(22,text.length)*7+16);
  g._sayT0=text;g._sayT.textContent=clip(text,22);g._sayR.setAttribute('width',w);g._sayR.setAttribute('x',-w/2);
  flag(g,'saying',false);void g.getBoundingClientRect();flag(g,'saying',true);
  g._sayTm=setTimeout(function(){flag(g,'saying',false)},ms);
}
function talk(g,ms){flag(g,'talk',true);setTimeout(function(){flag(g,'talk',false)},ms)}
function look(g,dx,dy){g._pup.forEach(function(p,i){p.style.transform='translate('+dx+'px,'+dy+'px)'})}

function poke(g,id){flash(g,'react-pop',700);if(selId===id)closePanel();else openPanel(id)}

function walkTo(g,off,cb){
  var dx=off.x-g._off.x,dy=off.y-g._off.y,dur=Math.max(.4,Math.sqrt(dx*dx+dy*dy)/90);
  g._busy=true;g._off=off;flag(g,'walking',true);
  g.style.transition=g._lab.style.transition='transform '+dur+'s linear,opacity .6s';place(g);
  setTimeout(function(){g.style.transition=g._lab.style.transition='';flag(g,'walking',false);if(cb)cb()},dur*1000+30);
}
function wander(g){
  if(g._busy)return;g._busy=true;
  walkTo(g,{x:rnd(-80,80),y:rnd(-18,26)},function(){
    look(g,rnd(-3,3),rnd(-2,2));
    setTimeout(function(){look(g,0,0);walkTo(g,{x:0,y:0},function(){g._busy=false;applyClass(g)})},rnd(1500,3500));
  });
}
function visit(A,B){
  var now=Date.now();
  if(A._busy||A._cls.indexOf('m-stale')>=0||(A._lastVisit&&now-A._lastVisit<9000))return;
  A._lastVisit=now;A._busy=true;
  var side=A._home.x<B._home.x?-1:1;
  walkTo(A,{x:B._home.x+B._off.x+side*78-A._home.x,y:B._home.y+B._off.y+6-A._home.y},function(){
    talk(A,2200);talk(B,1800);
    setTimeout(function(){walkTo(A,{x:0,y:0},function(){A._busy=false;applyClass(A)})},2500);
  });
}
// ---- idle personality: look around, stretch, wander off ----
setInterval(function(){
  if(motion.matches)return;
  Object.keys(chars).forEach(function(id){
    var g=chars[id];
    if(g._busy||g._cls.indexOf('m-stale')>=0||Math.random()>.22)return;
    var r=Math.random(),idle=g._cls.indexOf('m-idle')>=0;
    if(r<.4||!idle){look(g,rnd(-3.5,3.5),rnd(-2,2));setTimeout(function(){look(g,0,0)},rnd(700,1500))}
    else if(r<.7)flash(g,'stretch',1400);
    else wander(g);
  });
},1500);
// eyes follow the cursor
var ptr=null,ptrQ=false;
document.addEventListener('pointermove',function(e){
  if(motion.matches||ptrQ)return;ptr=e;ptrQ=true;
  requestAnimationFrame(function(){ptrQ=false;
    Object.keys(chars).forEach(function(id){var g=chars[id];if(g._busy)return;var b=g.getBoundingClientRect(),dx=ptr.clientX-(b.left+b.width/2),dy=ptr.clientY-(b.top+b.height/2),d=Math.sqrt(dx*dx+dy*dy)||1,k=Math.min(3.5,d/40);look(g,dx/d*k,dy/d*k*.7)});
  });
});

// ---- layout: isometric office; slots are sticky so people keep their desk ----
function layout(list){
  var width=Math.min(900,stage.clientWidth||900),p={};
  var leader=list.filter(function(s){return s.role==='Leader'})[0];
  var others=list.filter(function(s){return s!==leader});
  var compact=width<700||list.length>9;
  stage._compact=compact;
  if(compact){
    var cols=Math.max(1,Math.floor(width/160)),rows=Math.max(1,Math.ceil(list.length/cols)),H=rows*210+40;
    stage.setAttribute('viewBox','0 0 '+width+' '+H);
    list.forEach(function(s,i){p[s.id]={x:width/cols*(i%cols+.5),y:120+Math.floor(i/cols)*210,grid:true}});
    setFlat(width,H);return p;
  }
  stage.setAttribute('viewBox','0 0 900 668');
  // staggered seats (no shared rows/columns, >=120px apart); index 0 is the Leader's desk in the back corner
  var seats=[[450,248],[688,324],[204,343],[425,485],[593,427],[328,288],[302,417],[479,368],[569,278]];
  var order=[1,2,3,4,5,6,7,8,0];
  var sl=stage._slots||(stage._slots={}),live={};
  list.forEach(function(s){live[s.id]=1});
  Object.keys(sl).forEach(function(id){if(!live[id]||(leader&&(id===leader.id||sl[id]==='0')))delete sl[id]});
  var taken={};Object.keys(sl).forEach(function(id){taken[sl[id]]=1});
  others.forEach(function(s){
    if(sl[s.id])return;
    for(var i=0;i<order.length;i++){var k=String(order[i]);if(!taken[k]){taken[k]=1;sl[s.id]=k;return}}
  });
  function at(k){return {x:seats[k][0],y:seats[k][1],iso:true}}
  if(leader)p[leader.id]=at(0);
  others.forEach(function(s){p[s.id]=at(+sl[s.id])});
  return p;
}
function setFlat(w,h){
  [['#flatwall',0,0,w,h],['#flatfloor',0,60,w,h-60],['#flatbase',0,54,w,8]].forEach(function(a){var e=$(a[0]);e.setAttribute('x',a[1]);e.setAttribute('y',a[2]);e.setAttribute('width',a[3]);e.setAttribute('height',a[4])});
}
function sortScene(){
  var items=[];
  Object.keys(chars).forEach(function(id){var g=chars[id];items.push([g._desk.back,g._z-1],[g,g._z],[g._desk.front,g._z+1])});
  items.sort(function(a,b){return a[1]-b[1]});
  items.forEach(function(it,i){var cur=scene.children[i];if(cur!==it[0])scene.insertBefore(it[0],cur||null)});
}

function renderStage(st){
  var list=st.sessions.slice().sort(function(a,b){return (b.role==='Leader')-(a.role==='Leader')||a.name.localeCompare(b.name)});
  var p=layout(list),alive={};
  list.forEach(function(s){
    alive[s.id]=1;
    var pp=p[s.id],g=chars[s.id],isNew=!g;
    if(isNew){
      g=chars[s.id]=makeChar(s);g._client=s.client;g._cls='';g._z=pp.y;sortScene();
      var dk=[g._desk.back,g._desk.front];
      dk.forEach(function(d){d.style.transition='none';if(!rendered)d.style.opacity=1});
      g._home={x:pp.x,y:pp.y};placeDesk(g); // desks appear in place; the character walks in from the edge on later joins
      g._home=rendered?{x:pp.x<450?-110:1010,y:pp.y}:{x:pp.x,y:pp.y};
      g.setAttribute('class','chr');place(g);void g.getBoundingClientRect();
      dk.forEach(function(d){d.style.transition=''});
    }
    g._z=pp.y;g._home={x:pp.x,y:pp.y};place(g);placeDesk(g);g._desk.back.style.opacity=1;g._desk.front.style.opacity=1;
    if(g._role!==s.role){g._role=s.role;buildHat(g._hat,s.role,g._h)}
    var mode=modeOf(s),side=pp.x>450&&!pp.grid?-1:1,tool=s.exec==='RUNNING'?s.tool:'';
    g._seatable=mode==='running'||mode==='idle'||mode==='review';
    g._x.selected=s.id===selId;
    g._cls='m-'+mode+' r-'+s.role.toLowerCase()+(s.proto==='JOINING'?' joining':'')+(tool?' has-tool':'');
    applyClass(g);
    var label=clip(tool,26),w=Math.max(40,label.length*6.4+16);
    g._bubT.textContent=label;g._bubR.setAttribute('width',w);
    g._bub.setAttribute('transform',pp.grid?'translate('+(-w/2)+',-36)':'translate('+(side>0?42:-42-w)+',0)');
    var nm=clip(s.name,24),stx=ICON[mode]+' '+(s.exec==='STALE'?'STALE':mode)+(s.proto&&s.proto!=='NONE'?' · '+s.proto:'');
    g._name.textContent=nm;g._st.textContent=stx;
    var pw=Math.max(nm.length*8.4,stx.length*6.1)+22;g._npr.setAttribute('width',pw);g._npr.setAttribute('x',-pw/2);
    var desc=s.name+', '+s.role+', '+s.exec.toLowerCase()+(tool?' '+tool:'');
    g.setAttribute('aria-label',desc);g._title.textContent=desc;
  });
  Object.keys(chars).forEach(function(id){
    if(!alive[id]){var g=chars[id];delete chars[id];g.style.opacity=0;g._lab.style.opacity=0;g._desk.back.style.opacity=0;g._desk.front.style.opacity=0;
      setTimeout(function(){g.remove();g._lab.remove();g._desk.back.remove();g._desk.front.remove()},900)}
  });
  rendered=list.length>0||rendered;
  $('#empty').style.display=list.length?'none':'flex';
  if(!list.length)$('#empty').textContent='No team activity for project "'+st.project+'" yet. Start a Leader and Workers and send a JOIN_REQUEST.';
  sortScene();
  pairs={};
  st.messages.forEach(function(m){
    if(!m.from||!m.to||!chars[m.from]||!chars[m.to])return;
    var a=m.from<m.to?m.from:m.to,b=a===m.from?m.to:m.from,k=a+'|'+b,o=pairs[k]||(pairs[k]={a:a,b:b,n:0,ts:0,rev:false});
    o.n++;if(m.ts>=o.ts){o.ts=m.ts;o.rev=m.from===b;o.type=m.type}
  });
  updateLinks();
}

// ---- links: dashed arcs lifted off the floor; heights and anchors differ per pair so they do not stack ----
var linkQ=false;
function queueLinks(){if(linkQ)return;linkQ=true;requestAnimationFrame(function(){linkQ=false;updateLinks()})}
function makeLink(){
  var e={sh:el('path',{'class':'linksh'},linksG),bg:el('path',{'class':'linkbg'},linksG),ln:el('path',{'class':'link'},linksG)};
  e.na=el('circle',{r:4.5,'class':'node'},linksG);e.nb=el('circle',{r:4.5,'class':'node'},linksG);return e;
}
function updateLinks(){
  var keys=Object.keys(pairs).sort(),partner={};
  keys.forEach(function(k){var q=pairs[k];(partner[q.a]=partner[q.a]||[]).push(k);(partner[q.b]=partner[q.b]||[]).push(k)});
  Object.keys(linkEls).forEach(function(k){if(!pairs[k]){var e=linkEls[k];[e.sh,e.bg,e.ln,e.na,e.nb].forEach(function(n){n.remove()});delete linkEls[k]}});
  keys.forEach(function(k,idx){
    var q=pairs[k],A=wpos(q.a),B=wpos(q.b);
    if(!A||!B)return;
    var oa=(partner[q.a].indexOf(k)-(partner[q.a].length-1)/2)*26,ob=(partner[q.b].indexOf(k)-(partner[q.b].length-1)/2)*26;
    var x0=A.x+oa,y0=A.y-50,x1=B.x+ob,y1=B.y-50,d=Math.sqrt((x1-x0)*(x1-x0)+(y1-y0)*(y1-y0)),h=26+d*.14+(idx%4)*14;
    var cx=(x0+x1)/2+(idx%2?1:-1)*Math.max(0,90-Math.abs(x1-x0)*.3),cy=(y0+y1)/2-2*h; // near-vertical pairs bow sideways so the arc does not fold onto itself
    q.geom={x0:x0,y0:y0,x1:x1,y1:y1,cx:cx,cy:cy};
    var e=linkEls[k]||(linkEls[k]=makeLink()),w=2.4+Math.min(q.n,6)*.5,age=(Date.now()-q.ts)/1000,op=Math.max(.45,1-age/240);
    var dd='M'+x0+' '+y0+' Q'+cx+' '+cy+' '+x1+' '+y1;
    e.ln.setAttribute('d',dd);e.bg.setAttribute('d',dd);
    e.ln.setAttribute('stroke-width',w);e.bg.setAttribute('stroke-width',w+3.5);e.ln.setAttribute('stroke-opacity',op);
    e.ln.setAttribute('class','link'+(q.rev?' rev':''));var col=typeColor(q.type||'');e.ln.style.stroke=col;e.na.style.fill=col;e.nb.style.fill=col;
    e.sh.setAttribute('d','M'+(A.x+oa)+' '+(A.y+48)+' Q'+(A.x+B.x+oa+ob)/2+' '+((A.y+B.y)/2+60)+' '+(B.x+ob)+' '+(B.y+48));
    e.sh.setAttribute('stroke-width',w+1);
    e.na.setAttribute('cx',x0);e.na.setAttribute('cy',y0);e.nb.setAttribute('cx',x1);e.nb.setAttribute('cy',y1);
  });
}

// ---- messages: flying envelopes + reactions ----
var TYPE_ABBR={JOIN_REQUEST:'JOIN',JOIN_ACK:'ACK',ACK_RECEIVED:'OK',ASSIGN:'TASK',ASSIGN_ACK:'ACK',PEER_REQUEST:'ASK',PEER_REPLY:'REPLY',REVIEW_REQUEST:'REVIEW',REVIEW_FEEDBACK:'NOTES',REVIEW_RESULT:'RESULT',REVIEW_VERDICT:'VERDICT',COMPLETE:'DONE',BLOCKED:'BLOCK',PROGRESS:'PROG'};
function typeColor(t){
  if(/^(JOIN|ACK|ASSIGN_ACK)/.test(t))return '#339af0';
  if(t==='ASSIGN')return '#7950f2';
  if(/^PEER/.test(t))return '#12b886';
  if(/^REVIEW/.test(t))return '#e64980';
  if(t==='COMPLETE')return '#40c057';
  if(t==='BLOCKED')return '#f03e3e';
  return '#868e96';
}
function react(g,m){
  var good=m.type==='COMPLETE'||m.type==='JOIN_ACK'||m.type==='ACK_RECEIVED'||((m.type==='REVIEW_VERDICT'||m.type==='REVIEW_RESULT')&&m.status==='approved');
  var kind=m.type==='BLOCKED'?'shake':good?'cheer':'pop';
  g._got=1;flash(g,'got',800);flash(g,'react-'+kind,kind==='cheer'?1100:700);
  say(g,kind==='cheer'?'Yay!':kind==='shake'?'Uh-oh!':'Got it!',1400);
}
function fly(m,delay){
  var A=chars[m.from],B=chars[m.to];
  if(!A||!B)return;
  var key=m.from<m.to?m.from+'|'+m.to:m.to+'|'+m.from,pr=pairs[key],ab=TYPE_ABBR[m.type]||m.type.slice(0,5);
  setTimeout(function(){say(A,ab+' →',1300);talk(A,1100)},delay);
  if(m.p2p&&!motion.matches)setTimeout(function(){visit(A,B)},delay+250);
  var done=function(){if(chars[m.to])react(B,m)};
  if(motion.matches||!pr){setTimeout(done,delay);return}
  var dur=m.p2p?1200:1900,t0=null,rev=m.from!==pr.a;
  var g=el('g',{'class':'env',opacity:0},envsG);
  var w=Math.max(40,ab.length*7+14);
  el('rect',{x:-w/2,y:-12,width:w,height:24,rx:6,fill:typeColor(m.type)},g);
  var tx=el('text',{x:0,y:4},g);tx.textContent=ab;
  function step(ts){
    if(motion.matches||!g.isConnected){g.remove();return}
    if(t0===null)t0=ts+delay+120;
    var t=(ts-t0)/dur;
    if(t<0){requestAnimationFrame(step);return}
    if(t>=1){g.remove();done();return}
    var P=pr.geom;
    if(!P){g.remove();return}
    var X0=rev?P.x1:P.x0,Y0=rev?P.y1:P.y0,X1=rev?P.x0:P.x1,Y1=rev?P.y0:P.y1;
    var e=t*t*(3-2*t),ue=1-e;
    g.setAttribute('transform','translate('+(ue*ue*X0+2*ue*e*P.cx+e*e*X1)+','+(ue*ue*Y0+2*ue*e*P.cy+e*e*Y1)+') rotate('+(Math.sin(t*12)*10)+') scale('+(.8+Math.sin(t*Math.PI)*.4)+')');
    g.setAttribute('opacity',Math.min(1,t*8,(1-t)*6));
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderMessages(st){
  var fresh=[];
  st.messages.forEach(function(m){var k=m.id||(m.ts+m.type+m.from);if(!seen[k]){seen[k]=1;if(!firstLoad)fresh.push(m)}});
  fresh.forEach(function(m,i){fly(m,i*450)});
  firstLoad=false;
  var types=[];st.messages.forEach(function(m){if(types.indexOf(m.type)<0)types.push(m.type)});
  if(filterType&&types.indexOf(filterType)<0)filterType=null;
  var chips=$('#chips');chips.textContent='';
  ['all'].concat(types).forEach(function(t){
    var b=document.createElement('button');b.type='button';b.textContent=t;
    b.setAttribute('aria-pressed',String((t==='all'&&!filterType)||t===filterType));
    b.onclick=function(){filterType=t==='all'?null:t;renderMessages(lastState)};
    chips.appendChild(b);
  });
  var rows=st.messages.filter(function(m){return !filterType||m.type===filterType}).slice(-100).reverse();
  $('#msgs').innerHTML=rows.map(function(m){
    return '<tr><td>'+hms(m.ts)+'</td><td>'+esc(m.fromLabel||'?')+' → '+esc(m.toLabel||'?')+(m.p2p?' <b title="peer-to-peer">⇄</b>':'')+'</td><td>'+esc(m.type)+'</td><td>'+esc(m.id)+'</td><td>'+esc(m.re)+'</td><td>'+esc([m.status,m.ref].filter(Boolean).join(' '))+'</td></tr>';
  }).join('')||'<tr><td colspan="6">No envelope messages yet.</td></tr>';
}

function renderCards(st){
  var list=st.sessions.slice().sort(function(a,b){return (b.role==='Leader')-(a.role==='Leader')||a.name.localeCompare(b.name)});
  $('#cards').innerHTML=list.map(function(s){
    return '<article class="card" tabindex="0" data-card="'+esc(s.id)+'"><header><b>'+esc(s.name)+'</b><span class="tag">'+esc(s.role)+'</span><span class="tag '+esc(s.client)+'">'+(s.client==='codex'?'Codex':'Claude')+'</span></header>'
      +'<div><span class="pill '+esc(s.exec)+'">'+esc(s.exec)+'</span> <span class="pill proto">'+esc(s.proto)+'</span></div>'
      +'<div class="kv"><span>cwd</span><code>'+esc(s.cwd||'?')+'</code></div>'
      +'<div class="kv"><span>tool</span><code>'+esc(s.exec==='RUNNING'&&s.tool?s.tool:'—')+'</code></div>'
      +'<div class="kv"><span>said</span><i>'+esc(s.lastText||'—')+'</i></div>'
      +'<div class="kv"><span>last</span><i>'+(s.lastTs?ago(Date.now()-s.lastTs):'?')+'</i></div>'
      +(s.recentTools.length?'<div class="kv"><span>recent</span><i>'+s.recentTools.slice().reverse().map(esc).join('<br>')+'</i></div>':'')
      +'</article>';
  }).join('');
}

// ---- details panel ----
var panel=$('#panel'),pBody=$('#pBody');
function openPanel(id){
  if(selId&&chars[selId])flag(chars[selId],'selected',false);
  selId=id;panel._cls=null;
  if(chars[id])flag(chars[id],'selected',true);
  renderPanel(lastState);
  panel.classList.add('open');panel.setAttribute('aria-hidden','false');document.body.classList.add('panel-open');
  setTimeout(function(){$('#pClose').focus()},50);
}
function closePanel(){
  if(!selId)return;
  var g=chars[selId];selId=null;
  panel.classList.remove('open');panel.setAttribute('aria-hidden','true');document.body.classList.remove('panel-open');
  if(g){flag(g,'selected',false);g.focus()}
}
$('#pClose').addEventListener('click',closePanel);
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePanel()});
$('#cards').addEventListener('click',function(e){var c=e.target.closest&&e.target.closest('[data-card]');if(c)openPanel(c.getAttribute('data-card'))});
$('#cards').addEventListener('keydown',function(e){var c=(e.key==='Enter'||e.key===' ')&&e.target.closest&&e.target.closest('[data-card]');if(c){e.preventDefault();openPanel(c.getAttribute('data-card'))}});
function renderPanel(st){
  if(!selId)return;
  var s=st.sessions.filter(function(x){return x.id===selId})[0],g=chars[selId];
  if(!s){pBody.innerHTML='<p>This session is no longer in view.</p>';panel._cls=null;return}
  var byId={};st.sessions.forEach(function(x){byId[x.id]=x});
  var mine=st.messages.filter(function(m){return m.from===selId||m.to===selId});
  var peers={};mine.forEach(function(m){var o=m.from===selId?m.to:m.from;if(o)peers[o]=(peers[o]||0)+1});
  var mode=modeOf(s);
  var html='<div class="phead"><svg class="pav" viewBox="-62 -96 124 160" aria-hidden="true"></svg><div><h2 id="pTitle">'+esc(s.name)+'</h2><div class="tags"><span class="tag">'+esc(s.role)+'</span><span class="tag '+esc(s.client)+'">'+(s.client==='codex'?'Codex':'Claude')+'</span></div></div></div>'
    +'<div><span class="pill '+esc(s.exec)+'">'+ICON[mode]+' '+esc(s.exec)+'</span> <span class="pill proto">'+esc(s.proto)+'</span></div>'
    +'<h3>Doing now</h3><div class="now">'+esc(s.exec==='RUNNING'&&s.tool?s.tool:s.exec==='RUNNING'?'thinking…':'—')+'</div>'
    +'<h3>Last said</h3><div class="said">'+esc(s.lastText||'—')+'</div>'
    +'<h3>Details</h3><dl><dt>session</dt><dd>'+esc(s.id)+'</dd><dt>cwd</dt><dd>'+esc(s.cwd||'?')+'</dd><dt>active</dt><dd>'+(s.lastTs?ago(Date.now()-s.lastTs):'?')+'</dd></dl>'
    +'<h3>Recent tools</h3>'+(s.recentTools.length?'<ul>'+s.recentTools.slice().reverse().map(function(t){return '<li>'+esc(t)+'</li>'}).join('')+'</ul>':'<p>—</p>')
    +'<h3>Talks with</h3>'+(Object.keys(peers).length?'<div class="peers">'+Object.keys(peers).map(function(o){return '<button type="button" data-peer="'+esc(o)+'">'+esc(byId[o]?byId[o].name:o)+' · '+peers[o]+'</button>'}).join('')+'</div>':'<p>—</p>')
    +'<h3>Recent messages</h3>'+(mine.length?'<ul>'+mine.slice(-12).reverse().map(function(m){var out=m.from===selId;return '<li><span class="dot" style="background:'+typeColor(m.type)+'"></span><b>'+esc(m.type)+'</b> '+(out?'→ '+esc(m.toLabel||'?'):'← '+esc(m.fromLabel||'?'))+'<span class="t">'+hms(m.ts)+'</span></li>'}).join('')+'</ul>':'<p>—</p>');
  pBody.innerHTML=html;
  // a live copy of the character, so the avatar keeps animating with its state
  var av=pBody.querySelector('.pav'),fx=g&&g.querySelector('.fx');
  if(av&&fx){var w=el('g',{'class':String(g.getAttribute('class')).replace(/\bchr\b/,'')},av);w.appendChild(fx.cloneNode(true))}
  Array.prototype.forEach.call(pBody.querySelectorAll('[data-peer]'),function(b){b.addEventListener('click',function(){openPanel(b.getAttribute('data-peer'))})});
}

function render(st){
  lastState=st;
  renderStage(st);renderMessages(st);renderCards(st);ambient(st);renderPanel(st);
  $('#meta').textContent='project '+st.project+' · '+st.sessions.length+' sessions · '+st.messages.length+' messages · updated '+hms(Date.now())+(demo?' · DEMO':'');
}

// ---- scripted demo (?demo=1): JOIN -> ASSIGN -> PEER -> REVIEW -> COMPLETE, then loops; &at=N freezes at step N ----
var demoStep=0,demoSt=null,demoN=0;
function dsess(id,client,role,name){return {id:id,short:id,client:client,cwd:'/work/'+(name||'leader'),workerId:name,name:name||'leader',role:role,proto:role==='Leader'?'COORDINATING':'NONE',exec:'IDLE',tool:'',lastText:'',recentTools:[],lastTs:Date.now()}}
function dmsg(type,from,to,extra){var f=demoSt.sessions.filter(function(s){return s.id===from})[0],t=demoSt.sessions.filter(function(s){return s.id===to})[0];
  var m={ts:Date.now(),type:type,id:'d'+(++demoN),re:null,status:null,ref:null,from:from,to:to,fromLabel:f&&f.name,toLabel:t&&t.name,p2p:!!(f&&t&&f.role!=='Leader'&&t.role!=='Leader')};
  for(var k in extra||{})m[k]=extra[k];demoSt.messages.push(m)}
function dset(id,patch){demoSt.sessions.forEach(function(s){if(s.id===id){for(var k in patch)s[k]=patch[k];s.lastTs=Date.now();if(patch.tool)s.recentTools.push(patch.tool)}})}
var DEMO=[
  function(){demoSt={project:'demo',sessions:[dsess('L','claude','Leader')],messages:[]};dset('L',{lastText:'Waiting for Workers to join.'})},
  function(){demoSt.sessions.push(dsess('B','claude','Worker','backend-01'));dmsg('JOIN_REQUEST','B','L');dset('B',{proto:'JOINING',exec:'RUNNING',tool:'Bash: git status'})},
  function(){dmsg('JOIN_ACK','L','B');demoSt.sessions.push(dsess('F','codex','Worker','frontend-01'));dmsg('JOIN_REQUEST','F','L');dset('F',{proto:'JOINING',exec:'RUNNING',tool:'Read: AGENTS.md'})},
  function(){dmsg('ACK_RECEIVED','B','L');dset('B',{proto:'ACTIVE',exec:'IDLE',tool:''});dmsg('JOIN_ACK','L','F');demoSt.sessions.push(dsess('Q','claude','Reviewer','qa-01'));dmsg('JOIN_REQUEST','Q','L');dset('Q',{proto:'JOINING'})},
  function(){dmsg('ASSIGN','L','B');dmsg('ASSIGN','L','F');dset('B',{proto:'ASSIGNED',exec:'RUNNING',tool:'Edit: src/api/orders.ts'});dset('F',{proto:'ASSIGNED',exec:'RUNNING',tool:'Edit: ui/OrderList.tsx'});dset('Q',{proto:'ACTIVE'})},
  function(){dmsg('PEER_REQUEST','F','B',{});dset('B',{lastText:'Order status: pending, paid, cancelled.'})},
  function(){dmsg('PEER_REPLY','B','F',{});dmsg('REVIEW_REQUEST','B','Q',{ref:'PR#42'});dset('B',{proto:'IN_REVIEW',exec:'IDLE',tool:''});dset('Q',{proto:'IN_REVIEW',exec:'RUNNING',tool:'Read: PR#42 diff'})},
  function(){dmsg('REVIEW_FEEDBACK','Q','B',{ref:'PR#42#c3'});dset('B',{exec:'RUNNING',tool:'Bash: npm test'})},
  function(){dmsg('BLOCKED','F','L',{});dset('F',{proto:'BLOCKED',exec:'IDLE',tool:''});dmsg('REVIEW_RESULT','Q','B',{status:'approved',ref:'PR#42'})},
  function(){dmsg('REVIEW_VERDICT','Q','L',{status:'approved',ref:'PR#42'});dset('Q',{proto:'REVIEWED',exec:'IDLE',tool:''});dmsg('COMPLETE','B','L',{ref:'PR#42'});dset('B',{proto:'COMPLETE',exec:'IDLE',tool:''});dset('F',{proto:'ASSIGNED',exec:'RUNNING',tool:'Bash: npm run build'})},
  function(){dset('F',{proto:'ASSIGNED',exec:'IDLE',tool:''});dset('B',{proto:'ACTIVE'});dset('Q',{exec:'STALE'})},
  function(){}
];
function demoTick(){DEMO[demoStep]();demoStep=(demoStep+1)%DEMO.length;if(demoStep===1){firstLoad=true;seen={}}render(JSON.parse(JSON.stringify(demoSt)))}
var demoAt=(location.search.match(/[?&]at=(\d+)/)||[])[1];
function tick(){
  if(document.hidden)return;
  if(demo&&demoAt!=null){
    if(demoStep===0){for(var i=0;i<=Number(demoAt);i++)DEMO[i]();demoStep=1;render(JSON.parse(JSON.stringify(demoSt)));var op=(location.search.match(/[?&]open=(\w+)/)||[])[1];if(op){panel.style.transition=document.body.style.transition='none';openPanel(op)}}
    return;
  }
  if(demo){demoTick();return}
  fetch('/api/state',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(render)
    .catch(function(e){$('#meta').textContent='dashboard server unreachable ('+e.message+')'});
}
tick();setInterval(tick,demo?2800:3000);
})();
</script></body></html>
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
