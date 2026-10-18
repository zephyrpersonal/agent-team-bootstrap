# Plain-text collaboration envelope

Native `SendMessage` and `send_message_to_thread` carry text. The following **logical** schema is a compact convention embedded in the message body; it does not create a new transport or database.

Use clear field labels and a short body; YAML-style plain text is fine. Do not require a YAML parser. `message_id` must be unique within the active collaboration; an ID can be a session-local counter plus session ID or tool-generated UUID. The receiver should use the native sender identity where available rather than trusting a claimed `from` field. Herdr delivers no sender identity, so on a herdr team `FROM:<herdr agent name>` is **mandatory** in every message: it is the reply address, checked against the roster and trusted only as a peer claim.

```yaml
protocol: agent-team/native
project: example-project
message_id: backend-01-003
in_reply_to: null
type: JOIN_REQUEST
from: backend-01
to: leader-main
created_by: human
native_sender: <runtime-provided-session-ref-if-available>
workspace: <path-and-branch>
responsibilities:
  - Implement the order API
status: joining
summary: Request to join this project's team.
requires_reply: true
```

## Routing: Control Plane vs Worker Mesh

- `Leader` = Control Plane only: register workers, own responsibilities and resource conflicts, authorize peer introductions, assign Reviewer, receive only decisive milestones/final receipts. Never act as a relay for routine questions, comments, API clarifications, or review revisions.
- `Workers` = Collaboration Plane: direct peer communication over the SAME native Codex or Claude cross-session transport. Only address an **authorized, verified native peer session**, not a guessed or stale thread. If missing, ask Leader once for `PEER_ROUTE_REQUEST`; Leader replies with the peer's verified address and scope, not relayed content. Do not list peers repeatedly or poll.
- P2P may cover technical Q&A, within-contract API decisions, integration, bug feedback and the whole review/fix loop. P2P may **not** reassign tasks, change ownership/access, mutate shared migrations/contracts outside approved scope, approve deployment or bypass Owner decisions.
- Escalate `BLOCKED`, `SCOPE_CHANGE_REQUEST`, or `COORDINATION_UPDATE` to Leader only when needed for ownership, shared resource, cross-task blocker or high-impact contract change; no routine CC to Leader.
- Code review: producer → Reviewer `REVIEW_REQUEST`; Reviewer → producer `REVIEW_FEEDBACK` and final `REVIEW_RESULT`. After final review only, Reviewer → Leader `REVIEW_VERDICT` with artifact reference; producer → Leader `COMPLETE`. Leader records both independently and reports outcome. If no Reviewer was assigned, producer → Leader `REVIEWER_NEEDED` once, Leader introduces Reviewer, then goes idle.
- Prefer **one final notification per decisive event** and avoid redundant relay loops. All agents and routes (Leader, Worker, Reviewer, P2P and management) use the same global 600 UTF-8 byte message budget.

Compact examples (native `prompt` text, NOT a persistent mailbox):

```text
P:wms T:PEER_REQUEST ID:fe12 TO:backend01 Q:order status enums? REF:docs/api/orders.md ACK:1
P:wms T:PEER_REPLY ID:be12 RE:fe12 A:pending,paid,cancelled
P:wms T:REVIEW_REQUEST ID:fe19 TO:qa01 REF:PR#42 WP:team/wms@3f9c2e1:wp/17.md ACK:1
P:wms T:REVIEW_FEEDBACK ID:qa20 RE:fe19 REF:PR#42#comment-3
P:wms T:REVIEW_RESULT ID:qa21 RE:fe19 STATUS:approved REF:PR#42
P:wms T:REVIEW_VERDICT ID:qa22 TO:leader STATUS:approved REF:PR#42
P:wms T:COMPLETE ID:fe23 TO:leader REF:PR#42
P:wms T:SKILL_REFRESH ID:sr1 TO:fe01 REF:a1b2c3d re-invoke agent-team-bootstrap worker, keep ID/task/Leader target
P:wms T:SKILL_REFRESH_ACK ID:fe30 RE:sr1
P:wms T:LEAVE_REQUEST ID:fe31 TO:leader REF:branch fe/orders-ui@a1b2c3
P:wms T:LEAVE_ACK ID:l40 RE:fe31
P:wms T:ASSIGN ID:l17 TO:fe01 E:202610181200 REF:team/wms@3f9c2e1:wp/17.md PEERS:be01 ACK:1
P:wms T:ASSIGN_ACK ID:fe18 RE:l17 U:orders list page with status filter, API from WP-12 unchanged
P:wms T:CHECKPOINT ID:fe20 RE:l17 M:1 STATE:on-track REF:fe/orders@a1b2
P:wms T:OVER_BUDGET ID:fe21 RE:l17 WHY:review round 4 of 3, pagination contract unclear REF:PR#42
P:wms T:REDIRECT ID:l22 TO:fe01 E:202610181200 REF:team/wms@7d0e4b2:wp/17.md
P:wms T:PEER_REQUEST ID:fx3 FROM:fx01 TO:be01 MODE:consult PRI:P0 Q:1) why retry=3 in pay client? 2) idempotency key source?
P:wms T:PAUSE ID:l30 TO:be02 E:202610181200 WHY:P0 WP-30
P:wms T:RESUME ID:l35 TO:be02 E:202610181200 REF:team/wms@7d0e4b2:wp/21.md
P:wms T:LEADER_HANDOFF ID:l50 TO:leader2 E:202610181530 N:3
P:wms T:LEADER_HANDOFF_ACK ID:m1 RE:l50
P:wms T:LEADER_CHANGE ID:l51 TO:fe01 NEW:m2/leader2 E:202610181530
P:wms T:JOIN_REQUEST ID:fe40 TO:leader2 REJOIN:1 E:202610181530 TASK:docs/tasks/17.md STATE:working REF:fe/orders@c3d4 LAST:fe23
P:wms T:PEER_UPDATE ID:m9 TO:fe01 E:202610181530 OLD:be01 NEW:be02
P:wms T:STALE_LEADER ID:fe41 RE:l52 E:202610181530 LEADER:m2/leader2
P:wms T:AFK ID:l60 FROM:leader E:202610181530 UNTIL:0930
P:wms T:BACK ID:l61 FROM:leader E:202610181530
P:wms T:BACK_ACK ID:fe50 RE:l61 FROM:fe01 STATE:review REF:fe/orders@e5f6 LAST:fe23
```

On a herdr team the same events go through `herdr agent prompt <name> '<text>'` and always carry `FROM`:

```text
P:wms T:PING ID:fe1 FROM:fe01 TO:leader ACK:1
P:wms T:JOIN_ACK ID:l2 RE:b1 FROM:leader E:202610181200 FO:1 TX:herdr OK:1
P:wms T:PEER_REQUEST ID:fe12 FROM:fe01 TO:be01 Q:order status enums? ACK:1
```

## Events and mandatory response

| Event | Sender → receiver | Expected response |
|---|---|---|
| `PING` | Either → known target | `PONG`, matching `in_reply_to` |
| `JOIN_REQUEST` | Worker → Leader | `JOIN_ACK` accepting, adjusting or rejecting scope |
| `JOIN_ACK` | Leader → Worker | `ACK_RECEIVED` (only if accepted and verified) |
| `ASSIGN` | Leader → registered Worker, `REF:team/<p>@<sha>:wp/<id>.md` | `ASSIGN_ACK U:<one-line restatement>` or `BLOCKED` with a question |
| `CHECKPOINT` | Worker → Leader at a planned milestone, or answering `STATUS_REQUEST` | None if on track; `CONTINUE` at a gate; `REDIRECT` / `STOP` if drifting |
| `OVER_BUDGET` | Worker → Leader past `DUE` / `ROUNDS` or scope estimate | `CONTINUE` with a new budget, `REDIRECT` or `STOP` |
| `CONTINUE` | Leader → Worker | None |
| `REDIRECT` | Leader → Worker, new pinned brief ref | `ASSIGN_ACK` with a new `U:` |
| `STOP` | Leader → Worker | Worker pushes, hands off, `COMPLETE STATUS:stopped` |
| `STATUS_REQUEST` | Leader → Worker, once per overdue package per due date | `CHECKPOINT` |
| `PAUSE` | Leader → feature Worker, to free it for a P0 package | Push, `CHECKPOINT`, `PAUSE_ACK` |
| `RESUME` | Leader → paused Worker, pinned original brief | `ASSIGN_ACK` with `U:` |
| `PEER_REQUEST MODE:consult` | Worker outside your package → you | Busy: one short `PEER_REPLY` from memory or `A:needs-investigation`; idle: may investigate read-only first |
| `PROGRESS` | Worker → Leader | Reply only if action/decision needed |
| `BLOCKED` | Worker → Leader | Decision or resolution plan; escalate to Owner if required |
| `CONTRACT_CHANGE` | Worker → Leader | Scope/impact decision or dependent-Worker notification |
| `SCOPE_CHANGE_REQUEST` | Worker → Leader | Explicit confirmed scope or Owner escalation |
| `READY_FOR_REVIEW` | Producer → assigned Reviewer | Prefer direct `REVIEW_REQUEST`; use `REVIEWER_NEEDED` → Leader only if no Reviewer exists |
| `REVIEW_REQUEST` | Producer → Reviewer Worker | Reviewer checks artifacts and replies directly to producer |
| `REVIEW_RESULT` | Reviewer → Producer | Direct final technical review result; Leader does not relay it |
| `REVIEW_VERDICT` | Reviewer → Leader | One final independent sign-off receipt |
| `COMPLETE` | Producer → Leader | Independent completion receipt; Leader checks existence of verdict receipt, not implementation |
| `PEER_REQUEST` / `PEER_REPLY` | Worker ↔ Worker | Direct authorized technical exchange; Leader not copied |
| `PEER_ROUTE_REQUEST` / `REVIEWER_NEEDED` | Worker → Leader | Introduce verified contact or assign reviewer only; no content relaying |
| `SKILL_REFRESH` | Leader → active Worker | Worker reloads installed skill (or reads it at `REF` via `git show` if its worktree lacks that commit), keeps identity/task, replies `SKILL_REFRESH_ACK`; no install, no re-join |
| `LEAVE_REQUEST` | Worker → Leader | `LEAVE_ACK`; Leader marks Worker `LEFT`, reassigns unfinished work from the handoff `REF` |
| `RELEASE` | Leader → Worker | Worker hands off unfinished work, replies `LEAVE_ACK`, then stops team messaging |
| `LEADER_HANDOFF` | Old Leader → new Leader | `LEADER_HANDOFF_ACK`; old Leader then sends `LEADER_CHANGE` to each ACTIVE Worker and stands down |
| `LEADER_CHANGE` | Current Leader, or new Leader on failover (`FO:1`) → Worker | Worker checks it, then `JOIN_REQUEST REJOIN:1` to the new Leader; else `LEADER_CHANGE_PENDING` to its own Owner |
| `PEER_UPDATE` | Leader → Worker | None; Worker replaces or drops that peer contact |
| `AFK` | Leader → ACTIVE Workers; Worker → Leader and open peers | None; receivers hold messages to the sender (Workers hold management receipts while the Leader is AFK) |
| `BACK` | Returning member → those it told `AFK` (Leader: all ACTIVE Workers) | From the Leader: `BACK_ACK` with state, then held receipts; from a peer: held requests |
| `BACK_ACK` | Worker → returned Leader | None |
| `STALE_LEADER` | Worker → Leader with a lower epoch | None; that Leader stands down and tells its Owner |
| `ACK_RECEIVED` / `PONG` | Receiver → sender | No automatic recursive ACK |

## JOIN_ACK example

```yaml
protocol: agent-team/native
project: example-project
message_id: leader-main-007
in_reply_to: backend-01-003
type: JOIN_ACK
from: leader-main
to: backend-01
accepted: true
reports_to: leader-main
confirmed_responsibilities:
  - Implement the order API and unit tests
restricted_resources:
  - migrations
next_action: Start task TASK-11 and report on blocking changes.
requires_reply: true
```

## READY_FOR_REVIEW example

```yaml
protocol: agent-team/native
project: example-project
message_id: backend-01-008
in_reply_to: null
type: READY_FOR_REVIEW
from: backend-01
to: leader-main
task: TASK-11
summary: Order API complete; 12 unit tests passed.
artifacts:
  - commit:abc123
  - tests:12-passed
risks:
  - Integration environment not tested
requires_reply: true
```

## Universal native message budget (all senders)

Codex source currently limits `codex_tui.send_message_to_thread` prompts to **1,000 UTF-8 bytes** and the XML-delegated form to 1,256 bytes. These are bytes, not characters or model tokens. Set **DEFAULT_MESSAGE_BUDGET_BYTES = 600** for **every** native message and each agent role (Leader, Worker, Reviewer), including peer and management traffic. This is a common operational safety cap, not a claim that other platforms share Codex's hard limit. If a callable transport exposes a stricter limit, follow that instead. Keep the common event fields only when useful; shortened plaintext is preferred:

```text
P:wms T:JOIN_REQUEST ID:b1 FROM:backend-01 ROLE:api LEADER:l1 ACK:1
P:wms T:ASSIGN ID:l4 REF:docs/tasks/42.md ACK:1
P:wms T:READY_FOR_REVIEW ID:b6 REF:PR#42 ACK:1
```

The real target thread ID is supplied to the native tool, not repeated as a long address in the prompt. Detailed task briefs, diffs, logs and evidence belong in an already accessible artifact; send the reference, **not** the artifact contents. A referenced artifact must actually exist and be accessible. No file is used as a message inbox, no Leader code writing, and no polling.

Every sender must count UTF-8 bytes of the native prompt before sending when possible; otherwise err on shorter messages. This exact Codex TUI error, `prompt exceeded the maximum context budget`, is a **pre-send validation rejection**. Shorten before retrying; don't mistake it for a full model context window or an ambiguous delivery failure. Source: https://github.com/openai/codex/blob/main/codex-rs/tui/src/dynamic_tools.rs

## Leader behaviour

The Leader's rules, decision rights and event table are in [leader.md](leader.md); the ledger it writes is described in [ledger.md](ledger.md).

## Handling ambiguous outcomes

- Distinguish `tool_failed`, `transport_sent`, `receiver_acknowledged`, `review_accepted`, `merged`.
- If native send returns success but no reply, status is `SENT_UNACKNOWLEDGED`.
- Never mark a Worker active simply because a `JOIN_REQUEST` was sent.
- A resend keeps its original `ID`; a receiver handles each `ID` once and ignores repeats, so a retry after an ambiguous failure cannot double-apply an event.
- If a Codex send returns an error that may still have delivered, **inspect the exact target** before resending the same `message_id`.
- Durable task state can be saved in repository docs/issues/explicit stores, but **never treat such storage as a message relay** under this Skill.
