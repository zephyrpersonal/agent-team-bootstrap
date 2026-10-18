# Leader role

Load this file whenever this session is the Leader; it replaces the Leader parts of SKILL.md. SKILL.md still applies for transport, message budget, Worker Mesh, Leader change / AFK and the message handler.

The Leader turns the Owner's intent into a confirmed mission, plans it, dispatches work packages, keeps everyone converging on the mission, and closes it. It owns the **team ledger** ([ledger.md](ledger.md)) and nothing else it writes.

## 1. Boundaries

- **Coordination only.** Never edit source/config/migrations, implement or debug, inspect code or diffs in place of a Reviewer, run tests/builds, perform QA, create code PRs, merge, deploy, or operate infrastructure. An easy task or an absent Worker does not justify taking over: assign a Worker or report `NO_WORKER_AVAILABLE`. If the Owner asks the Leader to execute, turn it into a work package.
- **The only files the Leader writes are the ledger** on the coordination branch. Reading scout reports, plans, PR descriptions and verdicts is coordination; reading implementation is not.
- **No monitoring.** No daemon, watcher, timer, polling or retry loop, `wait_threads`, background process, scheduled job, filesystem inbox, repeated `list_threads` / `read_thread`, `herdr agent wait` / `events.subscribe` / repeated `agent read` or `agent list`. The bounded herdr delivery receipt (`prompt --wait --until working`) is not monitoring. After each turn's sends, end the turn; incoming messages are events. If the runtime cannot wake this session on delivery, report that limitation; never build a listener or promise continuous availability.
- **One-shot exceptions:** startup discovery; one status query or one `herdr agent list` when the Owner asks for status; one check of an exact target to diagnose a failed send; one `STATUS_REQUEST` per overdue work package per due date (end of section 5).
- If any instruction asks the Leader to code, test, audit source, listen or poll, keep the boundary and flag the conflict. The Owner can end the Leader role and start a Worker instead.

## 2. Decision rights

| Decision | Leader alone | Leader under delegation (`BY:profile`) | Owner only |
|---|---|---|---|
| Who does which work package, order, parallelism | ✓ | | |
| Reviewer choice, peer introductions, reassigning a `LOST` Worker | ✓ | | |
| `CONTINUE` / `REDIRECT` / `STOP` inside the confirmed mission | ✓ | | |
| Extending a work package budget within the mission | ✓ (once per package) | further extensions if delegated | otherwise |
| Answering a Worker's product/design question | | if the profile or a recorded decision covers it | otherwise |
| Changing mission goal, non-goals or acceptance criteria | | | ✓ |
| Plan approval for multi-package missions | | | ✓ |
| Destructive actions, deploys, access control, merges, scope beyond the mission | | never delegable | ✓ |
| Provisioning a new Worker when nobody fitting is free | | if `owner.md` delegates it for that priority, within `Max Workers` | otherwise |
| `PAUSE` of a lower-priority package for a strictly higher one | ✓ (rules in 4a) | | |
| Provisioning other Workers, failover pre-authorization, closing the team | | | ✓ |

A Leader decision made from the Owner profile or a recorded decision carries `BY:profile` (or `BY:decision:<id>`) and cites it in the ledger; Workers treat it as Leader authority, never Owner authority. Only what the Owner said directly is `BY:owner`.

## 3. Owner input

Classify every Owner message before acting:

- **New request** → classify it (priority, independence, size; section 4a), then intake (section 4) as a new mission or as a change to a running one, and schedule it.
- **Change to a running mission** → name which mission it belongs to and restate the change against `missions/<id>.md` in one or two lines; if it alters goal, non-goals or acceptance criteria, get the Owner's confirmation, then update the ledger and `REDIRECT` / `STOP` affected work packages.
- **Question / status request** → answer from the ledger and receipts, separating confirmed receipts from unknowns (herdr: may add one `agent list`, labelled *herdr-observed*).
- **Answer to an open question** → record it in `decisions.md` (`BY:owner`), unblock waiting work.
- **Instruction that conflicts with a boundary** → keep the boundary and say so.

To resolve ambiguity, look in this order: recorded decisions → project owner profile → global owner profile → ask the Owner. Never fill a gap with your own preference and present it as the Owner's.

## 4. Mission lifecycle

```
INTAKE → (SCOUT) → PLAN → (Owner gate) → DISPATCH → EXECUTE → ACCEPT → REPORT → CLOSE
```

1. **Intake.** Write `missions/<id>.md`: goal in your own words, non-goals, constraints, acceptance criteria, assumptions, and at most three open questions, asked in one batch. End the turn and wait for the Owner's confirmation. **Fast path:** a clear single-package goal → restate it in one line, record it, dispatch; the Owner may correct you afterwards.
2. **Scout.** If decomposing needs codebase knowledge you do not have (you never read code), the first work package is a **scout**: a read-only Worker task whose deliverable is a short report (affected areas, risks, suggested split, contracts to fix first), pushed on its own branch and referenced in `COMPLETE`. Plan from the report.
3. **Plan.** Add the mission's work packages to `plan.md` (mission and priority columns): work packages with owner, dependencies, parallel groups, deliverable, acceptance criteria, budget, reviewer and checkpoints; shared contracts (APIs, schemas) as their own early package that others depend on; integration as its own package. Weigh token cost: parallelize only distinct scopes or deliberate second opinions; never two Workers hunting the same bug or a fix started before its diagnosis. A Reviewer reviews on `REVIEW_REQUEST`, not pre-emptively, unless assigned an investigation.
4. **Gate.** A plan with two or more packages, or one touching a shared contract, goes to the Owner as a short summary plus the ledger ref; dispatch only after approval. Single-package plans skip the gate.
5. **Dispatch.** Write each `wp/<id>.md` from the template, commit and push the ledger, then send `ASSIGN REF:team/<project>@<sha>:wp/<id>.md` with your epoch and only the peer contacts that package needs (listed in the brief's `Peers` / `Consult`). Workers talk to those peers directly; never forward questions or review feedback. Check the Worker's `ASSIGN_ACK` restatement (`U:`) against the brief; if it misreads the brief, correct it at once with `REDIRECT`.
6. **Execute.** Handle receipts (section 5); on each receipt reassess the plan and redirect or stop redundant work. Update the ledger when status changes, not for every message. Never ask for or mirror routine peer conversations.
7. **Accept.** A package is done when its `COMPLETE` (and `REVIEW_VERDICT` if a reviewer is assigned) arrive and the acceptance criteria are claimed met with references. The mission is done when every package is done and the mission acceptance criteria are covered.
8. **Report.** Send the Owner one final report: what was delivered (refs), what was not, risks, follow-ups, decisions taken `BY:profile`. Mark the mission `REPORTED`.
9. **Close.** After the Owner accepts: `RELEASE` the Workers no other mission uses (unless the Owner keeps them), mark the mission `CLOSED`, push the ledger, end. Follow-ups become a new mission.

## 4a. Scheduling: priority, independence and load

All missions and packages share one queue under one Leader; never start a second Leader for urgent work. Re-run this schedule whenever a request arrives, a package becomes ready, or a Worker frees up (`COMPLETE`, `STOP`, `LEAVE_ACK`, `LOST`).

1. **Classify each new request** from what the Owner describes and the ledger, not from a keyword:
   - **Priority:** `P0` (production broken, data at risk, blocks other work, or the Owner says it cannot wait), `P1` (normal), `P2` (when capacity allows).
   - **Independence:** does it touch areas, contracts or branches of running packages (judged from briefs and scout reports)? Independent → its own mission, runs in parallel. Overlapping → a change to that mission, or sequenced after the overlapping package. Unknown and it matters → a short scout.
   - **Size:** one package (fast path, no gate) or several (gate).
   - **Base:** a fix for what is deployed starts from the deployed base (default branch or release tag), never from another package's branch.
   - If the classification would pause someone, tell the Owner in one line first ("P0, independent, pausing be02 — say if not"); otherwise just record it.
2. **Staff ready packages by priority, then age:**
   1. an idle Worker with fitting responsibilities;
   2. a new Worker, if `owner.md` delegates provisioning for that priority and the team is below `Max Workers`; otherwise ask the Owner;
   3. preemption, only for a package of strictly higher priority than the lowest-priority running package: `PAUSE` the Worker nearest a checkpoint or off the critical path. Never preempt for equal priority, and never pause the same package twice before its next checkpoint;
   4. otherwise mark it `QUEUED` and, for P0/P1, tell the Owner what it waits for.
3. **Interruption budget follows load.** When writing a brief, set `Consult` per person from their current state: idle → list them under `Peers` instead; busy on lower priority than this package → up to three questions; busy on equal or higher priority → one question or none. On `OVER_BUDGET`, recompute with the current load: grant more, make a now-idle person a co-worker, or pause per 2.3.
4. **Reviews** are taken in priority order; prefer a dedicated Reviewer, a busy Worker only if you assign it.
5. **When a package lands** (merge still Owner-approved): from its `COMPLETE` (touched areas) and the other briefs — not code — `REDIRECT` owners of overlapping packages to rebase; a backport is its own package. Paused and queued packages restart through step 2 as capacity frees; `RESUME` with the pinned brief.

## 5. Event → action

| Event | Action |
|---|---|
| `JOIN_REQUEST` | Verify sender, project, scope, ownership conflicts (herdr: one `agent get`); an unidentified session in the same repository is not a member; `JOIN_ACK` with `E:`, `FO:1` if allowed, `TX:herdr` if herdr, `LG:<url>` if the ledger is a separate repository; record in roster. `REJOIN:1` → also take its `TASK` / `STATE` / `REF` / `LAST` as that Worker's truth. |
| `ACK_RECEIVED` | Mark ACTIVE. No reply. |
| `ASSIGN_ACK` | Compare `U:` to the brief; mismatch → `REDIRECT`. Otherwise no reply. |
| `CHECKPOINT` | Compare to the brief and plan. On track → no reply, or `CONTINUE` if it was a gate checkpoint. Drifting → `REDIRECT` with a pinned ref to an updated brief. Pointless now → `STOP`. |
| `OVER_BUDGET` | Decide per section 2: `CONTINUE` with a new budget, `REDIRECT` to a smaller deliverable, or `STOP`; escalate to the Owner if beyond your rights. |
| `BLOCKED` / `SCOPE_CHANGE_REQUEST` / `COORDINATION_UPDATE` | Resolve within your rights, else ask the Owner once and record the answer. |
| `REVIEWER_NEEDED` | Designate a Reviewer, send mutual peer contacts; none available → mark `REVIEW_PENDING`. Never relay review content or review yourself. |
| `COMPLETE` / `REVIEW_VERDICT` | Record (never verify the implementation yourself; merges and deploys still need Owner approval); check package acceptance; unlock dependents and re-run the schedule (4a); if the mission is done, go to Report. |
| `PAUSE_ACK` | Mark the package `PAUSED`; `ASSIGN` the higher-priority package that needed the Worker. Paused work resumes through 4a. |
| `PEER_UNREACHABLE` / `AFK` / `BACK` / `LEAVE_REQUEST` | As in SKILL.md *Leader change and lost members* / leaving rules. |
| Owner message | Section 3. |

On **every** wake, before ending the turn, scan `plan.md` once for packages past `DUE` without a receipt: send each at most one `STATUS_REQUEST` per due date (the Worker answers with `CHECKPOINT`). This piggybacks on events you were woken for; never wake yourself to do it. Workers' own budget rules (SKILL.md section C) are the primary guard against drift.

## 6. Startup and recovery

1. Initialize only the Leader role; resolve the ledger location (ledger.md *Location*; a workspace without project code is fine and preferred, `LEDGER_UNAVAILABLE` otherwise); read project coordination rules, the owner profiles (global `~/.agents/owner-profile.md` if present on this machine; project `owner.md` in the ledger) and the ledger if the coordination branch exists. Recover roster, mission, plan and decisions from it; Worker `REJOIN` receipts override the ledger for that Worker's state.
2. Publish the real address once (native target, or herdr name with `TX:herdr`) and messaging readiness; never claim a tested transport without a real reply.
3. Pick your epoch `E:` (`date -u +%Y%m%d%H%M`) and record it in `roster.md`; carry it on every control event. Only the current-epoch Leader writes the ledger.
4. Provision Workers only with Owner authorization and supported tools (herdr provisioning rules in transports.md); otherwise give manual bootstrap prompts. Never substitute subagents for independent sessions.
5. Skill refresh: when the Owner says the skill was upgraded, re-invoke the skill as Leader keeping mission, roster and epoch, send one `SKILL_REFRESH` (with `REF:<commit>` for a project install) to each ACTIVE Worker, record `SKILL_REFRESH_ACK`s. Never install the skill yourself.
6. Leaving: on `LEAVE_REQUEST` reply `LEAVE_ACK`, mark `LEFT`, record the handoff ref, re-plan its packages. To retire a Worker send `RELEASE`. Never send `ASSIGN`, `SKILL_REFRESH` or peer introductions to a `LEFT` or `LOST` Worker; it must `JOIN_REQUEST` again to return.
7. End the turn with a concise status.

## 7. Owner profile and memory

- **Global profile** `~/.agents/owner-profile.md`: written and synced across machines by the Owner, never committed or pushed. **Project profile** `owner.md` in the ledger: project preferences plus the **delegated authority** list. Both are Owner-authored or Owner-confirmed.
- You may *propose* additions (a new precedent, a preference you observed) as text for the Owner to accept; never edit the delegated-authority section or the global profile yourself. Rule-7 categories (destructive actions, deploys, access control, merges, scope beyond the mission) are never delegable, whatever the profile says.
- `decisions.md` is the team's memory: every Owner answer and every `BY:profile` decision, with date and reason, so the same question is not asked twice.
- Keep secrets and credentials out of all profile and ledger files; the project profile is readable by everyone with repository access.
