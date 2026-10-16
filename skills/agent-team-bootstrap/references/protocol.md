# Plain-text collaboration envelope

Native `SendMessage` and `send_message_to_thread` carry text. The following **logical** schema is a compact convention embedded in the message body; it does not create a new transport or database.

Use clear field labels and a short body; YAML-style plain text is fine. Do not require a YAML parser. `message_id` must be unique within the active collaboration; an ID can be a session-local counter plus session ID or tool-generated UUID. The receiver should use the native sender identity where available rather than trusting a claimed `from` field.

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
P:wms T:REVIEW_REQUEST ID:fe19 TO:qa01 REF:PR#42 ACK:1
P:wms T:REVIEW_FEEDBACK ID:qa20 RE:fe19 REF:PR#42#comment-3
P:wms T:REVIEW_RESULT ID:qa21 RE:fe19 STATUS:approved REF:PR#42
P:wms T:REVIEW_VERDICT ID:qa22 TO:leader STATUS:approved REF:PR#42
P:wms T:COMPLETE ID:fe23 TO:leader REF:PR#42
```

## Events and mandatory response

| Event | Sender → receiver | Expected response |
|---|---|---|
| `PING` | Either → known target | `PONG`, matching `in_reply_to` |
| `JOIN_REQUEST` | Worker → Leader | `JOIN_ACK` accepting, adjusting or rejecting scope |
| `JOIN_ACK` | Leader → Worker | `ACK_RECEIVED` (only if accepted and verified) |
| `ASSIGN` | Leader → registered Worker | `ASSIGN_ACK` or `BLOCKED` |
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

## Coordination-only Leader and idle behavior

- Leader is a **receipt-driven dispatcher**: assign responsibilities, route blockers, request independent reviews, summarize received results. Never code, inspect diffs, run tests, review implementation, merge or deploy.
- After sending a message, finish the turn. **Do not run watchers, filesystem listeners, polling loops, `wait_threads`, scheduled checks, or status probes** to await a Worker. Native incoming messages provide the next event when the host supports delivery.
- Missing Worker / Reviewer means `NO_WORKER_AVAILABLE` / `REVIEW_PENDING`, not that the Leader should take over.

## Handling ambiguous outcomes

- Distinguish `tool_failed`, `transport_sent`, `receiver_acknowledged`, `review_accepted`, `merged`.
- If native send returns success but no reply, status is `SENT_UNACKNOWLEDGED`.
- Never mark a Worker active simply because a `JOIN_REQUEST` was sent.
- If a Codex send returns an error that may still have delivered, **inspect the exact target** before resending the same `message_id`.
- Durable task state can be saved in repository docs/issues/explicit stores, but **never treat such storage as a message relay** under this Skill.
