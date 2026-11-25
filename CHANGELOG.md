# Changelog

All notable changes to Trivium are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Orchestrator uses one writer, in the background.** The writer is forked from the session, so it has your own words and corrections rather than a summary. The turn ends when it starts, so you can keep talking to the agent, which answers the writer's questions. While a writer works, Trivium refuses a second one and the agent's own edits and commands that change anything; scouts still run. In Always ask, a writer is refused at once, since no one could approve what it does. The agent no longer writes workflow scripts or splits changes over parallel worktrees on its own.
- A subagent's result says "Reported done" rather than "Finished", since nothing has checked it yet, and Orchestrator's answers name the check that ran and its exit code, or say the work is unverified.

### Fixed

- **Queued messages sometimes stayed queued after a run ended.** Stopping a run held whatever was queued later too, in other runs, with nothing to show for it; now it holds only what is queued at that moment, marks it "Held", and sending, steering, queueing or resending a message lets it go. A session opened just as its run ended could show as running for good, a command or extension that starts no run left the rest of the queue waiting, and a message queued just after the run ended waited for another one. A message on its way keeps its place in the queue and says "Sending", and the queue waits for a steer too, so neither is overtaken or put back out of order.
- **Messages sent while a run was about to start were lost.** A message sent while the context was compacted first, while extensions prepared the run, or as an extension started a run right after the last one, is now queued into that run. A message that can't be sent goes back to the queue or the message box with the error, and steering just as a run ends starts the next run instead of disappearing until then. Messages a stopped run left with pi show above the message box, and keep their session from being reloaded or put to sleep. When a run can't be prepared, what was queued into it starts a run of its own. Two messages sent at once, or one sent just as an extension starts a run, share a run instead of one being lost.
- **Stop and Delete take back messages that have not reached the model.** One still waiting for an extension or for credentials was sent after all once those were done. Stop now returns it to the queue or the message box.
- **A message that could not be sent replaced what you had typed since.** It now goes back in front of it, with its files and images, in the session it was sent from. So does an edited message whose conversation went back before the send failed, and a new session's first message.
- A command is done once what it sends has started, not when some other run does, and its session is not reloaded while it works. Settings that reload sessions no longer do so to one in the middle of an edit, and a session reloaded while it is opened or runs shows its newest state.
- An error in a notification or while updating the thread at the end of a run no longer leaves the session showing as running.
- **A subagent call could run a command past the permission gate.** The `gate` and `acceptance.verify` commands pi-subagents runs after a subagent finishes follow the same rules as the agent's own commands, also in a workflow script and a project's own agents. A workflow whose commands can't be read beforehand asks first, except in Bypass.
- A workflow's patches were not found after a real run, so neither the thread nor the agent saw them. Each is now matched to its writer by the writer's own run, the agent is told where each one is, and a writer whose patch is missing or belongs to another run is named and not integrated.
- A subagent that asked the main agent something showed as failed, stopped counting as running, and could be ended when its session went idle or its settings changed. It now stays running until it reports back, and its question and the agent's answer show in the thread.
- A background subagent whose status was late showed as gone for good. It is looked at again.
- Edits you make while a subagent or a background command works are no longer undone with the session's: such files are marked "may include your edits", reverting everything leaves them, and reverting one asks first.
- The API proxy's `/v1/models` listed models without their limits. Each one now has `context_window` and `max_output_tokens`, Anthropic's `max_input_tokens`, `max_tokens` and `capabilities`, and its input and output modalities.
- A memory file saved with Windows line endings (CRLF) showed no entries on the Memory page. Its entries now show, and adding, editing, moving, deleting and undoing keep the file's line endings.

## [0.14.0] - 2026-11-23

### Added

- **Source Control tab.** The Code panel has one Source Control tab in place of Changes and History: the branch with push and pull, a commit message box the session's model can draft, staged and unstaged files with stage, unstage and discard, merge conflicts, and every branch's history. Commits can name their session in a `Trivium-Session` trailer, which History reads back to link the session. Outside a repository it still lists the session's edits with revert and offers to initialize one.
- **Files tab.** The whole project as a tree with git status, a name filter and git-ignored folders on request.

### Changed

- In Source Control and Files, the picked file opens below the list in the same tab, as its diff or as the whole file with changed lines marked.
- Summary cards hang from the header button as one list over the thread instead of taking room beside it.

## [0.13.1] - 2026-11-18

### Added

- **Orchestrator work mode.** Each project Code session can ask the agent to scout large tasks, split independent work and use one writer by default, with parallel writers in managed worktrees. The main agent applies their patches one at a time and runs checks in the project. Pick the mode in the message box or set how new sessions start in Settings → Code; forks inherit it. Default leaves the system prompt unchanged.
- **Stop one subagent.** A subagent's session has a Stop button while it works inside a workflow or in the background. The rest of the run carries on. A subagent started on its own in the foreground stops with the turn.
- **More in a subagent's session.** Its bottom bar shows the model's thinking level, and a chip says how full its context was. Its own window is titled with the agent and the session it belongs to, and shows a writer's changes as `+113 −12 · 3 files`.

### Changed

- **Subagent views follow the new design.** Hover a subagent's row in the thread for its model, status, branch and work so far. A subagent's session opens beside the thread in place of the side panel, which comes back when you close it. The session counts steps by tool, such as `read 2 · edit 4`, and says Completed or Stopped. The header's agents menu groups subagents into this turn and earlier ones. A kept worktree shows its reason and path in the thread.

### Fixed

- Files changed by a subagent in the project now appear under This session in Changes and can be reverted. A subagent running in the background has its edits picked up when it reports back, when its run ends, or after 30 minutes at the latest; what it changes after that is left to git and is not listed or reverted here. A background subagent whose result never arrives no longer counts as running.
- Code's permission gate is required in native foreground and background children too. They read the current mode from settings, block `.env` files and deny anything that needs approval because no one can answer there. Managed worktrees use their own folder as the project root. Agents that run through another tool's command line, such as Claude Code or Codex, cannot load the gate and launch as before, under that tool's own permissions.

## [0.13.0] - 2026-11-18

### Added

- **Open subagent sessions.** Each subagent appears in the thread with its activity and elapsed time. Click it to see its conversation beside the thread, or Shift-click to open it in a separate window. The session header lists subagents from the current and earlier runs, including background agents.

### Changed

- After the final answer, progress notes and intermediate steps fold under the run's timing line. Open it to see them again.

## [0.12.0] - 2026-11-13

### Changed

- **What the agent says along the way stays in the conversation.** Text a model writes before a tool call used to stream in like the answer and then fold away with its steps once the tool started. It now stays where it was written, shown like the answer, during the run and after it. The tool calls and thinking between two such notes fold into a group of their own, and the line that times the run opens or closes every group at once. A run with nothing said along the way looks as it did.
- Each mode's system prompt tells the model this text is shown, so it keeps it to a sentence or two at turning points and puts the full result in the final reply.

### Fixed

- A project in the sidebar showed only its 8 most recent sessions, with no way to reach older ones. A **Show N more** row under them now lists the rest, and **Show less** folds them back.

## [0.11.0] - 2026-11-10

### Added

- **API proxy.** Settings → API proxy runs a local server that answers OpenAI Chat Completions requests at `/v1/chat/completions` and Anthropic Messages requests at `/v1/messages`, streaming or not, with tool calls, images and thinking. Requests go through pi's model runtime, so every provider and login set up in Trivium is reachable and credentials stay with pi. Apps connect with named keys made on the page; only each key's SHA-256 digest is kept. It listens on this computer only, on port 8787, unless the network is allowed. `tool_choice` only honours `"none"`, images must be base64, `count_tokens` is an estimate, and proxy requests are not counted in Settings → Usage.
- **Shell changes in the Changes view.** A file a bash or PowerShell command rewrote, created or deleted now shows under This session with its diff and a revert button, in a git repository or a plain folder. Checkout, pull, merge and commit record nothing; ignored files, files over 10 MB and nested repositories are left out. The project's own `.git` is never changed.
- **Zoom and pan diagrams.** A drawn diagram fits its frame at first; the wheel or a pinch zooms at the pointer, dragging moves it, and a double-click zooms in or back to fit. A bar under it has zoom out, zoom level, zoom in and fit. The image lightbox uses the same view, so transcript images zoom and drag too.
- **Diagram actions.** Hovering a diagram in a reply shows Download (SVG, or PNG at twice the size on white), Open in side panel (its own Preview tab, with the source under `</>`) and Expand.
- The Preview panel's More menu gains Show in File Explorer (Finder on a Mac).

### Fixed

- Open in VS Code works again on Windows. Trivium now starts VS Code's own executable with `--goto file:line` instead of a `vscode://` link that VS Code couldn't read or that first asked for permission in a window left behind the others.
- The Settings folder buttons say File Explorer on Windows instead of Finder.

## [0.10.0] - 2026-11-09

### Added

- **Diagrams in replies.** Fenced Mermaid and PlantUML blocks in agent replies and subagent results are drawn as diagrams, as the Markdown preview already did. A block is drawn once its fence closes, so a reply still streaming shows the code instead of redrawing a half-written diagram.
- **Open a diagram large.** Click a drawn diagram to open it in the image lightbox, shared with transcript images. A diagram scales up to 3x to fit the screen and sits on white, as it does in the thread.

### Fixed

- The update check no longer fails while GitHub's API is rate limited, which can happen to everyone behind the same proxy. It finds the latest release on GitHub's website instead and checks the download's size.
- In a narrow pane, the summary cards above the thread sat on a lavender band that the user's message showed through. The band is now white, with a short fade at its foot.

## [0.9.0] - 2026-11-06

### Added

- **Long commands move to the background.** A command still running after 10 minutes stops holding up its session: the tool call returns and the command carries on as a service, with its output in a log. When it ends, the session gets a message with the exit code and last output, and the model carries on from there. A timeout the model sets can shorten the wait, but it never kills the command. **Stop** in Services ends it, and a command is ended after 4 hours so a hung one can't run forever.
- **Turn it off per mode.** This comes as the `long-commands` extension under **Settings → Code → Extensions**. With it off, a command holds its call until it ends, and a timeout kills it, as before. The change applies when a session loads. Another extension's `bash` replaces it.

### Fixed

- On Windows, services could vanish from the list and couldn't be stopped there when one process's environment couldn't be read, even a process Trivium didn't start. Only that process is skipped now.

## [0.8.0] - 2026-11-05

### Added

- **Delete from the session menu.** Right-click a session and **Delete session** sits under **Archive session**, so a session no longer has to be archived first. It asks before deleting, moves the session to the Trash, and is unavailable while the session runs.

### Changed

- **Archived is grouped by workspace.** The Archived panel lists sessions under a heading for each folder, with a count. Hover a heading for the full path.
- **History** and **Revert all** are gone from under Changes. Open History from its summary card, and revert files one at a time with each file's own button.

### Fixed

- At **Full width**, the conversation text lined up with the message box's edges. It now keeps the same inset as the other widths.
- Clearing committed files could leave a `git diff` running in the repository when the session's last known commit no longer existed.

## [0.7.0] - 2026-11-04

### Added

- **History in Code's panel.** A new History tab draws every branch, remote branch and tag as a commit graph. Click a commit to see who wrote it, its message and the files it changed, and click a file to read its diff in that commit. A merge shows its changes against its first parent. Open it from the **History** button under Changes or from the summary cards; outside a git repository the tab says so.
- **Revert one file.** Each file under **This session** has its own revert button, which says first when reverting will delete a file the session created. The button under the list is now **Revert all**.

### Changed

- **Keep changes** is gone from Code's panel. A file now leaves **This session** once it is committed, so reverting can't undo committed work. A file changed again after its commit stays until the next one, and staged or gitignored files stay too.

## [0.6.0] - 2026-11-04

### Added

- **Archive sessions.** A session's sidebar menu now archives it instead of deleting it. Archived sessions leave the sidebar and search and wait under **Archived**, the one place to restore or delete a session.
- **Conversation width.** **Settings → General → Appearance** sets how wide the conversation and message box can grow: Standard, Wide, Extra wide or Full width.

### Changed

- Write's panel shows the document as soon as the session reads a Markdown or text file, edits any file, or a path is opened, instead of staying empty until the first change. It uses Code's tabbed panel, with a Review tab while there are edits. File paths in Write's conversation open in the panel, Open in Write opens the note it was sent from, and a panel you closed stays closed while the agent works.

### Fixed

- A dev server left running by a command that just ended still shows as a service when a read of the process list fails.
- On Windows, programs started with `Start-Process` through npm, npx, pnpm, yarn or a `.bat` file now show as services.

## [0.5.0] - 2026-11-03

### Added

- **Diagrams in the Markdown preview.** Fenced `mermaid` blocks, and `plantuml`, `puml` or `uml` blocks, in a Markdown file open in Preview show as diagrams. Mermaid draws inside Trivium and loads only when a document has a Mermaid diagram. PlantUML uses the PlantUML on your computer: the jar `PLANTUML_JAR` names, run with Java, or a `plantuml` command on your PATH. It can use its standard library, such as C4, but not other files or the network. Diagrams show as images, so they never run scripts. A diagram that can't be drawn shows its code and the reason, such as PlantUML not being installed.
- **Skills in Settings.** Each mode's Settings page lists the skills it loads, with where each comes from, its `/skill:` command and any warnings, and a switch that turns one off for that mode only. Create a skill from a name, description and instructions, edit its SKILL.md, delete it to the Trash, or upload a folder, a `.md` file or a `.zip`/`.skill` archive by button or by dropping it on the section. A mode's own skills live in `~/.trivium/apps/<mode>/skills` and replace pi's skill of the same name; **Customize** copies a built-in or package skill there to edit.

### Changed

- A queued message has its own edit button, instead of being edited from a menu.

### Fixed

- The summary cards stay in view above a long conversation in a narrow pane.

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
