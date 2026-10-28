# Changelog

All notable changes to Trivium are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Updates from inside the app.** Trivium looks for a new GitHub release at startup and every six hours. When one is out, a row above **Settings** in the sidebar offers it; one click downloads it, checks it against the release's SHA-256 checksum, swaps it in for the current copy and restarts. If the swap fails, the old version is put back. **Settings → About** shows where updating stands, has a **Check now** button and can switch the automatic check off. Copies that can't replace themselves (run from source, the portable EXE, or a folder Trivium can't write to) open the release page instead.

## [0.2.0] - 2026-10-28

### Added

- **Memory in every mode.** Built-in [`@pify/memory`](https://www.npmjs.com/package/@pify/memory) keeps a global `MEMORY.md`, one per project in `.pi/memory/MEMORY.md`, and a daily log, and refuses to save credentials. A **Memory** page in the sidebar shows what the agent remembers everywhere, per workspace and in the daily log, with add, edit, move to top, delete with Undo, a Recently deleted list, a load meter, and a per-workspace switch and git exclude.
- **Usage page.** **Settings → Usage** adds up tokens and estimated cost from every session over 7 days, 30 days or all time, with daily bars, breakdowns by mode, model and session, and a calendar of the last 12 months with active days and streak.
- **Connectors page.** **Settings → Connectors** manages MCP servers in pi's global `mcp.json`: add from a command, a URL or pasted `mcpServers` JSON (Claude, Cursor, VS Code), edit, remove, switch off, sign in, and choose how each server's or tool's tools reach the agent.
- **Git in Code sessions.** The header shows the branch, changed-file count and a dot for commits to push or pull; clicking it opens a plain-words branch summary. The side panel gains a Git view with staged, unstaged, untracked and conflicted files and their diffs.
- **Preview panel.** Code's side panel shows Changes, Git or Preview from a **Show in panel** menu. Preview opens project files as tabs: sandboxed HTML with network blocked, Markdown, CSV, text and images, reloading when they change on disk.
- **Reply timing.** Point at a reply to see when it was answered, how long it took, time to first token and tokens a second. The Usage page shows each model's average first-token time and output speed.
- **Queue or steer mid-run.** While a run is going, `↵` queues a follow-up and `⌥↵` steers the current run.
- **Pinning.** Pin projects and sessions from the sidebar's right-click menu. Project headers get their own menu with Pin, New session and Delete all sessions.
- **Windows ZIP builds**, which start faster than the portable EXE because the runtime is extracted once.

### Changed

- Model and thinking effort now live behind one composer button, with effort as a slider and a searchable model list.
- Code, Research and Write are called modes throughout the app. Each Settings and Memory page has its own accent color.
- The sidebar mode title is shown as an accent badge.
- The Daily log's loading rules are laid out as one card.
- An extension's info or warning notice shows once per app run; errors still show every time.
- Windows releases ship as a ZIP only; the portable EXE is no longer built.

### Fixed

- An unchanged message can be sent again as a retry, for example after a usage limit with another model.
- Picking another mode while a session is still loading no longer jumps back to that session's mode.
- A remembered session that was deleted no longer reopens as Code on every launch.
- Toasts' expand and dismiss buttons work on Windows, where the header drag region swallowed the clicks.
- A question an extension asks while its session starts now shows as a dialog instead of leaving the session unopened.
- ChatGPT plan logins list OpenAI's models again.
- A running command that has printed nothing shows "Waiting for output…" instead of an empty line.
- Long answers and questions wrap inside the ask card, and long argument hints in the command menu truncate.

## [0.1.0] - 2026-10-26

First preview release: coding, research and writing in one desktop workspace, powered by the pi agent SDK.

- Three modes with their own models, tools, extensions and running sessions.
- Live agent steps, command output, attachments, questions and approvals.
- Subagent activity, live progress, usage-limit explanations and failed-step counts.
- Copy replies, edit or fork earlier messages, and start a conversation without choosing a folder.
- Review code diffs, preview research notes with sources, and accept or reject tracked writing changes.
- Built-in provider logins, custom model endpoints, MCP support and project trust.

[0.2.0]: https://github.com/SkarnerV/Trivium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkarnerV/Trivium/releases/tag/v0.1.0
