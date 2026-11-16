# Implementation evidence

The implementation targets the locked pi-subagents 0.82.1 package. Paths below are relative to
`node_modules/pi-subagents`; the package is not modified.

## Child permission gates

- Public export `pi-subagents/required-child-extensions` exposes `registerRequiredChildExtensions`.
  `src/shared/required-child-extensions.js` registers an immutable snapshot by parent session id.
  `requireForAllRunners` rejects external runners and remote placement, which cannot load the gate.
- `src/runs/foreground/execution.js`, `runSingleAttempt`, passes required extensions into the child launch.
  `src/runs/shared/child-session.js` creates a `DefaultResourceLoader` with `launch.cwd` and
  `launch.extensionPaths`; its `open` verifies required extension identities and fails on missing or failed loads.
- `src/runs/background/async-execution.js`, `buildSeqStep`, serializes `requiredExtensions` into runner
  steps. `src/runs/background/subagent-runner.js` carries these into child session creation. The snapshot is
  retained for resumed runs, rather than depending on a host closure.
- The managed worktree path becomes `taskCwd` in `subagent-runner.js`'s `bindWorktreeCwd` call. Foreground
  launches likewise pass the allocated cwd into `runSync`. The gate uses each extension context's `ctx.cwd`.
- The standalone `dist/child-permissions.mjs` always denies decisions that would require a question, even if
  a child exposes a UI surface. It reads Trivium's settings file each call. The parent's inline gate is retained.

## Worktree placement

`src/runs/shared/worktree.js`, `resolveWorktreeDedicatedRoot`, selects
`configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR`; an explicit `worktreeBaseDir` therefore wins.
Trivium supplies only the environment default, under its own home directory.

## Foreground supervisor limitation

The package's `docs/workflows.md` notes that awaited background children in an `async: false` workflow cannot
receive supervisor decisions while the parent is blocked. Such a request returns a tool error and asks the child
to report its blocker and stop. The UI displays paused children or an active `contact_supervisor`; it does not
promise a question is answerable while a foreground workflow blocks the parent.
