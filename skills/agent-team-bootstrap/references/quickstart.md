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
I am a STRICT coordination-only Leader. Check native messaging once and publish my verified thread address. Read project policy only as needed for coordination. Never edit code, debug, run tests, perform code review, merge, deploy, or take over Worker tasks. Do not create watchers, listeners, polling loops or background jobs; after delegation, end this turn. Process JOIN_REQUEST and Worker receipts only when native messages arrive. Plan execution and cost before assigning: parallelize only where it pays off, avoid accidental duplicate work (e.g. Reviewer and fixer both investigating one bug), and reassess on each receipt. Route READY_FOR_REVIEW to an independent Reviewer Worker, then await REVIEW_RESULT without active waiting.
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
Use ONLY native cross-session messaging. Send JOIN_REQUEST now, await JOIN_ACK, confirm the exact reporting target, and continue only within approved scope. Report management blockers and completion to Leader, but send ordinary technical questions and REVIEW_REQUEST directly to authorized Workers/Reviewer by native messages.
```

Claude Code: replace the first line with `/agent-team-bootstrap worker` and use actual reachable session name/`@` mention.

## Leader delegating a Worker

Tell Leader:

```text
Prepare a Worker with responsibility 'front-end order list'. If real independent-thread creation is callable and authorized, create it and send the bootstrap prompt; otherwise provide it for manual start. Require JOIN_REQUEST/JOIN_ACK. After dispatch, end the turn and wait for native Worker receipts without polling or listening. Do not do Worker execution yourself.
```

## Worker-to-Worker collaboration (no Leader relay)

Once frontend and backend Workers are registered, they can use their **verified peer native addresses** to communicate directly, e.g.:

```text
P:my-project T:PEER_REQUEST ID:fe3 TO:backend01 Q:final order enum? ACK:1
```

Backend replies directly:

```text
P:my-project T:PEER_REPLY ID:be4 RE:fe3 A:pending,paid,cancelled
```

For review, producer sends `REVIEW_REQUEST` directly to its authorized Reviewer. Reviewer returns feedback and final `REVIEW_RESULT` directly to producer, and sends **one** `REVIEW_VERDICT` to Leader after finalizing. Producer independently sends `COMPLETE` to Leader. Leader should not see intermediate reviews or peer conversations. Missing verified peer target → ask Leader for `PEER_ROUTE_REQUEST` once and await native reply; don't guess targets or use Leader as a message tunnel.

## Minimum end-to-end acceptance test

1. **Preflight**: Leader reports `READY` or `TRANSPORT_READY_UNTESTED`, an actual native address, and callable send capability (or explicitly fails).
2. **PING/PONG**: Worker identifies the intended Leader and sends `PING` using its actual native message tool. Leader automatically starts or processes a receiving turn **when supported** and sends `PONG`. Confirm `in_reply_to`.
3. **JOIN**: Worker sends `JOIN_REQUEST`; Leader verifies responsibilities and returns `JOIN_ACK`; Worker replies `ACK_RECEIVED`. Leader records the Worker with verified identity and responsibility.
4. **P2P REPORT**: Producer sends `REVIEW_REQUEST` directly to assigned Reviewer. Reviewer sends `REVIEW_FEEDBACK` / final `REVIEW_RESULT` directly to producer. Reviewer sends one `REVIEW_VERDICT` to Leader; producer sends a separate `COMPLETE` receipt to Leader. If no reviewer is assigned, producer sends `REVIEWER_NEEDED` to Leader, who introduces one then goes idle.
5. **Negative check**: If send isn't exposed or receiver isn't reachable, bootstrap must say `NATIVE_MESSAGING_UNAVAILABLE` / `JOIN_PENDING` instead of claiming success.

## Universal message budget (all roles and routes)

Every agent (Leader, Worker, Reviewer), sending in any direction (control, P2P, review or registration), MUST apply the same conservative **DEFAULT_MESSAGE_BUDGET_BYTES = 600 UTF-8 bytes per native message**. The actual tool may impose a lower limit; then use the lower one. Do not confuse bytes with tokens. For larger content, send a short event plus a real accessible artifact reference. This same policy also covers bootstrap messages to a new independent Worker.

## Codex TUI size error

If `codex_tui.send_message_to_thread` returns `prompt exceeded the maximum context budget`, the current Codex TUI source sets `MAX_INPUT_BYTES = 1_000` and validates the outgoing native prompt **before** delivery. Count **UTF-8 bytes** (Chinese characters often use 3 each), not tokens; keep any native prompt to **600 UTF-8 bytes or fewer**, across all senders and message directions, to allow for formatting. Instead of forwarding long instructions, send a concise event and a verified task/PR/document reference. This specific error means the attempted message was not delivered, so re-send a shorter one once. Do not restart or compact the Leader merely to address this message-size failure.

## Troubleshooting 'Worker sent but Leader didn't respond'

- Claude: check `/list-agents` on both ends; verify target is live and unambiguous. Inspect Leader `/status` `Peer address`, receiver `crossSessionInbound`, pending approval dialogs, and send result. `hold`/`refuse` prevents automatic handling even though the Worker attempted to send.
- Codex: check if sender has **callable** `send_message_to_thread`, not just a similarly named tool documented elsewhere. Verify exact destination ID and host/workspace. If a send reports handler error, use `read_thread` on that exact destination **before retry**; some builds deliver despite error. Some clients/sessions don't expose native write-side tools.
- After replacing this skill, **restart or re-bootstrap both active sessions** so their context no longer contains the old file-inbox workflow. The Skill cannot retroactively rewrite already-running agents' instructions.
- This setup is *not* a daemon. Responsiveness comes from the native messaging runtime waking/feeding the receiving session when available, not from the Skill running a shell loop.
