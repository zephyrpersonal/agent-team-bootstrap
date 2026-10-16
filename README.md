# Agent Team Bootstrap

[简体中文说明 / Chinese README](README.zh-CN.md)

A portable **Leader / Worker** collaboration skill for **Codex** and **Claude Code**, built around each product's **native cross-session messaging** rather than file-backed inboxes.

A Worker may be created **manually by the user** or **by the Leader** (when independent-session creation is actually supported). The Worker declares its responsibilities, requests to join a verified Leader session, and reports progress or blockers. The Leader acknowledges membership, tracks each Worker's responsibilities, routes dependencies and review requests, and summarizes Worker receipts. Implementation, testing and code review belong exclusively to Workers (including Reviewer Workers).

> **Important:** This Skill describes and uses native messaging *when the running client exposes it*. It does **not** create an always-on background agent, guarantee wake-up semantics, or bridge Codex and Claude Code automatically.

## Install with npx skills

Install for **Codex and Claude Code**, globally (recommended for multi-project use):

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -g -y
```

Or install for the **current project**:

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -y
```

Inspect the detected skills before installation:

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --list
```

For other agents or an interactive selection, run `npx skills add zephyrpersonal/agent-team-bootstrap` without flags.

### Private repository authentication

This repository is currently **private**. To install on another machine, first authenticate to GitHub (for example with `gh auth login`, Git credential helper, or SSH access to this repository). The Skills CLI supports authenticated private repositories. To let anyone install without GitHub access, change repository visibility to Public in GitHub Settings.

## Strict Leader role

The Leader is a **coordination-only, receipt-driven role**. It does not code, debug, test, inspect source/PR diffs, review implementations, merge, deploy or stand in for a missing Worker. It never launches listeners, watchers, polling loops, timers, scheduled tasks or background processes. After assignment it ends the turn and relies on **native incoming Worker messages** to resume where the host supports it. Review requests are delegated to a separate Reviewer Worker.

## Start a Leader

Run in a dedicated Codex session or Claude Code session (ideally from a separate, non-coding worktree).

**Codex**

```text
$agent-team-bootstrap leader
Project: my-project
You are the project Leader. Read project policy, detect native cross-session messaging,
identify and display your real session/thread address, discover existing peers,
accept verified Worker JOIN_REQUEST messages, and coordinate ONLY. Do not code, test, review or poll; after dispatch return idle and await native receipts.
Never claim native delivery unless it succeeds, and do not use a file inbox.
```

**Claude Code**: replace `$agent-team-bootstrap` with `/agent-team-bootstrap`.

## Start a Worker

You can manually open a Worker session, independently of how the Leader was created.

```text
$agent-team-bootstrap worker
Project: my-project
Worker ID: backend-01
Created by: human
Responsibilities: Own the order API implementation and its tests; do not edit migrations.
Leader target: <verified native session/thread address>
Send JOIN_REQUEST to the Leader using a real native cross-session messaging tool.
Wait for JOIN_ACK; report blockers, interface changes, ready-for-review, and completion.
```

**Claude Code**: replace `$agent-team-bootstrap` with `/agent-team-bootstrap`.

A Leader may also delegate to an independent Worker **if** creation is actually exposed and authorized, otherwise it should provide a bootstrap prompt for manual startup. Subagents are not silently substituted for independent sessions.

## Codex TUI message budget

Current Codex TUI source enforces a **1,000-byte UTF-8 prompt limit** on `send_message_to_thread` (`MAX_INPUT_BYTES`). The error `prompt exceeded the maximum context budget` is therefore a **per-message pre-send validation error**, not proof of an exhausted model context window. This Skill uses a conservative **600-byte native message budget**. Send compact events and references to existing artifacts rather than long task briefs. Never build polling or inbox machinery to work around this limit.

## Worker Mesh: direct peer collaboration

**Routine technical collaboration goes Worker → Worker**, never through Leader. Leader stays a strict, receipt-driven Control Plane (registration, ownership, assignments, impactful conflict decisions and final status). Registered Workers with authorized verified peer addresses can directly use native `PEER_REQUEST` / `PEER_REPLY` for interface questions and integration.

Review is likewise P2P: producer sends `REVIEW_REQUEST` to Reviewer, Reviewer sends `REVIEW_FEEDBACK` / final `REVIEW_RESULT` to producer. **Only final results** reach Leader: one `REVIEW_VERDICT` from Reviewer and a separate `COMPLETE` from producer. Ask Leader once for `PEER_ROUTE_REQUEST` or `REVIEWER_NEEDED` if peer identification/ownership needs coordination. Do not CC Leader on every exchange; peer messages never grant expanded permission. Codex TUI's 600 UTF-8 byte conservative message cap also applies here.

## First-time messaging test

1. Run the Leader bootstrap; check the actual native tools and leader address.
2. Run the Worker bootstrap, using that exact verified Leader address.
3. Have Worker send `PING`, verify the Leader responds `PONG` with matching `in_reply_to`.
4. Worker sends `JOIN_REQUEST`; Leader replies `JOIN_ACK`; Worker acknowledges.
5. Producer sends `REVIEW_REQUEST` directly to Reviewer; Reviewer sends final `REVIEW_RESULT` directly to producer and one `REVIEW_VERDICT` to Leader. Producer separately sends `COMPLETE` to Leader.

If peer-to-peer sending is unavailable, the skill must report `NATIVE_MESSAGING_UNAVAILABLE`, **not** pretend that a file write or Git commit is a native message. Different versions of Codex Desktop and CLI can expose different thread-management tools. Native Codex messages do not directly reach Claude Code sessions and vice versa.

## Directory layout

```text
.
├── README.md
├── LICENSE
├── skills/
│   └── agent-team-bootstrap/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       └── references/
│           ├── quickstart.md
│           ├── protocol.md
│           └── transports.md
└── templates/
    ├── AGENTS.md
    └── .agents/collaboration.md
```

The optional project templates define team roles and communication rules. They are **not** automatically installed into your project by `npx skills`; merge them into your project's policy files if useful. `AGENTS.md` is recognized by Codex; Claude Code projects may need their own `CLAUDE.md` configuration depending on version.

## Design principles

- **Role is independent of creator:** a human-created Worker can report to the project's Leader.
- **Native messaging first:** `ListAgents` / `SendMessage` for Claude Code, exposed thread messaging tools for Codex.
- **Actual capabilities only:** probe which tools the host provides; never hallucinate session APIs or treat `spawn_agent` as an independent thread.
- **Explicit acknowledgments:** `JOIN_REQUEST` / `JOIN_ACK`, `ASSIGN` / `ASSIGN_ACK`; direct peer `REVIEW_REQUEST` / `REVIEW_RESULT`; final `REVIEW_VERDICT` and `COMPLETE` to Leader.
- **Deliverables are separate from messages:** Git/PR/tests persist artifacts; cross-session messages coordinate work.
- **No Issue dependency:** tasks can originate from the user, the Leader, a Worker, or an external system.
- **No implicit privileged actions:** merges, production deployments, destructive DB operations, and scope expansion must follow project approval rules.

## References

- [`SKILL.md`](skills/agent-team-bootstrap/SKILL.md): main skill instructions
- [`quickstart.md`](skills/agent-team-bootstrap/references/quickstart.md): bootstrap flows and testing
- [`protocol.md`](skills/agent-team-bootstrap/references/protocol.md): message envelope and handshakes
- [`transports.md`](skills/agent-team-bootstrap/references/transports.md): Claude / Codex transport capability matrix
- [`templates/AGENTS.md`](templates/AGENTS.md): optional project policy
- [`templates/.agents/collaboration.md`](templates/.agents/collaboration.md): optional detailed team protocol

## License

MIT.