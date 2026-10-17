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
  const c = d.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  for (const b of blocks) {
    if (d.type === 'assistant') {
      if (b.type === 'text') ev.push({ ts, kind: 'text', role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') {
        ev.push({ ts, kind: 'tool_call', callId: b.id, name: b.name, input: b.input });
        if (b.name === 'SendMessage') ev.push({ ts, kind: 'send', to: b.input?.to, body: b.input?.message });
      }
    } else if (d.type === 'user') {
      if (b.type === 'tool_result') ev.push({ ts, kind: 'tool_result', callId: b.tool_use_id });
      else if (b.type === 'text') {
        ev.push({ ts, kind: 'text', role: 'user', text: b.text });
        // shortcut: wrapper taken from SendMessage's tool description, no real transcript sample yet; fix against one
        const r = String(b.text).match(/^\s*<cross-session-message\b[^>]*\bfrom="([^"]*)"[^>]*>([\s\S]*?)<\/cross-session-message>/);
        if (r) ev.push({ ts, kind: 'recv', from: r[1], body: r[2] });
      }
    }
  }
  return ev;
}

// shortcut: Codex rollout format unverified locally, fix against a real rollout file
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
      if (/send_message_to_thread$/.test(p.name || '')) {
        ev.push({ ts, kind: 'send', to: input?.thread_id ?? input?.threadId ?? input?.target ?? input?.to, body: input?.prompt });
      }
    } else if (p.type === 'function_call_output') ev.push({ ts, kind: 'tool_result', callId: p.call_id });
  } else if (d.type === 'event_msg') {
    if (p.type === 'task_started') ev.push({ ts, kind: 'turn_start' });
    else if (p.type === 'task_complete') ev.push({ ts, kind: 'turn_end' });
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
    case 'turn_start': s.last = 'busy'; break;
    case 'turn_end': s.last = 'idle'; break;
    case 'text':
      s.last = ev.role === 'assistant' ? 'idle' : 'busy';
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
  let buf;
  try {
    // shortcut: whole new tail read into one Buffer, fine below ~1 GB, chunk it if transcripts get bigger
    const b = Buffer.alloc(size - rec.offset);
    const n = fs.readSync(fd, b, 0, b.length, rec.offset);
    rec.offset += n;
    buf = Buffer.concat([rec.rest, b.subarray(0, n)]);
  } finally { fs.closeSync(fd); }
  const nl = buf.lastIndexOf(10);
  if (nl < 0) { rec.rest = buf; return; }
  rec.rest = buf.subarray(nl + 1);
  const parse = rec.client === 'codex' ? parseCodexLine : parseClaudeLine;
  for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    for (const ev of parse(d, rec.ctx)) ingest(rec, ev);
  }
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
    let k = msg.toSession || byName.get(msg.to) || byName.get(stripRef(msg.toRaw));
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
      recentTools: s.tools.map((t) => clip(`${t.name}: ${t.summary}`, 80)), lastTs, unverified: mi.r.client === 'codex',
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
:root{--bg:#fff3dc;--panel:#fffdf7;--text:#2b2540;--muted:#6b6483;--line:#2b2540;--stage:#ffe3b8;--floor:#ffcf8a;--claude:#ff9f5a;--claude2:#ffd9b8;--codex:#4fcf85;--codex2:#cdf4dc;--accent:#845ef7;--card-b:#2b2540}
@media (prefers-color-scheme:dark){:root{--bg:#171424;--panel:#221d36;--text:#f3efff;--muted:#a79fc4;--line:#120f1d;--stage:#2d2748;--floor:#3b3360;--card-b:#5a4f8a}}
*{box-sizing:border-box}
body{margin:0;padding:0 16px 40px;background:var(--bg);color:var(--text);font:15px/1.45 ui-rounded,"Nunito","Segoe UI",system-ui,sans-serif}
.top{max-width:1000px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;padding-top:16px}
h1{margin:0;font-size:26px}h2{margin:24px 0 8px;font-size:18px}
#meta{color:var(--muted);font-size:13px}
.hint{max-width:1000px;margin:4px auto 12px;color:var(--muted);font-size:12.5px}
main{max-width:1000px;margin:0 auto}
.stagewrap{position:relative}
#stage{width:100%;height:auto;display:block;border:4px solid var(--card-b);border-radius:28px;background:var(--stage)}
#empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px;font-weight:700;color:var(--muted);pointer-events:none}
.bgfloor{fill:var(--floor);opacity:.55}.cloud{fill:#fff;opacity:.55;animation:drift 40s linear infinite}.cloud.c2{animation-duration:65s;animation-delay:-20s}
@keyframes drift{from{transform:translateX(-160px)}to{transform:translateX(1060px)}}
.chr{transition:transform 1.2s cubic-bezier(.3,1.35,.5,1),opacity .6s}
.chr text{paint-order:stroke;stroke:var(--stage);stroke-width:4px;stroke-linejoin:round;fill:var(--text);text-anchor:middle;font-family:inherit}
.chr .name{font-size:14px;font-weight:800}.chr .st{font-size:11px;font-weight:700}
.chr .inner,.chr .body,.chr .gear,.chr .mag,.chr .zzz text,.chr .conf rect,.chr .arm.r{transform-box:fill-box}
.ol{stroke:var(--line);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}
.claude .fill{fill:var(--claude)}.claude .belly{fill:var(--claude2)}.codex .fill{fill:var(--codex)}.codex .belly{fill:var(--codex2)}
.shadow{fill:#000;opacity:.15}.white{fill:#fff}.pupil{fill:var(--line)}.cheek{fill:#ff7a8a;opacity:.45}
.mouth{fill:none}.frown,.ec,.gear,.zzz,.bang,.conf,.mag,.bubble{display:none}
.eo{animation:blink 5s infinite;transform-box:fill-box;transform-origin:center}
@keyframes blink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.1)}}
.m-running .gear,.m-idle .zzz,.m-stale .zzz,.m-blocked .bang,.m-complete .conf,.r-reviewer .mag{display:block}
.m-idle .eo,.m-stale .eo{display:none}.m-idle .ec,.m-stale .ec{display:block}
.m-blocked .smile{display:none}.m-blocked .frown{display:block}
.has-tool .bubble{display:block}
.m-running .body{animation:hop .6s ease-in-out infinite}
@keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.m-idle .body{animation:breathe 3.2s ease-in-out infinite;transform-origin:50% 100%}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04,.97)}}
.m-blocked .inner{animation:shake .35s ease-in-out infinite;transform-origin:50% 100%;transform-box:fill-box}
@keyframes shake{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}
.m-stale{opacity:.5;filter:grayscale(.9)}.m-stale .inner{animation:ghost 4s ease-in-out infinite}
@keyframes ghost{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.gear{animation:spin 1.2s linear infinite;transform-origin:center}
@keyframes spin{to{transform:rotate(360deg)}}
.zzz text{font-size:15px;font-weight:800;fill:var(--muted);stroke:none;opacity:0;animation:zz 3s ease-out infinite}
.zzz text:nth-child(2){animation-delay:1s}.zzz text:nth-child(3){animation-delay:2s}
@keyframes zz{0%{opacity:0;transform:translate(0,8px)}30%{opacity:1}100%{opacity:0;transform:translate(14px,-22px)}}
.bang circle{fill:#fa5252}.bang text{fill:#fff;stroke:none;font-size:18px;font-weight:900}
.m-review .mag,.r-reviewer.m-review .mag{animation:sweep 1.1s ease-in-out infinite;transform-origin:0% 100%}
@keyframes sweep{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(22deg)}}
.conf rect{opacity:0;animation:fall 1.8s ease-in forwards}
@keyframes fall{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--dx),70px) rotate(360deg)}}
.joining .arm.r{animation:wave .5s ease-in-out infinite alternate;transform-origin:50% 100%}
@keyframes wave{from{transform:rotate(0)}to{transform:rotate(-35deg)}}
.ring{fill:none;stroke:var(--accent);stroke-width:4;opacity:0}
.got .ring{animation:ring .7s ease-out}
@keyframes ring{0%{opacity:.9;transform:scale(.7)}100%{opacity:0;transform:scale(1.35)}}
.ring{transform-box:fill-box;transform-origin:center}
.bubble rect{fill:var(--panel);stroke:var(--line);stroke-width:2.5}.bubble text{font-size:11px;font-weight:700;stroke:none;text-anchor:start}
.env rect{stroke:var(--line);stroke-width:2.5}.env text{fill:#fff;stroke:none;font-size:10px;font-weight:800;text-anchor:middle}
.link{stroke:var(--accent);fill:none;opacity:.5;stroke-dasharray:6 8;animation:dash 1.2s linear infinite}
@keyframes dash{to{stroke-dashoffset:-14}}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.card{background:var(--panel);border:3px solid var(--card-b);border-radius:18px;padding:12px 14px;min-width:0}
.card header{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}.card b{font-size:16px}
.tag,.pill{font-size:11px;font-weight:800;border-radius:99px;padding:1px 9px;border:2px solid var(--card-b)}
.tag.claude{background:var(--claude2);color:#2b2540}.tag.codex{background:var(--codex2);color:#2b2540}.tag.warn{background:#fff3bf;color:#7a5b00}
.pill.RUNNING{background:#d3f9d8;color:#1b5e20}.pill.IDLE{background:#e7f5ff;color:#1c4e80}.pill.STALE{background:#e9ecef;color:#495057}.pill.BLOCKED{background:#ffe3e3;color:#a61e1e}
.pill.proto{background:#f3ecff;color:#4c2a9a}
.kv{display:flex;gap:8px;font-size:12.5px;margin-top:3px;min-width:0}.kv span{color:var(--muted);flex:none;width:34px}.kv code,.kv i{min-width:0;overflow-wrap:anywhere;font-style:normal}
.kv code{font:12px ui-monospace,Menlo,monospace}
#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
#chips button{font:inherit;font-size:12px;font-weight:800;border:2px solid var(--card-b);background:var(--panel);color:var(--text);border-radius:99px;padding:2px 10px;cursor:pointer}
#chips button[aria-pressed=true]{background:var(--accent);color:#fff}
.tablewrap{overflow-x:auto;background:var(--panel);border:3px solid var(--card-b);border-radius:18px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--card-b);white-space:nowrap}th{color:var(--muted)}
@media (prefers-reduced-motion:reduce){#stage *{animation:none!important;transition:none!important}.m-stale{opacity:.5}}
</style></head><body>
<div class="top"><h1>🏢 Agent Team Office</h1><div id="meta"></div></div>
<p class="hint">Read-only view inferred from session transcripts · 只读观察，基于 transcript 推断；会话关闭与空闲无法区分（30 分钟无活动记为 STALE）。</p>
<main>
<section class="stagewrap">
<svg id="stage" viewBox="0 0 900 440" role="group" aria-label="Team stage">
<ellipse class="bgfloor" cx="450" cy="300" rx="430" ry="150"/>
<g class="cloud"><ellipse cx="0" cy="40" rx="46" ry="14"/><ellipse cx="22" cy="30" rx="26" ry="14"/></g>
<g class="cloud c2"><ellipse cx="0" cy="84" rx="38" ry="11"/><ellipse cx="-16" cy="76" rx="20" ry="11"/></g>
<g id="links"></g><g id="chars"></g><g id="envs"></g>
</svg>
<div id="empty"></div>
</section>
<h2>Team</h2><div id="cards" class="cards"></div>
<h2>Messages</h2><div id="chips"></div>
<div class="tablewrap"><table><thead><tr><th>Time</th><th>From → To</th><th>Type</th><th>ID</th><th>RE</th><th>Status / Ref</th></tr></thead><tbody id="msgs"></tbody></table></div>
</main>
<script>
(function(){
'use strict';
var NS='http://www.w3.org/2000/svg';
var demo=/[?&]demo=1/.test(location.search);
var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
var $=function(s){return document.querySelector(s)};
function el(tag,attrs,parent){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function hms(t){return new Date(t).toTimeString().slice(0,8)}
function ago(ms){var s=Math.max(0,Math.round(ms/1000));return s<60?s+'s ago':s<3600?Math.round(s/60)+'m ago':Math.round(s/3600)+'h ago'}
function clip(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s}

var ICON={running:'⚙',idle:'💤',stale:'👻',blocked:'⛔',review:'🔍',complete:'🎉'};
function modeOf(s){
  if(s.exec==='STALE')return 'stale';
  if(s.proto==='BLOCKED')return 'blocked';
  if(s.proto==='COMPLETE'&&s.exec!=='RUNNING')return 'complete';
  if(s.proto==='IN_REVIEW')return 'review';
  return s.exec==='RUNNING'?'running':'idle';
}

var chars={},pos={},seen={},firstLoad=true,filterType=null,linkSig='';
var charsG=$('#chars'),linksG=$('#links'),envsG=$('#envs');

function buildHat(g,role){
  g.textContent='';
  if(role==='Leader'){el('path',{d:'M-18 -40 L-22 -64 L-9 -52 L0 -68 L9 -52 L22 -64 L18 -40 Z',fill:'#ffd43b','class':'ol'},g)}
  else if(role==='Worker'){
    el('path',{d:'M-26 -34 Q-26 -62 0 -62 Q26 -62 26 -34 Z',fill:'#ffd23f','class':'ol'},g);
    el('rect',{x:-32,y:-37,width:64,height:8,rx:4,fill:'#ffbe0b','class':'ol'},g);
    el('rect',{x:-4,y:-62,width:8,height:24,fill:'#ffbe0b'},g);
  }else{
    el('circle',{cx:-15,cy:-8,r:13,fill:'none',stroke:'#2b2540','stroke-width':3},g);
    el('circle',{cx:15,cy:-8,r:13,fill:'none',stroke:'#2b2540','stroke-width':3},g);
    el('line',{x1:-2,y1:-8,x2:2,y2:-8,stroke:'#2b2540','stroke-width':3},g);
  }
}

function makeChar(s){
  var g=el('g',{role:'img'},charsG);
  el('ellipse',{cx:0,cy:54,rx:34,ry:8,'class':'shadow'},g);
  var inner=el('g',{'class':'inner'},g);
  var body=el('g',{'class':'body'},inner);
  el('ellipse',{cx:-12,cy:50,rx:13,ry:7,'class':'fill ol'},body);
  el('ellipse',{cx:12,cy:50,rx:13,ry:7,'class':'fill ol'},body);
  el('ellipse',{cx:-40,cy:10,rx:9,ry:15,'class':'fill ol arm l'},body);
  el('ellipse',{cx:40,cy:10,rx:9,ry:15,'class':'fill ol arm r'},body);
  el('ellipse',{cx:0,cy:4,rx:40,ry:46,'class':'fill ol'},body);
  el('ellipse',{cx:0,cy:22,rx:23,ry:22,'class':'belly'},body);
  var eo=el('g',{'class':'eo'},body);
  [-15,15].forEach(function(x){el('circle',{cx:x,cy:-8,r:10,'class':'white ol',style:'stroke-width:2.5'},eo);el('circle',{cx:x+1,cy:-7,r:5,'class':'pupil'},eo)});
  var ec=el('g',{'class':'ec'},body);
  el('path',{d:'M-24 -8 Q-15 -1 -6 -8','class':'ol',fill:'none'},ec);el('path',{d:'M6 -8 Q15 -1 24 -8','class':'ol',fill:'none'},ec);
  el('circle',{cx:-28,cy:6,r:5,'class':'cheek'},body);el('circle',{cx:28,cy:6,r:5,'class':'cheek'},body);
  el('path',{d:'M-8 6 Q0 15 8 6','class':'ol mouth smile'},body);
  el('path',{d:'M-8 13 Q0 4 8 13','class':'ol mouth frown'},body);
  g._hat=el('g',{'class':'hat'},body);
  var mag=el('g',{'class':'mag',transform:'translate(46,22)'},body);
  el('line',{x1:0,y1:0,x2:10,y2:-18,'class':'ol'},mag);el('circle',{cx:13,cy:-26,r:11,fill:'#e7f5ff','fill-opacity':.7,'class':'ol'},mag);
  var gear=el('g',{'class':'gear',transform:'translate(-30,-72)'},inner);
  el('circle',{cx:0,cy:0,r:8,fill:'#adb5bd','class':'ol'},gear);
  for(var i=0;i<6;i++)el('rect',{x:-2.5,y:-13,width:5,height:6,fill:'#adb5bd','class':'ol',transform:'rotate('+(i*60)+')'},gear);
  var z=el('g',{'class':'zzz',transform:'translate(26,-60)'},inner);['z','Z','z'].forEach(function(t){var e=el('text',{x:0,y:0},z);e.textContent=t});
  var b=el('g',{'class':'bang',transform:'translate(0,-76)'},inner);el('circle',{cx:0,cy:0,r:12,'class':'ol'},b);var bt=el('text',{x:0,y:6},b);bt.textContent='!';
  var cf=el('g',{'class':'conf',transform:'translate(0,-60)'},inner);
  ['#fa5252','#ffd43b','#51cf66','#4dabf7','#f783ac','#845ef7','#ffa94d','#20c997'].forEach(function(c,i){el('rect',{x:(i-4)*8,y:0,width:6,height:9,fill:c,style:'--dx:'+((i-3.5)*12)+'px;animation-delay:'+(i*60)+'ms'},cf)});
  g._bub=el('g',{'class':'bubble'},inner);g._bubR=el('rect',{x:0,y:-60,width:80,height:22,rx:9},g._bub);g._bubT=el('text',{x:8,y:-45},g._bub);
  g._ring=el('circle',{cx:0,cy:6,r:56,'class':'ring'},g);
  g._name=el('text',{x:0,y:80,'class':'name'},g);g._st=el('text',{x:0,y:96,'class':'st'},g);
  g._title=el('title',{},g);
  return g;
}

function layout(list){
  var leader=list.filter(function(s){return s.role==='Leader'})[0];
  var others=list.filter(function(s){return s!==leader});
  var p={};
  if(leader)p[leader.id]={x:450,y:118};
  others.forEach(function(s,i){
    var t=others.length===1?.5:i/(others.length-1),th=Math.PI*(.12+.76*t);
    p[s.id]={x:450-Math.cos(th)*350,y:190+Math.sin(th)*128};
  });
  return p;
}

function renderStage(st){
  var list=st.sessions.slice().sort(function(a,b){return (b.role==='Leader')-(a.role==='Leader')||a.name.localeCompare(b.name)});
  var p=layout(list),alive={};
  list.forEach(function(s){
    alive[s.id]=1;
    var g=chars[s.id],isNew=!g,pp=p[s.id];
    if(isNew){g=chars[s.id]=makeChar(s);g.setAttribute('class','chr');g.style.transform='translate('+(pp.x<450?-110:1010)+'px,'+pp.y+'px)';void g.getBoundingClientRect()}
    if(g._role!==s.role){g._role=s.role;buildHat(g._hat,s.role)}
    var mode=modeOf(s),side=pp.x>450?-1:1,tool=s.exec==='RUNNING'?s.tool:'';
    g.setAttribute('class','chr '+s.client+' m-'+mode+' r-'+s.role.toLowerCase()+(s.proto==='JOINING'?' joining':'')+(tool?' has-tool':'')+(g._got?' got':''));
    g.style.transform='translate('+pp.x+'px,'+pp.y+'px)';
    var label=clip(tool,26),w=Math.max(40,label.length*6.4+16);
    g._bubT.textContent=label;g._bubR.setAttribute('width',w);
    g._bub.setAttribute('transform','translate('+(side>0?52:-52-w)+',0)');
    g._name.textContent=s.name+(s.unverified?' ⚠':'');
    g._st.textContent=ICON[mode]+' '+(s.exec==='STALE'?'STALE':mode)+(s.proto&&s.proto!=='NONE'?' · '+s.proto:'');
    var desc=s.name+', '+s.role+', '+s.exec.toLowerCase()+(tool?' '+tool:'')+(s.unverified?' (Codex format unverified)':'');
    g.setAttribute('aria-label',desc);g._title.textContent=desc;
  });
  Object.keys(chars).forEach(function(id){if(!alive[id]){var g=chars[id];delete chars[id];g.style.opacity=0;setTimeout(function(){g.remove()},700)}});
  pos=p;
  $('#empty').style.display=list.length?'none':'flex';
  if(!list.length)$('#empty').textContent='No team activity for project "'+st.project+'" yet. Start a Leader and Workers and send a JOIN_REQUEST.';
  // links between pairs that have exchanged messages
  var pairs={};
  st.messages.forEach(function(m){if(m.from&&m.to){var k=[m.from,m.to].sort().join('|');pairs[k]=(pairs[k]||0)+1}});
  var sig=Object.keys(pairs).map(function(k){return k+'#'+pairs[k]}).join(';')+JSON.stringify(p);
  if(sig!==linkSig){
    linkSig=sig;linksG.textContent='';
    Object.keys(pairs).forEach(function(k){var ab=k.split('|'),a=p[ab[0]],b=p[ab[1]];
      if(a&&b)el('line',{x1:a.x,y1:a.y+10,x2:b.x,y2:b.y+10,'class':'link','stroke-width':1+Math.min(pairs[k],6)*.8},linksG)});
  }
}

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

function fly(m,delay){
  var a=pos[m.from],b=pos[m.to];
  if(!a||!b)return;
  var target=chars[m.to];
  var done=function(){if(!target)return;target._got=1;target.classList.add('got');setTimeout(function(){target._got=0;target.classList.remove('got')},800)};
  if(reduce){setTimeout(done,delay);return}
  var dur=m.p2p?1100:1800,t0=null;
  var g=el('g',{'class':'env',opacity:0},envsG);
  var ab=TYPE_ABBR[m.type]||m.type.slice(0,5),w=Math.max(40,ab.length*7+14);
  el('rect',{x:-w/2,y:-12,width:w,height:24,rx:6,fill:typeColor(m.type)},g);
  var tx=el('text',{x:0,y:4},g);tx.textContent=ab;
  var x0=a.x,y0=a.y-10,x2=b.x,y2=b.y-10,cx=(x0+x2)/2,cy=Math.min(y0,y2)-90;
  function step(ts){
    if(t0===null)t0=ts+delay;
    var t=(ts-t0)/dur;
    if(t<0){requestAnimationFrame(step);return}
    if(t>=1){g.remove();done();return}
    var u=1-t,e=t*t*(3-2*t),ue=1-e;
    g.setAttribute('transform','translate('+(ue*ue*x0+2*ue*e*cx+e*e*x2)+','+(ue*ue*y0+2*ue*e*cy+e*e*y2)+')');
    g.setAttribute('opacity',Math.min(1,t*8,(1-t)*6));
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function renderMessages(st){
  var fresh=[];
  st.messages.forEach(function(m){var k=m.id||(m.ts+m.type+m.from);if(!seen[k]){seen[k]=1;if(!firstLoad)fresh.push(m)}});
  fresh.forEach(function(m,i){fly(m,i*350)});
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
    return '<article class="card"><header><b>'+esc(s.name)+'</b><span class="tag">'+esc(s.role)+'</span><span class="tag '+esc(s.client)+'">'+(s.client==='codex'?'Codex':'Claude')+'</span>'+(s.unverified?'<span class="tag warn" title="Codex rollout parsing is not verified against real files">format unverified</span>':'')+'</header>'
      +'<div><span class="pill '+esc(s.exec)+'">'+esc(s.exec)+'</span> <span class="pill proto">'+esc(s.proto)+'</span></div>'
      +'<div class="kv"><span>cwd</span><code>'+esc(s.cwd||'?')+'</code></div>'
      +'<div class="kv"><span>tool</span><code>'+esc(s.exec==='RUNNING'&&s.tool?s.tool:'—')+'</code></div>'
      +'<div class="kv"><span>said</span><i>'+esc(s.lastText||'—')+'</i></div>'
      +'<div class="kv"><span>last</span><i>'+(s.lastTs?ago(Date.now()-s.lastTs):'?')+'</i></div>'
      +(s.recentTools.length?'<div class="kv"><span>recent</span><i>'+s.recentTools.slice().reverse().map(esc).join('<br>')+'</i></div>':'')
      +'</article>';
  }).join('');
}

var lastState={project:'',sessions:[],messages:[]};
function render(st){
  lastState=st;
  renderStage(st);renderMessages(st);renderCards(st);
  $('#meta').textContent='project '+st.project+' · '+st.sessions.length+' sessions · '+st.messages.length+' messages · updated '+hms(Date.now())+(demo?' · DEMO':'');
}

// ---- scripted demo (?demo=1): JOIN -> ASSIGN -> PEER -> REVIEW -> COMPLETE, then loops ----
var demoStep=0,demoSt=null,demoN=0;
function dsess(id,client,role,name){return {id:id,short:id,client:client,cwd:'/work/'+(name||'leader'),workerId:name,name:name||'leader',role:role,proto:role==='Leader'?'COORDINATING':'NONE',exec:'IDLE',tool:'',lastText:'',recentTools:[],lastTs:Date.now(),unverified:client==='codex'}}
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
  function(){dset('F',{proto:'ASSIGNED',exec:'IDLE',tool:''});dset('Q',{exec:'STALE'})},
  function(){}
];
function demoTick(){DEMO[demoStep]();demoStep=(demoStep+1)%DEMO.length;if(demoStep===1){firstLoad=true;seen={}}render(JSON.parse(JSON.stringify(demoSt)))}

function tick(){
  if(document.hidden)return;
  if(demo){demoTick();return}
  fetch('/api/state',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(render)
    .catch(function(e){$('#meta').textContent='dashboard server unreachable ('+e.message+')'});
}
tick();setInterval(tick,demo?2400:3000);
})();
</script></body></html>
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
