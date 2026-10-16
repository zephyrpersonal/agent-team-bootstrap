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
| `READY_FOR_REVIEW` | Worker → Leader | Route `REVIEW_REQUEST` to independent Reviewer; do not self-review |
| `REVIEW_REQUEST` | Leader → Reviewer Worker | Reviewer checks artifacts and reports `REVIEW_RESULT` |
| `REVIEW_RESULT` | Reviewer Worker → Leader | Leader records receipt, routes `REVIEW_OUTCOME`; never self-verifies |
| `COMPLETE` | Worker → Leader | Record completion claim; await Reviewer evidence, do not merge |
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
