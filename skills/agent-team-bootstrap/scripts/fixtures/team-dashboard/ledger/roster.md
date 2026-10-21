# Demo team roster

E: 202610201000   FO: 0   Transport: native

| id | address | agent kind | session | created_by | role | workspace | state | current package | authorized peer contacts | last received receipt ID |
|---|---|---|---|---|---|---|---|---|---|---|
| backend-01 | local/backend-01 | Claude Code | claude-worker | owner | Worker | /work/demo | ACTIVE | 17 | qa-01 | ack-17 |
| qa-01 | local/qa-01 | Codex | codex:codex-worker | owner | Reviewer | /work/demo-review | ACTIVE | 18 | backend-01 | assign-18 |
| absent-01 | local/absent-01 | Claude Code | absent-session | owner | Worker | /work/demo-scout | LOST | 19 | — | blocked-19 |
