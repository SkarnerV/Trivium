# Preview panel and branch summary

Design notes. Nothing here is built yet.

Mockups: [Trivium Preview and Branch](https://claude.ai/artifact/N5YYbs5z4xmfBWJHHE148q) (Claude Design canvas, private to the owner until shared). It has three artboards: the Code window with the panel showing Preview, the branch summary in each state, and the Preview panel for each kind of file.

## Goals

- Read a file inside Trivium instead of handing it to the default app or VS Code: HTML, Markdown, images, PDFs, CSV, code and logs.
- Any file in the project, not only the ones the agent changed.
- Say plainly what the branch button's `↑2` means, which today it doesn't.

## The panel

### One panel, three views

The Code panel shows one of three views, picked from a small menu:

| View | What it shows | Today |
|---|---|---|
| **Changes** | This session's edits, with Keep and Revert | The "This session" tab |
| **Git** | The repository's staged, unstaged and untracked files | The "Git" tab |
| **Preview** | Files opened for reading | New |

The segmented "This session · Git" control goes away. In its place is a views button in the panel header that opens a **Show in panel** menu: a rounded card listing Changes (N files), Git (N files) and Preview (N open), with a check on the current one. `codeTab` in [panels.ts](../src/renderer/panels.ts) becomes `"session" | "git" | "preview"`, and the pick is remembered per session as it is today.

Research and Write can add Preview next to their Note and Review views the same way. The mockups only cover Code.

### Layout

The panel is one plain surface:

- **White, edge to edge.** No tinted tray, no bordered card inset inside it, no footer bar.
- **Header (52px, hairline below):**
  - On the left are the open files as text tabs. The selected tab is underlined in the accent color and has a close ×. At most 6 stay open, and opening a 7th drops the oldest.
  - On the right are quiet icon buttons:
    - `</>` toggles between Rendered and Source; it only appears for HTML and Markdown.
    - `…` has Open in VS Code, Open with default app, Copy path and Reload.
    - The views button opens the menu above.
    - A divider, then × closes the panel.
- **Body:** the file itself, running to the panel edges.

In the Changes and Git views, the header keeps the same right-hand buttons and shows the view's title where the file tabs would be.

### How files get opened

Opening a file switches the panel to Preview and selects its tab.

1. A file path in a step such as "Wrote report/index.html". The step row says "In preview" while that file is showing.
2. A file path in the agent's reply, once main confirms the file exists.
3. A file row in Changes or Git. Previewing is the click; VS Code moves to the `…` menu.
4. Attachments in a message.
5. A file dropped on the panel.

### What each kind of file looks like

Main picks the kind from the extension and a sniff of the first bytes.

| Kind | Shown as |
|---|---|
| `html` `htm` `svg` | The page, in an isolated frame (see Security). `</>` shows the source with line numbers. |
| `md` `markdown` `mdx` | The existing `Markdown` component in the serif reading face. `</>` shows the source. |
| `png` `jpg` `gif` `webp` `avif` | The image on a checkerboard background, with its size and dimensions underneath. |
| `pdf` | Chromium's PDF viewer in the frame. This needs checking in Electron 45; if it doesn't work there, the fallback is page images from `pi-docparser`. |
| `csv` `tsv` | A table, showing at most about 2,000 rows, with "N rows · N columns" underneath. |
| `json` | Pretty-printed text. |
| Code, logs and other text | Monospace with line numbers. Lines matching `FAIL` or `✕` in logs are shown in red. There's no syntax highlighting yet. |
| Binary, unknown, or too large | "Can't preview this file", with its size and modified time and an "Open with default app" link. |

Text files over about 2 MB show only their first lines, with a note saying so.

The empty Preview view says: **Preview a file.** Click a file path in the conversation, or a file under Changes or Git.

### Scripts in HTML

Scripts are off by default. While they are off, a yellow strip under the header says "Scripts are off for this page." with a **Run scripts** button. Turning scripts on lasts for that file until it is closed. Network access stays blocked either way.

## Security

The renderer never puts file HTML into its own DOM; `Markdown.tsx` already avoids raw HTML for this reason. HTML, SVG, images and PDFs load in a sandboxed iframe from a custom scheme:

- **Scheme.** Main registers `trivium-file` as a standard, secure scheme with `protocol.registerSchemesAsPrivileged`, so relative URLs such as `./style.css` and `../chart.png` resolve. It serves it with `protocol.handle`.
- **Tokens.** Opening a file creates a random token mapped to one root folder, either the file's folder or the project. URLs look like `trivium-file://<token>/report/index.html`. Closing the file revokes the token.
- **Path checks.** Every request is resolved with `realpath` and refused if it lands outside the root, which rules out `..` and symlink escapes.
- **CSP.** Every response sends `default-src trivium-file: data:; script-src 'none'; connect-src 'none'`. Run scripts reissues the token with `script-src trivium-file: 'unsafe-inline'` and adds `allow-scripts` to the iframe.
- **Isolation.** The iframe has no `allow-same-origin`, so it gets an opaque origin and can't reach `window.trivium`. The preload is only exposed to the main frame.
- **Navigation.** Links open in the browser through the existing `setWindowOpenHandler`. A `will-frame-navigate` guard keeps the frame on its own token.
- **App CSP.** [index.html](../src/renderer/index.html) adds `frame-src trivium-file:` and adds `trivium-file:` to `img-src`. Nothing else gets looser.

### What may be opened

`openReader` checks every request in main, in the same spirit as `readChangedFile`. A file is allowed if it is inside the session's project, in the session's changes, one of the session's attachments, or picked by the user in a file dialog. A chat with no project folder only gets the last three.

## Interface

New in [protocol.ts](../src/shared/protocol.ts):

```ts
type ReaderKind = "html" | "markdown" | "image" | "pdf" | "text" | "table" | "binary";

interface ReaderFile {
	id: string; // token
	path: string;
	rel: string;
	name: string;
	kind: ReaderKind;
	size: number;
	mtime: number;
	url?: string; // trivium-file:// for html, image, pdf
	text?: string; // markdown, text, table
	truncated?: boolean;
	scripts: boolean;
}

openReader(sessionPath: string, file: string): Promise<ReaderFile>;
reloadReader(id: string): Promise<ReaderFile>;
setReaderScripts(id: string, on: boolean): Promise<ReaderFile>;
closeReader(id: string): Promise<void>;
// HostEvent: { type: "reader-changed"; id: string }, from a debounced fs.watch
```

The main-process side is a new `src/main/reader.ts`: the token table, path resolver, kind detection, file watcher and protocol handler. In the renderer, the store gains `reader[sessionPath] = { files, active }`. When a `reader-changed` event arrives, the open file reloads, keeping the scroll position where it can.

## Branch summary

The `↑2` next to the branch means "2 commits not pushed", but nothing in the header says so.

### Button

The header button shows:

- the branch name, in monospace (`HEAD <short id>` when detached),
- a pill with the number of changed files, left out when it is 0,
- a dot: **blue** when there are commits to push, **amber** when there are commits to pull (amber wins if both), and no dot when it is in sync,
- a chevron.

Clicking it opens the summary, and clicking again, clicking outside or pressing Esc closes it. It no longer jumps to the Git view.

### Summary

The summary is a card under the button, about 360px wide:

1. **Branch:** the name with a copy button, then "Tracks `origin/main` · checked 2 min ago".
2. **Remote:**
   - "**2 commits** not pushed yet", with each commit's short id and subject indented under it.
   - "**1 commit** on the remote you don't have", in amber, with its commits under it.
   - Up to date: "Up to date with `origin/main`".
   - No upstream: "`spike/reader` isn't on a remote yet. It only exists on your computer."
   - Detached: "Not on a branch. You're at `3bb3900`. New commits here won't belong to a branch until you make one."
3. **Not committed:** three small tiles showing the staged, changed and untracked counts.
4. **Actions:**
   - **Show in Git tab**, which closes the summary and switches the panel to Git.
   - **Ask the agent to push**, shown only when there's something to push. It puts a prompt in the message box, and nothing runs until the user sends it.

### Data

- **Commits.** `GitStatus` only carries the `ahead` and `behind` counts. [git.ts](../src/main/git.ts) needs `git log --format='%h %s' @{u}..HEAD` and `HEAD..@{u}`, at most 5 commits each, with "and N more".
- **Counts.** The staged, changed and untracked counts come from `files[].area`; no new git call is needed.
- **Last checked.** "Checked … ago" is when `FETCH_HEAD` was last modified. Behind counts are only as fresh as the last fetch, and the summary says so.

## Plan

1. **Panel views:** the Show in panel menu, the simplified header, and Preview for text, Markdown and images, opened from steps and Changes. Add `scripts/reader.test.ts` for path checks (`..`, symlinks, Windows drive letters and case, UNC paths) and kind detection.
2. **HTML:** the `trivium-file` scheme, CSP, the Run scripts strip, source view and live reload.
3. **Branch summary:** the button, the summary, and commit lists in `git.ts`.
4. **More formats and entry points:** PDF, CSV tables, links on file paths in replies, attachments, dropped files, and Office files through `pi-docparser`, which needs LibreOffice.

Extend the scripted faux model to write a small HTML report with a stylesheet and an image beside it. That gives the README a screenshot and the CSP a manual check.

## Open questions

- Should the agent get a `show_file` tool that opens a file in Preview?
- Should scripts ever start on, for example for HTML this session wrote? The current answer is no.
- Should Preview's open files carry across modes? The current answer is no; they belong to the session, like the panel.
