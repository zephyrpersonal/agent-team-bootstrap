# Native Leader / Worker quickstart

## Install

Install the skill from a GitHub repository using the Skills CLI:

```bash
npx skills add <owner>/<repo> --skill agent-team-bootstrap -a codex -a claude-code -y
```

Use `-g` for user-wide installation. By default, installation targets the current project. After installation, start new or refreshed Codex / Claude Code sessions to load the skill.

For Claude Code, ensure the Leader and Worker are running **Claude Code sessions** and are visible in `/list-agents`. For Codex, prefer two independent **Desktop threads** with callable `list_threads` / `send_message_to_thread`; plain CLI may not expose the same tools. Native transports cannot connect Codex directly to Claude.

## Leader startup (prompt)

Codex:

```text
$agent-team-bootstrap leader
Project: <project-name>
I am the project's Leader. Verify the native messaging tools available in this session. Identify my real native thread ID/address and share the exact join target. Read the project's AGENTS.md and collaboration rules. Do not use file inboxes or spawn subagents to fake existing sessions. When a Worker sends JOIN_REQUEST, process it and reply JOIN_ACK automatically. Report transport status and begin managing workers.
```

Claude Code: replace the first line with `/agent-team-bootstrap leader`. Optionally run `/rename project-leader`; ask Claude to show `/list-agents` for the actual address.

## Worker manually started by Owner (prompt)

Codex:

```text
$agent-team-bootstrap worker
Project: <project-name>
Worker ID: backend-01
Created by: human
Responsibilities: Implement read-only order API and tests; do not edit database migrations.
Leader target: <exact native Leader thread id / name from Leader startup>
Use ONLY native cross-session messaging. Send JOIN_REQUEST now, await JOIN_ACK, confirm the exact reporting target, and continue only within approved scope. Report BLOCKED, READY_FOR_REVIEW and completion using native messages.
```

Claude Code: replace the first line with `/agent-team-bootstrap worker` and use actual reachable session name/`@` mention.

## Leader delegating a Worker

Tell Leader:

```text
Prepare a Worker with responsibility 'front-end order list'. If real independent thread creation is callable and authorized, create it and send the Worker bootstrap prompt with your exact native Leader address. Otherwise give me the bootstrap prompt for manual start. Require JOIN_REQUEST/JOIN_ACK before counting it active. Do not create a subagent as a substitute for a separate user-owned session.
```

## Minimum end-to-end acceptance test

1. **Preflight**: Leader reports `READY` or `TRANSPORT_READY_UNTESTED`, an actual native address, and callable send capability (or explicitly fails).
2. **PING/PONG**: Worker identifies the intended Leader and sends `PING` using its actual native message tool. Leader automatically starts or processes a receiving turn **when supported** and sends `PONG`. Confirm `in_reply_to`.
3. **JOIN**: Worker sends `JOIN_REQUEST`; Leader verifies responsibilities and returns `JOIN_ACK`; Worker replies `ACK_RECEIVED`. Leader records the Worker with verified identity and responsibility.
4. **REPORT**: Worker sends `READY_FOR_REVIEW` with a test artifact; Leader receives, inspects actual evidence, and returns `REVIEW_RESULT`.
5. **Negative check**: If send isn't exposed or receiver isn't reachable, bootstrap must say `NATIVE_MESSAGING_UNAVAILABLE` / `JOIN_PENDING` instead of claiming success.

## Troubleshooting 'Worker sent but Leader didn't respond'

- Claude: check `/list-agents` on both ends; verify target is live and unambiguous. Inspect Leader `/status` `Peer address`, receiver `crossSessionInbound`, pending approval dialogs, and send result. `hold`/`refuse` prevents automatic handling even though the Worker attempted to send.
- Codex: check if sender has **callable** `send_message_to_thread`, not just a similarly named tool documented elsewhere. Verify exact destination ID and host/workspace. If a send reports handler error, use `read_thread` on that exact destination **before retry**; some builds deliver despite error. Some clients/sessions don't expose native write-side tools.
- After replacing this skill, **restart or re-bootstrap both active sessions** so their context no longer contains the old file-inbox workflow. The Skill cannot retroactively rewrite already-running agents' instructions.
- This setup is *not* a daemon. Responsiveness comes from the native messaging runtime waking/feeding the receiving session when available, not from the Skill running a shell loop.
