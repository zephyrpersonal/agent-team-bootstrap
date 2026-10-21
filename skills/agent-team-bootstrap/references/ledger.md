# Team ledger

The ledger is the Leader's durable coordination state: mission, plan, work package briefs, roster and decisions. It lets assignments carry full context despite the 600-byte message budget, survives context compaction and Leader changes, and gives `BACK_ACK` / `REJOIN` something to reconcile against.

It is **not** a message channel. Messages still go through the team transport; nobody polls the ledger; Workers learn about a change only from a message carrying a pinned ref.

## Location

- A dedicated branch `team/<project>` in the project's Git remote. It is never merged into the default branch and never opened as a PR. A project may configure an issue tracker instead (`AGENTS.md`); then the same files map to issues and the pinned ref is the issue URL plus its edit time.
- The Leader needs no project code, only push access to the remote. Resolve the location once at startup, first match wins:
  1. A location the project configured (`AGENTS.md`: issue tracker, or a separate ledger repository).
  2. `Ledger: <git url>` in the Leader prompt: a separate repository holding only ledgers, branch `team/<project>`. Use it when the Leader has no access to the project repository; Workers need read access to it.
  3. The project remote, from `Repo: <git url>` in the Leader prompt or the Leader's own checkout.
  4. None of these, or no push access → report `LEDGER_UNAVAILABLE` to the Owner and run without a ledger: roster in the session, briefs written by the Owner or a scout Worker as pushed artifacts. Warn that compaction or a Leader change can then lose mission state.
- The Leader keeps the ledger in its own directory with only the ledger branch checked out, never inside a code checkout:

  ```bash
  # Leader workspace without project code
  git clone --single-branch -b team/<project> <url> <ledger-dir>      # branch exists
  git init <ledger-dir> && git -C <ledger-dir> remote add origin <url> \
    && git -C <ledger-dir> checkout --orphan team/<project>             # first mission; push with -u origin team/<project>

  # Leader that already has a project checkout
  git worktree add ../<repo>-team team/<project>                        # branch exists
  git worktree add --orphan -b team/<project> ../<repo>-team            # first mission (git 2.42+)
  ```

- Only the current-epoch Leader commits and pushes to it, and never force-pushes. If a push is rejected, fetch and read `roster.md`: a higher epoch there means another Leader took over, so stand down and tell the Owner; otherwise rebase the ledger commit and push again.
- Repositories whose CI runs on every branch should exclude `team/**`.
- Workers never write to it; they read pinned refs:

  ```bash
  git fetch origin team/<project>
  git show <sha>:wp/17.md
  ```

  With a separate ledger repository, `JOIN_ACK` carries `LG:<url>` once; Workers fetch from that URL (`git fetch <url> team/<project>`, then `git show <sha>:wp/17.md`).
- Reports the Leader must read (scout reports, final summaries) go where the Leader can read them: the project remote if it has access, otherwise a PR/issue comment or a path the Owner named. The Leader never needs a code checkout to read them.

## Pinned references

Every `ASSIGN` / `REDIRECT` that points into the ledger uses `REF:team/<project>@<sha>:<path>` (e.g. `REF:team/wms@3f9c2e1:wp/17.md`). Commit and push first, then send. A Worker reads exactly that version, so a later edit cannot silently change its brief; a changed brief needs a new `REDIRECT` with a new ref.

## Files

| File | Content |
|---|---|
| `missions/<id>.md` | One per mission: goal, non-goals, constraints, acceptance criteria, assumptions, open questions, priority (`P0` urgent / `P1` normal / `P2` when capacity allows), status (`INTAKE` / `PLANNED` / `APPROVED` / `RUNNING` / `REPORTED` / `CLOSED`) |
| `plan.md` | Work package table across missions: id, mission, priority, title, owner, depends on, parallel group, reviewer, `DUE`, status (`QUEUED` / `ASSIGNED` / `PAUSED` / `DONE` / `STOPPED`), receipt IDs |
| `wp/<id>.md` | One work package brief (template below) |
| `roster.md` | Members: id, address (`<machine>/<name>` on herdr), agent kind, session, `created_by`, role, workspace, state (`ACTIVE` / `AFK` / `LOST` / `LEFT`), current package, authorized peer contacts, last received receipt ID; Leader epoch `E`, `FO`, transport |
| `decisions.md` | Owner answers (`BY:owner`) and delegated decisions (`BY:profile` / `BY:decision:<id>`), dated, with reason |
| `owner.md` | Project owner profile and delegated authority (Owner-confirmed) |

## Recommended plan and roster tables

Use the existing English field names below as table headers so the optional dashboard can parse them. These examples preserve the fields and states defined above; replace the example sessions with complete session IDs. Keep one table per file, outside code fences in the actual ledger files.

`plan.md`:

```markdown
| id | mission | priority | title | owner | depends on | parallel group | reviewer | DUE | status | receipt IDs |
|---|---|---|---|---|---|---|---|---|---|---|
| 17 | dashboard | P1 | Read the team ledger | backend-01 | — | readers | qa-01 | 2026-10-20T12:00:00Z | ASSIGNED | assign-17, ack-17 |
```

`roster.md`:

```markdown
| id | address | agent kind | session | created_by | role | workspace | state | current package | authorized peer contacts | last received receipt ID | E | FO | transport |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| backend-01 | local/backend-01 | Claude Code | claude-worker-full-session-id | owner | Worker | /work/demo | ACTIVE | 17 | qa-01 | ack-17 | — | — | native |
| qa-01 | local/qa-01 | Codex | codex:codex-reviewer-full-session-id | owner | Reviewer | /work/demo-review | ACTIVE | — | backend-01 | — | — | — | native |
```

Task owner/reviewer values link through an exact roster id or address, then the agent kind and complete session ID; names and shortened IDs are insufficient. The optional, human-run dashboard reads only `plan.md` and `roster.md` from a local snapshot and never automatically fetches or writes the ledger. This human view is not a task channel and does not change the message and pinned-ref rules above.

## Work package template

```markdown
# WP-<id>: <title>
Mission: missions/<mid>.md   Priority: P1   Owner: <worker>   Reviewer: <worker|none>
Base: <branch or tag to start from>   Peers: <workers you may coordinate with>   Consult: <workers you may ask, max N questions>

## Goal
One or two sentences: what changes for the user/system when this is done.

## Deliverable
Branch / PR / report, and where it is pushed.

## Acceptance criteria
- [ ] Observable, checkable statements (tests, behaviour, docs).

## Non-goals
- Things that look related but must not be done here (raise SCOPE_CHANGE_REQUEST instead).

## Context
Links: scout report, files/modules, docs, related packages, decisions.

## Contracts and dependencies
Depends on WP-<x> (contract at <ref>). Provides <contract> to WP-<y>.

## Budget
DUE: <UTC time>   ROUNDS: <max review rounds>

## Checkpoints
- M1: <milestone> (GATE: wait for CONTINUE | no gate)
- M2: ...

## Escalate when
Specific triggers beyond the defaults (over budget, non-goal touched, contract change).
```

A **fix for what is deployed** (often `P0`) branches from the deployed base (default branch or release tag), never from another package's branch. Its non-goals include refactoring and anything from other running missions; `ROUNDS` is 1–2; acceptance is "reproduction fixed, regression test added, touched areas listed in `COMPLETE`". `Consult` is set from the current load (leader.md 4a).

A **scout** package has a read-only goal and a report deliverable (affected areas, risks, suggested split, contracts to fix first); its acceptance criterion is "the Leader can plan from it".

## Mission template

```markdown
# Mission <id>: <title>   Priority: P1   Status: INTAKE
Owner request (verbatim or quoted summary): ...
Goal (restated): ...
Non-goals: ...
Constraints: ...
Acceptance criteria:
- [ ] ...
Assumptions: ...
Open questions (≤ 3, asked together): ...
Owner confirmation: <date, BY:owner>
```

## Owner profile template

Global `~/.agents/owner-profile.md` (local, never committed) and project `owner.md` share this shape:

```markdown
# Owner profile
Language / tone: ...
Priorities and taste: (e.g. small PRs, tests first, no new dependencies)
Risk tolerance: ...
Recurring decisions: (e.g. naming, error handling, UI conventions)

## Delegated authority (Owner-edited only)
The Leader may decide on my behalf:
- e.g. provision a new Worker in its own worktree when a P0/P1 package has nobody free
Max Workers: <n> (cap on concurrent Workers the Leader may run)
- ...
Never delegated: destructive actions, deploys, access control, merges, scope beyond the mission.
```
