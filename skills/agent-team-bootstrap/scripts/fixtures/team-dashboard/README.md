# Transcript fixtures

These fixtures were extracted from local transcripts on 2026-10-17. They are
structural samples, not generated from the parser. Text, project/member/session
identifiers, paths, socket addresses, tool inputs and outputs are replaced with
test values. Unrelated metadata, instructions and duplicated rendered content
are omitted. Each entry records its original line number and SHA-256 before
sanitization so the local source can be checked without publishing private logs.
Tests rebase timestamps and assemble short scenarios from these independent rows.

- `codex.json`: Codex 0.163.0, source `vscode`, rollout dated 2026-10-16.
  Includes `session_meta`, user/assistant `response_item.message`,
  `function_call`, array-valued `function_call_output`, `task_started`,
  `task_complete`, and `custom_tool_call` / `custom_tool_call_output`.
  All 991 complete local `send_message_to_thread` calls used `threadId` and
  `prompt`; one additional call had an empty argument object. The actual call has
  `name: "send_message_to_thread"` and `namespace: "mcp__codex_tui"`.
  `turn_aborted` is a separate sample dated 2026-10-06.
- `claude.json`: Claude Code 2.1.296, transcript dated 2026-10-12.
  The receive wrapper is in `attachment.prompt` for `queued_command`, or in
  `user.message.content` after `Another Claude session sent a message:`.
  It includes `from`, `from-name` and `from-mode` attributes. The accompanying
  `queue-operation.enqueue` sample is deliberately ignored by the parser:
  queue bookkeeping is not another delivered message.

The original local source basenames are
`rollout-2026-10-16T20-54-19-01a144c7-11e2-7261-8994-d34e881c35ec.jsonl`,
`rollout-2026-10-04T20-14-00-01a106d5-d862-70e3-8339-e7792d3e1294.jsonl`
(interruption only), and `b90bc243-dec7-42f2-8514-138a91ebfa64.jsonl` (Claude).
No test depends on those files or the user's home directory.

No real `event_msg.agent_message` was found in 48 local JSONL files or 919
compressed rollout archives. Its existing text-only compatibility branch has
an explicitly handwritten test; it is not claimed as verified. Compressed archives
were inspected offline for this validation and are not read by the dashboard.

Regression tests also cover ignored documentation envelopes, exact thread ID
routing, interruption with unmatched tools, UTF-8/chunk boundaries, partial
lines, split sessions, stale status and the loopback Host guard.

Browser acceptance on 2026-10-17 used Ego Lite (Chromium) and an isolated
fixture server with no transcript reader. The real `?demo=1` page ran through
33 steps with no script errors. All seven requested states, envelope flights,
light/dark themes, eight members, and 320/375 px widths were inspected.
Reduced motion was checked both on load and while toggling the preference:
no active animations or flying envelopes, with static sleep/completion marks.
Automated checks also parse the inline script and exercise layout bounds.
