# Agent Team Bootstrap

[简体中文](README.zh-CN.md)

**Agent Team Bootstrap** is a reusable multi-session collaboration Skill for Codex and Claude Code. It coordinates independent Leader, Worker, and Reviewer sessions through available **native cross-session messaging**.

## Features

- **Coordination-only Leader:** assigns ownership, coordinates dependencies, handles exceptions, and summarizes confirmed outcomes. Does not code, test, review code, merge, deploy, or poll for updates.
- **Worker Mesh:** registered Workers communicate directly for implementation questions, API contracts, integration and bug fixes, without routing routine messages through the Leader.
- **Peer code review:** Reviewer and producing Worker exchange feedback directly. Only final review verdict and completion receipts reach the Leader.
- **Native session transport:** uses actual supported Codex or Claude Code peer messaging tools; no custom mailbox, daemon, listener, or timer.
- **Optional herdr transport:** when the Owner opts in, members in [herdr](https://herdr.dev/) panes message each other with `herdr agent prompt`, so one team can mix Codex, Claude Code, Gemini, opencode and other agent kinds. A herdr team is herdr-only (no native messages, every member in a herdr pane) and also uses herdr for bounded delivery receipts, Owner-requested live status, Owner notifications and worktree-per-Worker provisioning.
- **Role registration:** `JOIN_REQUEST` / `JOIN_ACK` / `ACK_RECEIVED` establish verified peer identities and responsibilities.
- **One message budget for all agents:** every native message from Leader, Worker, or Reviewer follows a conservative **600 UTF-8 byte** operating budget. Actual transport limits may differ.
- **Project-independent:** task source, repository, worktree layout, and issue tracker are not prescribed.

## Installation

Requirements: Node.js and npm/npx, Codex and/or Claude Code, access to the repository.

Install globally for both clients:

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -g -y
```

Install in the current project:

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -y
```

Discover available skills:

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --list
```

After installation or updates, start a new session or reload role instructions. Optional project-specific rules may be kept in `AGENTS.md` or `CLAUDE.md`; the Skill does not require copying collaboration templates into every project.

### Upgrading running teams

Running sessions keep the skill text they loaded; updating files on disk does not change them.

1. Update the installed copy: rerun the install command above (with `-g` for global, without it in the project root for a project install). For a project install, commit the updated `.agents/skills/` / `.claude/skills/` files to the default branch.
2. Tell the Leader "skill upgraded" (plus the commit for a project install). The Leader reloads the skill and sends each active Worker `SKILL_REFRESH` (with `REF:<commit>` for a project install). Each Worker reloads, keeping its ID, task and Leader target, and replies `SKILL_REFRESH_ACK`. A Worker whose worktree predates `REF` reads the new skill with `git show` instead of merging.

Agents never run the install command on a peer's request.

## Quick start

### Start a Leader

In a dedicated Codex session:

```text
$agent-team-bootstrap leader
Project: my-project
Coordinate Worker ownership, tasks, dependencies and final receipts.
Publish the verified native session address. Do not perform Worker tasks.
```

In Claude Code, use `/agent-team-bootstrap leader`.

### Start a Worker

Open a separate session:

```text
$agent-team-bootstrap worker
Project: my-project
Worker ID: backend-01
Created by: human
Responsibilities: Implement order API and unit tests.
Leader target: <verified native Leader session address>
Register with JOIN_REQUEST; use native messages for receipts and authorized peer communication.
```

In Claude Code, use `/agent-team-bootstrap worker`.

After receiving `JOIN_ACK`, the Worker confirms registration. The Leader can also provision an independent Worker when the runtime exposes that capability and the Owner authorizes it.

### Peer collaboration and review

Registered Workers can contact authorized peers directly. For example:

```text
P:my-project T:PEER_REQUEST ID:fe3 Q:order status enum? ACK:1
```

A producing Worker sends `REVIEW_REQUEST` directly to its assigned Reviewer. The Reviewer returns feedback to that Worker, then sends a final `REVIEW_VERDICT` to the Leader; the producer sends `COMPLETE` independently.

### Leaving the team

A Worker hands off unfinished work, sends `LEAVE_REQUEST` with a handoff reference, and the Leader replies `LEAVE_ACK` and marks it `LEFT`. To retire a Worker, the Leader sends `RELEASE`; the Worker hands off and replies `LEAVE_ACK`. A `LEFT` Worker receives no further assignments and must `JOIN_REQUEST` again to return.

### Replacing the Leader or a lost Worker

One Leader per team at a time, but both roles can be replaced, e.g. when you switch devices or a machine goes offline:

- **Planned handover:** the old Leader sends `LEADER_HANDOFF` to the new one, then `LEADER_CHANGE` to every Worker and stands down. Workers rejoin the new Leader with their task, pushed branch and last receipt, so the new Leader rebuilds the roster from them.
- **Failover:** if the old Leader is offline, a new Leader started with `Takeover` sends `LEADER_CHANGE FO:1`. Workers accept it only if you wrote `Failover: allowed` when forming the team and their old Leader is unreachable; otherwise you confirm it in each Worker's session.
- **Fencing:** every Leader term has an epoch (`E:<UTC yyyymmddhhmm>`). A Leader that comes back after a failover gets `STALE_LEADER` and stands down.
- **Lost Worker:** when a machine is down the Leader marks its Workers `LOST`, reassigns their tasks from the last pushed refs on new branches, and updates affected peers. On multi-machine teams Workers push their branch at each milestone.
- **Switching your own device** needs nothing if the agents run on always-on hosts: attach to their herdr server from any device.

## Team dashboard (optional, human-run)

A cartoon, animated local page shows who is on the team, the native messages flying between sessions, and what each session is doing (running a tool, idle, blocked, in review, complete). Run it yourself from the installed skill directory (or this repo); no agent starts it or depends on it:

```bash
node skills/agent-team-bootstrap/scripts/team-dashboard.mjs --project my-project   # then open http://127.0.0.1:4317/
```

Add `?demo=1` to the URL for a scripted demo. Requires Node.js 20+. Options: `--port 4317`, `--since 24h`, `--claude-dir`, `--codex-dir`.

- **Read-only and local:** it only reads `~/.claude/projects` and `~/.codex/sessions` transcripts, binds to `127.0.0.1`, and rejects other `Host` headers. It is not a transport, inbox or listener.
- **Inferred, not authoritative:** envelopes are taken only from outgoing `SendMessage` / `send_message_to_thread` calls (plus the `<cross-session-message>` wrapper on Claude receivers). A session that closed looks the same as an idle one; 30 minutes without activity shows as STALE. Herdr-transport messages and other machines' sessions are not shown; after a Leader change both Leaders show a crown.
- **Checked against real transcripts:** Codex 0.163.0 rollouts use `threadId` / `prompt` for `send_message_to_thread`. Claude 2.1.296 receives wrappers in `queued_command` attachments and user messages with a fixed prefix. Sanitized fixtures and the exact coverage are in [scripts/fixtures/team-dashboard](skills/agent-team-bootstrap/scripts/fixtures/team-dashboard/README.md). The legacy Codex `event_msg.agent_message` branch has only a handwritten compatibility test; no local sample was found.
- **Limits:** only uncompressed `.jsonl` files are read. Explicit Codex completion/interruption clears pending tools; without an end event, an interrupted session can remain RUNNING until STALE. File tails are read in 64 KiB chunks (one incomplete line is retained); split session files share messages and use the latest execution snapshot.

## Message format and limits

Use short event messages with a project ID, event type, message ID, and an existing accessible artifact reference when needed. The **600-byte UTF-8 budget applies equally to all senders and directions**, including registration, assignments, P2P, reviews, and final reports. This is a Skill policy, not a universal hard limit of either client.

The Codex TUI implementation inspected for this Skill rejects native send prompts over **1,000 UTF-8 bytes**, which can produce `prompt exceeded the maximum context budget`. That specific error describes an outgoing message validation failure, not the model's context window.

Store extensive task descriptions, logs and diffs in accessible project artifacts; send only the reference through native messaging. Project files are not a substitute for native message delivery.

## Compatibility

| Environment | Native messaging |
|---|---|
| Claude Code | Uses callable `ListAgents` / `SendMessage` where available |
| Codex Desktop | Uses callable thread discovery and `send_message_to_thread` where available |
| Codex CLI | Depends on the tools exposed in the active session |
| Codex ↔ Claude Code | No direct native cross-provider messaging |
| Any agent kind in herdr | `herdr agent prompt` (Owner opt-in, whole team) |

**Herdr trade-off:** a herdr message is typed into the receiver's input box, so it arrives as a user turn without native sender identity, and Claude's `crossSessionInbound` gate does not apply. Members treat envelopes with `FROM:` as peer messages at peer trust; anything on the same herdr server can prompt any agent. Behaviour when the receiver is mid-turn varies by agent kind, so test `PING` / `PONG` for each pair of kinds. See [transports.md](skills/agent-team-bootstrap/references/transports.md#herdr-opt-in-any-agent-kind).

Sending a message does not guarantee receipt, acceptance, or automatic wake-up. Verify `PING` / `PONG` and registration before relying on a team. If native send is unavailable, the Skill reports the limitation instead of starting a custom relay or listener.

## Documentation

- [Skill instructions](skills/agent-team-bootstrap/SKILL.md)
- [Quick start and troubleshooting](skills/agent-team-bootstrap/references/quickstart.md)
- [Messaging protocol](skills/agent-team-bootstrap/references/protocol.md)
- [Transport support](skills/agent-team-bootstrap/references/transports.md)
- [Optional project templates](templates/)

## License

MIT.
