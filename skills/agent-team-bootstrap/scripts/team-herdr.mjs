import { execFileSync } from 'node:child_process';

const INPUT_LIMIT = 64 * 1024;
const text = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const bounded = (value) => typeof value === 'string' && Buffer.byteLength(value) <= INPUT_LIMIT;

// This is a deliberately small shell subset, never a shell evaluator.
function tokenize(command) {
  const segments = [[]];
  let token = '', started = false, quote = null, singleOnly = false;
  const flush = () => {
    if (started) segments.at(-1).push({ value: token, singleOnly });
    token = ''; started = false; singleOnly = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && /[$`\\]/.test(c)) return null;
      token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      singleOnly = !started && c === "'";
      // Concatenated quote fragments are not a SINGLEQUOTED body.
      if (started) singleOnly = false;
      started = true; quote = c; continue;
    }
    if (c === ' ' || c === '\t') { flush(); continue; }
    if (c === ';') {
      flush();
      if (!segments.at(-1).length) return null;
      segments.push([]); continue;
    }
    if (c === '&' && command[i + 1] === '&') {
      flush();
      if (!segments.at(-1).length) return null;
      segments.push([]); i++; continue;
    }
    if (/[\x00-\x1f\x7f$`|<>(){}\\#&*?\[\]~]/.test(c)) return null;
    singleOnly = false; started = true; token += c;
  }
  if (quote) return null;
  flush();
  if (!segments.at(-1).length && command.trimEnd().endsWith(';')) segments.pop();
  return segments.at(-1)?.length ? segments : null;
}

export function parseHerdrCommand(command) {
  if (!bounded(command)) return [];
  const segments = tokenize(command);
  if (!segments) return [];
  const messages = [];
  for (const tokens of segments) {
    const values = tokens.map((token) => token.value);
    // Compound shell syntax and known short-circuit failures are not evidence of delivery.
    if (/^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|time|coproc|repeat|foreach|end|\[\[|\]\]|!|false|exit|return)$/.test(values[0])) return [];
    if (values[0] !== 'herdr') continue;
    if (values[1] !== 'agent' || values[2] !== 'prompt') return [];
    const to = values[3], body = values[4];
    if (!to || to.startsWith('-') || !tokens[4]?.singleOnly || !body) return [];
    const seen = new Set();
    for (let i = 5; i < values.length; i++) {
      const flag = values[i];
      if (flag === '--wait' && !seen.has(flag)) { seen.add(flag); continue; }
      if (flag === '--until' && /^(working|blocked)$/.test(values[i + 1] || '')) { i++; continue; }
      if (flag === '--timeout' && !seen.has(flag) && /^[1-9]\d*$/.test(values[i + 1] || '')) {
        seen.add(flag); i++; continue;
      }
      return [];
    }
    // Main's parseEnvelope validates the full protocol; avoid a circular dashboard import.
    if ((/^P:/.test(body) && /\bFROM:\S+/.test(body)) ||
        (/^protocol:/.test(body) && /^\s*from:\s*\S+/m.test(body))) messages.push({ to, body });
  }
  return messages;
}

function identity(agent) {
  if (!agent || !['claude', 'codex'].includes(agent.agent) || agent.agent_session?.kind !== 'id' ||
      !text(agent.agent_session.value) || !text(agent.pane_id)) return null;
  return { client: agent.agent, session: agent.agent_session.value, name: text(agent.name), paneId: agent.pane_id };
}

function contentText(content) {
  if (typeof content === 'string') return bounded(content) ? content : null;
  if (!Array.isArray(content)) return null;
  let result = '';
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (Buffer.byteLength(result) + Buffer.byteLength(block.text) + (result ? 1 : 0) > INPUT_LIMIT) return null;
    result += (result ? '\n' : '') + block.text;
  }
  return result;
}

export function parseHerdrResult(content, isError = false) {
  const source = contentText(content);
  if (source === null) return { delivery: 'unknown', agents: [] };
  let accepted = false, error;
  const agents = [];
  for (const line of source.split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.result?.type === 'agent_prompted') {
      accepted = true;
      const agent = identity(row.result.agent);
      if (agent) agents.push(agent);
    }
    if (row?.error && typeof row.error === 'object' && text(row.error.code) && text(row.error.message)) {
      error = `${row.error.code}: ${row.error.message}`;
    }
  }
  if (!error && isError) error = source.trim() || 'Herdr tool failed';
  // An accepted submission is not an ACK, even when a subsequent wait times out.
  const delivery = accepted ? 'accepted' : error && !/(?:timeout|timed out)/i.test(error) ? 'failed' : 'unknown';
  return { delivery, agents, ...(error ? { error } : {}) };
}

export function createHerdrObserver({ now = Date.now, run = execFileSync } = {}) {
  let cached, sampledAt;
  return {
    snapshot() {
      const observedAt = now();
      if (cached && observedAt >= sampledAt && observedAt - sampledAt < 5000) return structuredClone(cached);
      sampledAt = observedAt;
      try {
        const output = run('herdr', ['agent', 'list'], {
          encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const source = Buffer.isBuffer(output) ? output.toString('utf8') : output;
        if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) throw new Error('Invalid Herdr registry output');
        const result = JSON.parse(source)?.result;
        if (result?.type !== 'agent_list' || !Array.isArray(result.agents)) throw new Error('Invalid Herdr registry shape');
        const agents = result.agents.flatMap((row) => {
          const agent = identity(row);
          return agent ? [{ ...agent, status: text(row.agent_status) || 'unknown' }] : [];
        });
        cached = { status: 'ok', observedAt, agents };
      } catch (error) {
        cached = { status: 'unavailable', observedAt, agents: [], error: String(error?.message || error).slice(0, 1000) };
      }
      return structuredClone(cached);
    },
  };
}
