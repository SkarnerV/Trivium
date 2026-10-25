# Trivium

A desktop workspace for coding, research and writing, built on the pi SDK
(`@earendil-works/pi-coding-agent`). Each app (Code, Research, Write) is its own agent
profile: its own tools, an addition to the system prompt, and its own extension folder.
Sessions are ordinary pi sessions in `~/.pi/agent/sessions`, so they also open in the pi CLI.

## Run

Configure a provider in pi first (`pi`, then `/login`). Then:

```sh
npm install --ignore-scripts
node node_modules/electron/install.js
npm start
```

`npm run check` type-checks the project.

## Layout

- `src/main/` Electron main process. `host.ts` owns every live `AgentSession`; sessions keep
  running when you switch session or app. `transcript.ts` turns pi messages and events into
  runs (prompt, steps, answer). `dialogs.ts` bridges extension `select`/`confirm`/`input`/`editor`
  to the window. `apps.ts` defines the three profiles. `changes.ts` records each file before the
  agent's first `edit` or `write` so the Code app's Changes panel can show net diffs, keep them,
  or revert them (changes made through `bash` are not tracked).
- `src/preload/` the `window.trivium` bridge.
- `src/renderer/` React UI.
- `~/.trivium/apps/<app>/extensions/` extensions loaded only for that app, on top of `~/.pi/agent`.
- `~/.trivium/session-apps.json` which app each session belongs to. Sessions started elsewhere show under Code.
- `~/.trivium/settings.json` app preferences: text size, idle unloading, notifications, and per app
  a model for new sessions plus extensions turned off or added. pi's own settings, logins and
  default model stay in `~/.pi/agent`.
- `~/.trivium/changes/<session-id>.json` the pre-change file contents for the Changes panel, until you keep or revert.

## Settings

`⌘,` opens Settings. Each app page lists every extension a new session in that app would load:
the app's folder, extensions added to the app, and pi's own discovery (global, packages, and the
app's most recent project). Switching one off applies when a session loads; "Reload idle
sessions" applies it to sessions already open. Models and logins logs in through pi's own login
flows, so credentials land in `~/.pi/agent/auth.json` as with the CLI.

## Keys

`⌘1/2/3` switch app, `⌘N` new session, `⌘K` search, `⌘\` fold sidebar, `⌘,` settings.
In the composer: `↵` send (steers while a run is going), `⌥↵` queue a follow-up, `esc` stop.

## Development

`TRIVIUM_DEV_FAUX=1` loads `dev/faux-extension.ts`, a scripted model (`trivium-faux/scripted`) that
reads a file, runs bash and asks a question, without a real provider. Combine with
`PI_CODING_AGENT_DIR=/tmp/somewhere` and `TRIVIUM_HOME=/tmp/elsewhere` to keep test sessions out of
your real storage. `TRIVIUM_EVAL` runs a script in the page after load and `TRIVIUM_CAPTURE=shot.png`
saves a screenshot.
