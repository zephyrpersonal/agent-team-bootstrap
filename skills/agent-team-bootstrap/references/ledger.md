# Team ledger

The ledger is the Leader's durable coordination state: mission, plan, work package briefs, roster and decisions. It lets assignments carry full context despite the 600-byte message budget, survives context compaction and Leader changes, and gives `BACK_ACK` / `REJOIN` something to reconcile against.

It is **not** a message channel. Messages still go through the team transport; nobody polls the ledger; Workers learn about a change only from a message carrying a pinned ref.

## Location

- A dedicated branch `team/<project>` in the project's Git remote. It is never merged into the default branch and never opened as a PR. A project may configure an issue tracker instead (`AGENTS.md`); then the same files map to issues and the pinned ref is the issue URL plus its edit time.
- The Leader keeps it in a separate worktree, not in any code checkout:

  ```bash
  git fetch origin
  git worktree add ../<repo>-team team/<project>               # branch exists
  git worktree add --orphan -b team/<project> ../<repo>-team   # first mission (git 2.42+)
  ```

- Only the current-epoch Leader commits and pushes to it, and never force-pushes. If a push is rejected, fetch and read `roster.md`: a higher epoch there means another Leader took over, so stand down and tell the Owner; otherwise rebase the ledger commit and push again.
- Repositories whose CI runs on every branch should exclude `team/**`.
- Workers never write to it; they read pinned refs:

  ```bash
  git fetch origin team/<project>
  git show <sha>:wp/17.md
  ```

## Pinned references

Every `ASSIGN` / `REDIRECT` that points into the ledger uses `REF:team/<project>@<sha>:<path>` (e.g. `REF:team/wms@3f9c2e1:wp/17.md`). Commit and push first, then send. A Worker reads exactly that version, so a later edit cannot silently change its brief; a changed brief needs a new `REDIRECT` with a new ref.

## Files

| File | Content |
|---|---|
| `mission.md` | Goal, non-goals, constraints, acceptance criteria, assumptions, open questions, status (`INTAKE` / `PLANNED` / `APPROVED` / `RUNNING` / `REPORTED` / `CLOSED`) |
| `plan.md` | Work package table: id, title, owner, depends on, parallel group, reviewer, `DUE`, status, receipt IDs |
| `wp/<id>.md` | One work package brief (template below) |
| `roster.md` | Members: id, address (`<machine>/<name>` on herdr), agent kind, session, `created_by`, role, workspace, state (`ACTIVE` / `AFK` / `LOST` / `LEFT`), current package, authorized peer contacts, last received receipt ID; Leader epoch `E`, `FO`, transport |
| `decisions.md` | Owner answers (`BY:owner`) and delegated decisions (`BY:profile` / `BY:decision:<id>`), dated, with reason |
| `owner.md` | Project owner profile and delegated authority (Owner-confirmed) |

## Work package template

```markdown
# WP-<id>: <title>
Mission: mission.md@<sha>   Owner: <worker>   Reviewer: <worker|none>

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

A **scout** package has a read-only goal and a report deliverable (affected areas, risks, suggested split, contracts to fix first); its acceptance criterion is "the Leader can plan from it".

## Mission template

```markdown
# Mission: <title>   Status: INTAKE
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
- ...
Never delegated: destructive actions, deploys, access control, merges, scope beyond the mission.
```
