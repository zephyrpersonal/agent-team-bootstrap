# Agent Team Bootstrap

[简体中文](README.zh-CN.md)

**Agent Team Bootstrap** is a reusable multi-session collaboration Skill for Codex and Claude Code. It coordinates independent Leader, Worker, and Reviewer sessions through available **native cross-session messaging**.

## Features

- **Coordination-only Leader:** assigns ownership, coordinates dependencies, handles exceptions, and summarizes confirmed outcomes. Does not code, test, review code, merge, deploy, or poll for updates.
- **Worker Mesh:** registered Workers communicate directly for implementation questions, API contracts, integration and bug fixes, without routing routine messages through the Leader.
- **Peer code review:** Reviewer and producing Worker exchange feedback directly. Only final review verdict and completion receipts reach the Leader.
- **Native session transport:** uses actual supported Codex or Claude Code peer messaging tools; no custom mailbox, daemon, listener, or timer.
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

Sending a message does not guarantee receipt, acceptance, or automatic wake-up. Verify `PING` / `PONG` and registration before relying on a team. If native send is unavailable, the Skill reports the limitation instead of starting a custom relay or listener.

## Documentation

- [Skill instructions](skills/agent-team-bootstrap/SKILL.md)
- [Quick start and troubleshooting](skills/agent-team-bootstrap/references/quickstart.md)
- [Messaging protocol](skills/agent-team-bootstrap/references/protocol.md)
- [Transport support](skills/agent-team-bootstrap/references/transports.md)
- [Optional project templates](templates/)

## License

MIT.
