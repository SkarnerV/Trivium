# Source Control and Files: one tab each, like VS Code

This spec goes with the Claude Design canvas "Trivium Source Control". Its artboards' sources are in
[canvas/](canvas/): `Main` (the Code window, clickable), `Commit`, `Graph` (History), `States` and `Files`
(clickable). They are Design Component files and render on the canvas, not opened on their own.

## Why

The Code panel's Changes tab splits files into "This session" and "Other uncommitted changes", and History is a
second tab. People expect the git workflow they know from VS Code: see what changed, stage it, write a message,
commit, push, and look back through history. pi writes nearly every change, so the panel does not mark who wrote
what; it shows what the AI did through the session each commit links to.

## Decisions

1. **One Source Control tab** replaces Changes and History in the Code panel. A **Files** tab sits beside it,
   then Services. The other apps' panels are unchanged.
2. **No authorship marks.** No per-file or per-line "pi wrote" marks, no line-share bars, no pi/you filters or
   avatars. A commit links to the session it came from instead.
3. **List and content share a tab.** In Source Control and in Files the list stays on top and the picked item
   opens below it, under a divider that drags to resize. Picking another item replaces it; the close button or
   Esc closes it and gives the list its height back. Diffs and files never open in tabs of their own.
4. **Flat.** No boxes inside the panel: one 16px left edge, single hairlines between sections, no bands or pills
   behind status text. Only menus and hover cards float.
5. **Current look.** The Code theme tokens in `src/renderer/theme.ts`, Geist and Geist Mono as `styles.css` loads
   them, the panel's 52px tab head with the underlined current tab, and the graph colors and ref tags History
   uses today.

## Source Control tab

From top to bottom:

- **Branch line:** the branch (a button that opens a branch switcher), its upstream, a **Push n** button when
  ahead, and a More menu for pull, fetch, stash and branches.
- **Message box:** a borderless field on the tray color that turns white with a soft accent outline when focused.
  Placeholder `Message (Ctrl+Enter to commit on main)`. Under it, **Draft message** (pi writes a message from the
  staged diff and the session) and a **Commit n** button, or **Commit all** when nothing is staged. Its menu:
  Commit, Commit and push, Commit and sync, Amend last commit, Undo last commit. A checkbox, on by default,
  links the session in the commit.
- **Staged** and **Changes** groups, folding, with their counts. A conflict puts **Merge conflicts** above them.
  Each row: status letter (M modified `#9a6700`, A/U added `#146c3c`, D deleted `#b4232a`, C conflict), the
  file name in Geist Mono, its folder, and `+n −n`. On hover the counts give way to Open in VS Code, Discard and
  Stage (or Unstage). Group headings carry Stage all, Unstage all and Discard all on hover.
- **History:** the graph of every branch, with an Uncommitted changes row at the top while there are any.
  Opening a commit shows its id, date, message body, `Session: <title> · n runs · Open session`, the files it
  changed, and Copy id, Compare with working tree, Revert.
- **Content pane:** a changed file's diff, or a file of the open commit in that commit. Its head has the name,
  folder, counts, a **Changes / File** switch (File is the whole file; absent for a deleted file), Open in
  VS Code, **Stage** or **Unstage**, and close.

States (artboard `States`): while pi is still editing, the message box says so and offers **Commit anyway**;
the commit button waits for the run. A merge conflict offers Open in VS Code and **Ask pi to resolve**. A clean
tree says so and offers the push. A folder with no repository offers **Initialize repository**, and pi's edits
still list file by file with revert.

The summary card beside the thread becomes one **Source Control** card: branch, to push, and
`n files changed +n −n`. It opens this tab.

## Files tab

- **Head line:** project name, `n files · n changed` (or the match count while filtering), an **Ignored** toggle
  (shows git-ignored folders such as `node_modules` and `dist`, dimmed), Collapse all, Reveal in File Explorer.
- **Filter:** `Filter files by name`, Ctrl+P. A query turns the tree into a flat list of matching files, each
  with its folder.
- **Tree:** 24px rows, 14px indent per level, folders fold. Changed files are tinted with their status letter;
  a folder with changes inside shows a dot. Hover: Open in VS Code, Mention in the message (@).
- **Content pane:** the picked file, read only, with line numbers and git's change bars in the margin (added
  green, changed amber). A changed file has the **File / Changes** switch. Markdown and HTML files can keep the
  Preview renderer's rendered view.

## What the host needs

Today `src/main/git.ts` reads status, history and diffs only. This design also needs:

- stage, unstage and discard by file (and by group), commit (with amend), push, pull, fetch, and branch switching;
- the file tree of the working directory: `git ls-files --cached --others --exclude-standard` in a repository,
  plus the ignored entries when the toggle is on, and a directory walk outside one;
- reading a file's text for the content pane, and a file's text at a commit;
- a commit trailer that names the session (for example `Trivium-Session: <session id>`), written when the
  checkbox is on and read back for History's session line;
- a message draft from the staged diff and the session, through the session's model.

The Changes tab's per-file revert of this session's edits stays available outside a repository (the `States`
artboard's last case).
