# CLI worker markers

Decision: use plain text `CC` for **Claude Code** and `CX` for **Codex CLI**, optionally inside the dashboard's generic terminal badge. These are project abbreviations, not official logos. Keep the full harness name in an accessible label or tooltip. Do not infer the harness from the selected model/provider.

No SVG or other third-party artwork is bundled here. The official repository checks below did not establish a suitable CLI-specific SVG with clear reuse terms. No brand was redrawn or extracted from a screenshot.

## Sources checked

Checked on 2026-10-20 against pinned revisions; both GitHub recursive tree responses were complete (`truncated: false`).

| Harness | Official source | Finding |
| --- | --- | --- |
| Claude Code | [anthropics/claude-code at a6e289a2e772a17b3614a9ef43303003de5cd887](https://github.com/anthropics/claude-code/tree/a6e289a2e772a17b3614a9ef43303003de5cd887) | No SVG asset in the repository inventory. The README embeds `demo.gif`. Its [LICENSE.md](https://github.com/anthropics/claude-code/blob/a6e289a2e772a17b3614a9ef43303003de5cd887/LICENSE.md) says “© Anthropic PBC. All rights reserved” and refers to Commercial Terms of Service; this does not establish an open asset license. |
| Codex CLI | [openai/codex at e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914](https://github.com/openai/codex/tree/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914) | The [README](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/README.md) uses `.github/codex-cli-splash.png`. SVGs in the inventory belong to sample skills (`imagegen`, `openai-docs`, `skill-creator`, `skill-installer`); these do not establish a Codex CLI icon. Repository [LICENSE](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/LICENSE) is Apache-2.0; see also [NOTICE](https://github.com/openai/codex/blob/e18a20d6eb6f5ede32a69fb56e3fe276d5e9d914/NOTICE). Section 6 does not grant general trademark permission. |

This is a bounded repository check, not a claim that CLI artwork cannot exist elsewhere. Simple Icons assets were not downloaded: Claude/OpenAI provider marks would need explicit provider labeling and would not satisfy the requested harness/CLI meaning.

Downloads were inspected as data in an isolated temporary directory. No downloaded scripts were executed and no dependencies were installed. This directory does not wire markers into the dashboard.
