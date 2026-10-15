# Native cross-session transport selection

Do not mix these mechanisms or presume availability. **This is a capability guide, not an executable API shim.** Discover actual tool names and call schemas in the runtime.

## Claude Code → Claude Code

- Native discovery: model tool `ListAgents`; human diagnostic: `/list-agents` or `/peers`.
- Native send: model tool `SendMessage`, usually addressed by the verified target session. A user may `@` mention an unambiguous live session.
- Claude Code 2.1.224+ on macOS/Linux/WSL2, 2.1.234+ native Windows. When a receiving interactive session is idle and **message is delivered**, Claude Code starts a new turn automatically. During an active turn the receiver reads between tool calls, without interrupting a running tool.
- Incoming messages can be `delivered`, `held` or `refused`, depending on `crossSessionInbound`, permission classes and security checks. If held, check the receiver UI and ask the Owner to approve or configure it. Changing settings is not the Skill's prerogative.
- For a verified live target, send `PING` and require `PONG` before relying on communication. Check `/status` `Peer address` when target is not discovered.
- `SendMessage` has `notify_when_idle` in Claude Code 2.1.236+. This is useful for **one-time completion notification**, not a persistent queue, and is subject to limitations. Use only if the actual tool schema advertises it.
- Native cross-machine requires supported Remote Control/cloud setup; different containers or WSL2/native Windows sides are not automatically reachable.
- Do not directly write to inbox sockets or simulate `SendMessage` with shell; that bypasses the explicit native tool semantics the Owner requested.
- Reference: https://code.claude.com/docs/en/cross-session-messaging

## Codex Desktop → Codex Desktop

- Depending on app/session/tool exposure, native thread tools may include `list_threads`, `read_thread`, `send_message_to_thread`, `create_thread`, `fork_thread`, `wait_threads`, `handoff_thread`. Namespaces can include `codex_app` or client-specific forms; inspect callable tool metadata.
- Need an actual **effectful** send tool for messaging; presence of `list_threads` or `read_thread` alone is insufficient.
- Resolve intended Worker/Leader to a **current verified thread ID and host/workspace**, not an old task with a similar title. Some tools include `hostId`; pass only fields required by the actual advertised schema.
- A send may wake an idle task or start a turn in available builds, but product behavior has changed across clients/versions; verify via destination readback or an application-level reply. Do not assert universal automatic wake capability.
- A handler error is not proof of nondelivery: check the exact target's newest messages before retrying; duplicates can trigger additional turns.
- If no `send_message_to_thread` or comparable official native tool is callable, mark `READ_ONLY` or `UNAVAILABLE`. Do not call private app-server WebSocket interfaces, tool implementation internals, or local raw transport as a workaround.
- Avoid optional model/thinking overrides when sending messages unless the Owner explicitly requests model changes.
- Codex independent user-owned threads are different from `spawn_agent` / `send_input` subagents: never silently substitute one for the other.
- Public issue evidence about tool-gating/regressions: https://github.com/openai/codex/issues/40852 and https://github.com/openai/codex/issues/30233

## Codex CLI → independent Codex session

- Probe tools exposed in **this particular CLI session**. Some environments report `codex_tui`/Codex thread messaging, others provide only subagent messaging or no cross-thread messaging.
- Do not assume tools available to Desktop are callable in plain CLI. When direct independent-thread send is missing, fail `NATIVE_MESSAGING_UNAVAILABLE` for that route; the user may open the same task in Desktop if the feature is exposed there, or deliberately choose manual handoff.

## Cross-provider (Codex ↔ Claude Code)

- These products have separate peer registries and transports. Their native tools do not directly address each other.
- The Owner must explicitly authorize an external bridge, or choose all-Worker and Leader sessions in the same product for native-only operation.

## What the Skill guarantees

- Reliable *procedure*: choose peer, check tools, send, receive acknowledgment, track failure honestly.
- It does not guarantee remote uptime, permissions, a durable notification service, automatic restart, or a synchronized project database.
