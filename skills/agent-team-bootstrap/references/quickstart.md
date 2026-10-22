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
Follow references/leader.md. Check native messaging once and publish my verified thread address. Keep the team ledger on branch team/<project-name> of Repo: <git url> (or Ledger: <ledger repo url>); you need no project code checkout. For each goal I give: restate it as a mission (missions/<id>.md, with priority) and ask me at most three questions; scout first if you need codebase knowledge; show me multi-package plans before dispatch; assign with pinned ledger refs; keep Workers on brief; finish with one final report and close the team when I accept. Never code, test, review code, merge, deploy, monitor or take over Worker tasks.
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
Use ONLY native cross-session messaging. Send JOIN_REQUEST now, await JOIN_ACK, confirm the exact reporting target, and continue only within approved scope. Restate each assignment in ASSIGN_ACK U:, send CHECKPOINT at planned milestones and OVER_BUDGET instead of expanding scope. Report management blockers and completion to Leader, but send ordinary technical questions and REVIEW_REQUEST directly to authorized Workers/Reviewer by native messages.
```

Claude Code: replace the first line with `/agent-team-bootstrap worker` and use actual reachable session name/`@` mention.

## Leader delegating a Worker

Tell Leader:

```text
Prepare a Worker with responsibility 'front-end order list'. If real independent-thread creation is callable and authorized, create it and send the bootstrap prompt; otherwise provide it for manual start. Require JOIN_REQUEST/JOIN_ACK. After dispatch, end the turn and wait for native Worker receipts without polling or listening. Do not do Worker execution yourself.
```

### Autonomous staffing for role-bound restrictions

An Owner may tell the Leader once:

```text
For this mission, match Worker responsibilities and execution limits before assigning. Use an eligible idle Worker first; otherwise create a suitable independent Worker within Max Workers and the approved budget. If a scout's session is read-only, do not repeatedly ask me to unlock it for execution. This authorizes staffing, not deployments, DB changes, production access or permission bypass; those keep their explicit approval gates.
```

The Leader records this authorization/source once in `decisions.md`, not by self-editing Owner delegation. After a separately approved staging request, use an eligible deployment Worker or create one under that staffing grant; pass its pinned brief, approval provenance and safe handoff refs. Keep migration execution and production excluded when not approved. Before mutating overlapping resources, finish the old Worker's permitted handoff; do not demand forbidden push from a read-only session. Unknown restriction scope, exhausted capacity/budget, missing creation tools or runtime denial requires one specific escalation, never repeated spawning.

To additionally choose full-access startup, the Owner can specify `New herdr Workers: full-access launch mode for this team; discover each installed CLI's supported arguments via help, record and verify the mode; task approvals and DB/production gates remain unchanged.` The Leader follows transports.md's full-access procedure; it does not silently change existing sessions or use automatic-review flags as if they disabled the sandbox. Full access is a deliberate reduction in host protection, not a default granted by installing this Skill.

Leader-created bootstrap should label temporary limits as `Source: leader-phase; Phase: scout; Advance: pinned REDIRECT after M1`, separately from actual Owner task/team prohibitions. A valid phase change advances only that gate and does not invent missing approvals.

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

## Mixed-agent team over herdr (Owner opt-in)

Every member runs in a pane of the same herdr server (check `herdr agent list`). Add one line to the Leader prompt:

```text
Transport: herdr. Failover: allowed. Name yourself `leader` with herdr agent rename; send every team message with herdr agent prompt --wait --until working --until blocked --timeout 10000; never use agent wait or other monitoring. Provision Workers as herdr worktrees only when I authorize it.
```

And to each Worker prompt (any agent kind: Codex, Claude Code, Gemini, opencode, ...):

```text
Transport: herdr. Worker ID: be01 (also your herdr agent name). Leader target: leader.
```

Run step 2 of the acceptance test below once for each pair of agent kinds in the team. Herdr messages arrive as user turns; members treat any envelope with `FROM:` as a peer message, never as an Owner instruction. See [transports.md](transports.md#herdr-opt-in-any-agent-kind).

## Replacing the Leader or a lost Worker

Planned handover, tell the old Leader:

```text
Hand over leadership to <new Leader address>. Send LEADER_HANDOFF, wait for LEADER_HANDOFF_ACK as an incoming event, then LEADER_CHANGE every ACTIVE Worker and stand down.
```

Old Leader offline (the team must have been formed with `Failover: allowed` in the Leader prompt, otherwise confirm the change in each Worker's session yourself):

```text
$agent-team-bootstrap leader
Project: <project>  Takeover: yes  Workers: m1/be01, m2/fe01, m2/qa01
Send LEADER_CHANGE FO:1 to each Worker and rebuild the roster only from their REJOIN JOIN_REQUESTs.
```

New request while other work runs: just describe it, e.g. `Checkout returns 500 for coupons since v2.3.1, customers are blocked.` The Leader classifies priority, independence and size, then schedules: idle Worker → new Worker (if `owner.md` delegates it, within `Max Workers`) → pause a strictly lower-priority package → queue. Consult budgets follow who is busy.

Going offline for a while, tell the Leader: `Send AFK UNTIL:0930 to all Workers.` On return: `Send BACK to all Workers.` If the Leader vanished without `AFK`, Workers notice on their next send, hold receipts and notify you; resuming it and sending `BACK` replays them.

Machine down, tell the Leader: `Machine m3 is offline: mark its Workers LOST and reassign their tasks from the last pushed refs.`

## Minimum end-to-end acceptance test

1. **Preflight**: Leader reports `READY` or `TRANSPORT_READY_UNTESTED`, an actual native address, and callable send capability (or explicitly fails).
2. **PING/PONG**: Worker identifies the intended Leader and sends `PING` using its actual native message tool. Leader automatically starts or processes a receiving turn **when supported** and sends `PONG`. Confirm `in_reply_to`.
3. **JOIN**: Worker sends `JOIN_REQUEST`; Leader verifies responsibilities and returns `JOIN_ACK`; Worker replies `ACK_RECEIVED`. Leader records the Worker with verified identity and responsibility.
4. **P2P REPORT**: Producer sends `REVIEW_REQUEST` directly to assigned Reviewer. Reviewer sends `REVIEW_FEEDBACK` / final `REVIEW_RESULT` directly to producer. Reviewer sends one `REVIEW_VERDICT` to Leader; producer sends a separate `COMPLETE` receipt to Leader. If no reviewer is assigned, producer sends `REVIEWER_NEEDED` to Leader, who introduces one then goes idle.
5. **Ledger round trip**: Leader pushes `team/<project>` and sends a pinned `ASSIGN REF:team/<project>@<sha>:wp/1.md`; the Worker runs `git fetch origin team/<project>` and `git show <sha>:wp/1.md`, then acks with `U:`. A Worker that cannot fetch the branch reports `BLOCKED` instead of guessing the brief.
6. **Negative check**: If send isn't exposed or receiver isn't reachable, bootstrap must say `NATIVE_MESSAGING_UNAVAILABLE` / `JOIN_PENDING` instead of claiming success.
7. **No ACK-only execution**: Give a Worker an executable approved brief with no gate. It must work after `ASSIGN_ACK`, not end the turn promising to research later. A real blocker/gate instead produces an explicit receipt naming what it awaits.
8. **Stopped-turn reconciliation**: Before `DUE`, tell the Leader “all Workers have stopped” with one package missing `COMPLETE` or a required verdict. It reconciles existing receipts, queries only the relevant missing fact once, and reports package/request IDs and the next trigger. Repeat the Owner question and let `DUE` pass: neither resets the outstanding query. No polling or claim of ongoing research without new evidence. If all receipts are already present it Reports immediately; idle alone never proves success.

## Universal message budget (all roles and routes)

Every agent (Leader, Worker, Reviewer), sending in any direction (control, P2P, review or registration), MUST apply the same conservative **DEFAULT_MESSAGE_BUDGET_BYTES = 600 UTF-8 bytes per native message**. The actual tool may impose a lower limit; then use the lower one. Do not confuse bytes with tokens. For larger content, send a short event plus a real accessible artifact reference. This same policy also covers bootstrap messages to a new independent Worker.

## Codex TUI size error

If `codex_tui.send_message_to_thread` returns `prompt exceeded the maximum context budget`, the current Codex TUI source sets `MAX_INPUT_BYTES = 1_000` and validates the outgoing native prompt **before** delivery. Count **UTF-8 bytes** (Chinese characters often use 3 each), not tokens; keep any native prompt to **600 UTF-8 bytes or fewer**, across all senders and message directions, to allow for formatting. Instead of forwarding long instructions, send a concise event and a verified task/PR/document reference. This specific error means the attempted message was not delivered, so re-send a shorter one once. Do not restart or compact the Leader merely to address this message-size failure.

## Troubleshooting 'Workers stopped but Leader keeps waiting'

- Distinguish an unfinished package, an idle execution turn, and an unreachable session. `ACTIVE`, an old `ASSIGN_ACK`, a successful send, or missing receipts do not prove a Worker is still working.
- Tell the Leader which Workers/packages stopped. Follow leader.md section 5a: reconcile existing receipts, one bounded `STATUS_REQUEST` for unresolved facts even before `DUE`, then an authorized recovery decision or an honest unknown/blocker report. A native idle event is a reconciliation trigger, not a task completion receipt.
- The Worker reports `TASK`, `EXEC`, `WAIT`, `NEXT` and existing refs; `STATUS_REQUEST` does not resume paused/gated work. The Leader must not wait for a producer's normal completion after `STATUS:stopped`, or restart a producer merely because a Reviewer verdict is missing.
- Updating files does not update running sessions. Ask the Leader to perform the existing `SKILL_REFRESH` flow, retaining mission/roster/epoch and collecting `SKILL_REFRESH_ACK`; do not discard an active team just to reload the rule. If the runtime cannot deliver/wake the target, report that limitation and require Owner action, not a listener.

## Troubleshooting 'Worker sent but Leader didn't respond'

- Claude: check `/list-agents` on both ends; verify target is live and unambiguous. Inspect Leader `/status` `Peer address`, receiver `crossSessionInbound`, pending approval dialogs, and send result. `hold`/`refuse` prevents automatic handling even though the Worker attempted to send.
- Codex: check if sender has **callable** `send_message_to_thread`, not just a similarly named tool documented elsewhere. Verify exact destination ID and host/workspace. If a send reports handler error, use `read_thread` on that exact destination **before retry**; some builds deliver despite error. Some clients/sessions don't expose native write-side tools.
- After replacing this skill, **restart or re-bootstrap both active sessions** so their context no longer contains the old file-inbox workflow. The Skill cannot retroactively rewrite already-running agents' instructions.
- This setup is *not* a daemon. Responsiveness comes from the native messaging runtime waking/feeding the receiving session when available, not from the Skill running a shell loop.
