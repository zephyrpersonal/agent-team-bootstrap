# Leader task management

Load this reference as Leader at startup and for task creation, updates, regrouping and receipt reconciliation. It defines task operations; [leader.md](leader.md) retains decision rights and scheduling, [ledger.md](ledger.md) retains storage and templates, and [protocol.md](protocol.md) retains control-message semantics. Workers load their pinned brief, not this reference as authority to reorganize others.

## Invariants

- The ledger is the task record, not a second inbox. Only the current-epoch Leader writes it. Persist and push a coherent snapshot before dispatch; if unavailable, report `LEDGER_UNAVAILABLE` and the missing durable record. Never claim a message or a proposed task was registered when it was not.
- IDs are stable and never reused. Preserve original requests, sources, acceptance criteria, artifacts and receipt IDs. Do not delete history, silently replace an assigned brief, or reinterpret an old receipt as a new deliverable.
- Use existing plan states: `QUEUED`, `ASSIGNED`, `PAUSED`, `DONE`, `STOPPED`. Review/gate/blocker details belong in brief/coordination notes; `REVIEW_PENDING` is not a new plan state. Preserve and flag pre-existing unknown states rather than silently converting them.
- Keep task status, membership and current execution separate. `DONE` requires the completion/verdict and acceptance references specified by leader.md. `STOPPED` never means successfully delivered or a satisfied dependency.
- Owner goal, non-goals, acceptance and approval boundaries still govern. Reorganization does not authorize production, database changes, merges, new staffing or runtime bypass. Apply existing multi-package/shared-contract gates; splitting cannot disguise a multi-package plan as several single-package fast paths.

## 1. Triage and create

For each Owner request, first read the relevant open tasks, decisions and original request:

- A question needs an answer, not automatically a new mission.
- An exact duplicate points to the existing task; retain the new request's source without dispatching duplicate work.
- A clarification inside an existing deliverable updates that task.
- Related but independently accepted work may share a mission, dependency or parallel group without merging IDs.
- A distinct deliverable needs a new task; a distinct confirmed goal may need a new mission.

Create the smallest coherent work package: ID, mission, priority, title, one accountable owner, reviewer or explicit none, goal, deliverable, observable acceptance, non-goals, dependencies, base/candidate, budget/checkpoints, execution bounds and approval sources. Unknown facts remain unknown. Use an explicit unassigned marker for queued work; do not invent a registered Worker. Store full detail in `wp/<id>.md` and the existing plan columns, not a long message. A short brief may omit empty headings, never required boundaries.

## 2. Update and prioritize

Record what changed, why and from which Owner input or verified receipt. Adjust priority, owner, reviewer, dependencies and budget only within existing decision rights. A status update does not itself change the brief or grant execution rights.

For an unassigned task, update its record before staffing. For an assigned task whose instructions change, push the new snapshot and send `REDIRECT TASK:<id> REF:<pinned brief>`; require the existing `ASSIGN_ACK U:` correlated to that control message. A paused task uses `RESUME` through normal scheduling. Notify affected dependencies/peers directly with the existing control events; a ledger edit alone does not notify anyone. Bind final evidence to the actual task, candidate and brief revision.

## 3. Group, deduplicate and merge

Similarity is only a reason to compare. Merge only when all of these hold:

- One coherent deliverable and owner can cover every source request without losing an acceptance criterion.
- Bases/candidates, permissions, environments, priorities, dependencies and review arrangements are compatible or have been explicitly reconciled within authority.
- Combining does not delay an urgent independent fix, inflate scope/budget, hide a separate approval gate or erase useful parallelism.

For example, copy and layout fixes for one approved page can form one acceptance package. A staging release and a migration execution stay separate when the database gate is independent. Do not merge solely because titles, files or Workers match.

For queued work, retain a suitable surviving ID or create a new composite ID. Keep each replaced open ID as `STOPPED`, with a plain-text `superseded by` note, reason and successor IDs in its brief/decisions; no fabricated stop receipt is needed for never-dispatched work. Map each source requirement to a surviving acceptance item. Do not add `MERGED` states, custom columns or extra Markdown mapping tables that the current ledger reader cannot parse.

Already `DONE` records stay done and unchanged as historical evidence. A later enhancement or discovered defect gets a new linked task; old tests, review verdicts and deployment approvals do not automatically approve its new candidate.

## 4. Split or reorganize executing work

Split only where independently deliverable scopes, dependencies or specialist roles justify the overhead. Give each child an owner, acceptance, budget, review and integration destination; the union must cover the retained source requirements. Do not leave parent and children with simultaneous overlapping mutation ownership.

For an executing merge/split/reassignment:

1. Confirm applicable Owner plan/approval gates and record the intended requirement mapping.
2. `STOP` affected execution and collect `COMPLETE STATUS:stopped` plus the permitted handoff. Preserve branch/candidate SHA, dirty or untracked artifacts, limits and outstanding reviews. Do not require a forbidden push or destructive cleanup. Do not treat a sent STOP as released ownership/capacity. `PAUSE` keeps its existing scheduling/preemption meaning; reorganization is not a new blanket pause permission.
3. Update plan, briefs, roster current package, peer contacts and all affected dependency references in one ledger snapshot. Preserve retired IDs and provenance in notes. A continuing stable ID gets a revised brief; a replacement ID is a new assignment, not a silent rename.
4. Push, then send a pinned `ASSIGN` for new task IDs or `REDIRECT` for a continuing ID and require the corresponding scope ACK before relying on execution. Distinguish accepted instructions from merely sent messages.
5. Late receipts for retired IDs/old revisions remain history; do not complete a successor or restore old write ownership from them. Reassess whether any prior artifact is reusable, but keep its candidate/review/approval provenance.

If handoff is absent or an old writer cannot be fenced, block overlapping mutation rather than run both. Use existing LOST/replacement rules, not an improvised lock service.

## 5. Dependencies and consistency

After creation, material update or reorganization, check once on that event:

- No duplicate active deliverable, reused ID or missing accountable owner for dispatched work.
- No dangling dependency, self-dependency or cycle after predecessor IDs are remapped.
- Every stopped/cancelled requirement has a successor or an explicit authorized cancellation; no acceptance item disappears.
- Dependents wait for the actual required contract/evidence from successors, not merely a predecessor's STOPPED state. Preserve external references and flag those that cannot be updated.
- Roster current packages, authorized peers, candidate revisions and pinned control refs match the new plan. Do not copy independent review/Owner approval across revisions without checking applicability.

These are Leader coordination checks, not code inspection, implementation verification or background polling. Keep workspace/resource ownership explicit under existing project isolation rules: repository/branch/revision, current writer, Git owner, test/build side effects, ports, database and deployment target. A worktree does not isolate external services.

## 6. Assemble task-scoped Worker groups

Staff around the task, not a permanent list of frontend/backend/QA titles. A task group is the existing Workers and explicitly scoped collaborators attached to one coherent package or a set of dependent packages; it is not a second Leader or transport.

- Keep one accountable task owner. Add implementers, scouts, test helpers or an independent Reviewer only when their distinct contributions justify cost. A small task may need one Worker; do not instantiate a full role roster per task.
- Reuse eligible registered Workers first, considering capabilities, execution bounds, priority and load. When none fits, create specialists only under applicable staffing authorization, real independent-session support, capacity and budget. Task grouping does not itself grant provisioning or operation permissions.
- For several execution collaborators, record non-overlapping scopes, shared contracts, handoff/integration owner and authorized P2P contacts in the brief/roster notes. If scopes need separate deliverables or acceptance, split into packages rather than hide multiple owners in the single plan `owner` cell.
- A Reviewer remains independent of the work they sign off; task membership does not let a producer approve their own changes. Technical collaboration and review stay direct P2P, not Leader-relayed.
- Use existing workspace/isolation and resource rules; sharing a task label does not make concurrent checkout/index/build/DB writes safe. Ownership changes require handoff.
- Rebalance on task change or completion. Reuse available members for other approved work or `RELEASE` only those no other mission needs, respecting Owner close/keep instructions. Do not delete panes/workspaces/branches or infer task completion from a group becoming idle.

## 7. Complete, stop and logically archive

Record `DONE` only on matching deliverable, required independent verdict and acceptance references. Record `STOPPED` with the unfinished reason, handoff and successor/cancellation decision. A stopped task can no longer receive ordinary completion expectations; explicitly schedule its remaining requirements elsewhere.

Logical archive retains IDs, plan rows and references; it is not deletion or a new state. Mission reporting/closure still follows `REPORTED` then Owner acceptance before `CLOSED`. Report delivered work, gaps and next actions without claiming unverified implementation, test or deployment outcomes.
