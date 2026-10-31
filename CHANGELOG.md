# Changelog

All notable changes to Trivium are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-31

### Added

- **Split view.** A session can open beside the one on screen: from **Open in split view** in its sidebar menu, by Ctrl/Cmd-clicking it, by dragging it onto either half of the window, or with Ctrl/Cmd+Shift+\, which also closes the split. The focused half has a ring and is the one the keyboard, the sidebar and the side panel act on. A handle resizes the halves, each has a close button, and each mode remembers its split across restarts. In a window too narrow for both, the focused session shows alone with tabs for both.
- **Message queue.** A message sent while the agent runs waits in a queue above the message box and goes out when the run ends, one per run. Each queued message can be steered into the running turn, deleted, or taken back into the message box to edit. Stopping a run holds the queue until you send again.
- **Accept edits** permission mode in Code: edits in the project run without asking; commands ask, except ones that only read.

### Changed

- **Trivium's own permission gate in Code.** Code no longer ships pi-permission-system. Its modes are **Always ask**, **Accept edits**, **Approve for me** (the default) and **Bypass permissions**, and each asks about nothing beyond what its description says. The mode is kept in Trivium's settings and a change reaches running sessions from their next step. `.env` files stay blocked in every mode. On first start Trivium picks the mode closest to the pi-permission-system policy you had.
- **One Changes view.** Code's Git and Changes views are combined: the session's own changes are listed under **This session**, and in a git repository the view also shows the branch, commits to push or pull, and everything else git reports under **Other uncommitted changes**.
- Fetching a built-in provider's models turns on the ones its server lists and turns off the rest, so the model picker offers only models your login is served. Models turned off stay listed in the pi CLI.
- A side panel always leaves the conversation room to read, and a wide sidebar gives way while it is open. In a diff only the lines scroll, so the file's name and buttons stay in view.

### Fixed

- Deleting one queued message no longer clears the whole queue.

## [0.3.1] - 2026-10-29

### Fixed

- **Updating from inside the app on Windows.** **Update and restart** downloaded the new version and quit Trivium, but the step that puts it in place never ran, so Trivium didn't restart and was still the old version when opened again. Copies on 0.2.5 or 0.3.0 have the broken updater and need to download 0.3.1 by hand once; updates from 0.3.1 on install from inside the app.
- On Windows, the unpacked copy of the new version that a failed update left in Trivium's folder (`.trivium-update`) is deleted when Trivium starts.

## [0.3.0] - 2026-10-29

### Added

- **Summary cards beside the conversation.** In Code sessions, one header button shows cards for Services, Git and Changes in a column beside the conversation, each with a few facts. A card opens its view, with the details, as a tab in the side panel.
- **Tabs in the side panel.** The panel holds its views as tabs, as a browser holds pages, with each previewed file in a tab of its own. Closing the last tab hides the panel.

### Changed

- Compacting a conversation, with `/compact` or automatically, no longer clears it from the screen. Earlier messages stay above a **Conversation compacted above** divider, also after reopening the session or restarting Trivium, and exported Markdown keeps them too; the agent works from the summary from there on.
- Compaction shows its progress above the message box until it finishes, automatic compaction included, and **Stop** or Esc stops it.
- A command that leaves several programs running, such as a frontend and a backend, lists one service per program, each with its own ports, address and **Stop** button.
- The Code header's branch button and its branch summary give way to the Git card. Research and Write keep their header button for the Note and Review panels.

### Fixed

- On Windows, programs started with PowerShell's `Start-Process` or cmd's `start` now show as services.

## [0.2.5] - 2026-10-28

### Added

- **Updates from inside the app.** Trivium looks for a new GitHub release at startup and every six hours. When one is out, a row above **Settings** in the sidebar offers it; one click downloads it, checks it against the release's SHA-256 checksum, swaps it in for the current copy and restarts. If the swap fails, the old version is put back. **Settings → About** shows where updating stands, has a **Check now** button and can switch the automatic check off. Copies that can't replace themselves (run from source, the portable EXE, or a folder Trivium can't write to) open the release page instead.
- **Languages.** **Settings → General → Language** offers System, English, 简体中文 and 日本語. System follows the computer's language and falls back to English. The window, toasts, errors, dialogs, notifications, menus, dates and months switch at once. The README is also available in Simplified Chinese and Japanese.
- **Services.** Processes a session's commands leave running, such as dev servers, are listed per session in a **Services** view in Code's side panel, with their command, ports, address and latest output. **Stop** ends the whole process tree, and pages open in Preview or the browser. A green dot in the header and sidebar marks sessions with services running. Services stop when their session is deleted, and on quit after Trivium asks; ones a crash left running are found on the next start.
- **Permission level in the composer.** Pick how much the agent asks before acting from the message box.

### Changed

- The permission levels are now **Always ask**, **Approve for me** (the default, asking only before what is hard to undo) and **Bypass permissions**. The level that asked before commands but not edits is gone; a config still using it shows as your own rules.
- Shortcuts use Ctrl outside macOS wherever they used only Cmd, and keys are written as Ctrl, Alt and Enter there instead of macOS symbols.
- Scrollbars are thinner.

### Fixed

- Text typed into the message box, and attached files, are kept as the session's draft when switching to another session.
- A run that recovered from a failed request, such as a retried 503, no longer shows an error card under its answer.
- A user's own memory extension that registers the same tools as the built-in `@pify/memory`, such as pi-memory, now loads instead of conflicting with it.

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

[0.4.0]: https://github.com/SkarnerV/Trivium/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/SkarnerV/Trivium/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/SkarnerV/Trivium/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/SkarnerV/Trivium/compare/v0.2.0...v0.2.5
[0.2.0]: https://github.com/SkarnerV/Trivium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SkarnerV/Trivium/releases/tag/v0.1.0
