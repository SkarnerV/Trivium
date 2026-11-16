# Implementation evidence

The implementation targets the locked pi-subagents 0.82.1 package. Paths below are relative to
`node_modules/pi-subagents`; the package is not modified.

## Child permission gates

- Public export `pi-subagents/required-child-extensions` exposes `registerRequiredChildExtensions`.
  `src/shared/required-child-extensions.js` registers an immutable snapshot by parent session id.
  Trivium registers without `requireForAllRunners`. With it, the extension refuses every launch on an external
  CLI runner or a remote machine, which cannot load an extension; that broke the six bundled external agents
  (`claude-code`, `codex-exec`, `cursor-agent` and their writers) in Default mode, where they had launched
  before. They now launch as before, ungated by Trivium, under their own tool's permissions.
- `src/runs/foreground/execution.js`, `runSingleAttempt`, passes required extensions into the child launch.
  `src/runs/shared/child-tool-plan.js`, `resolvePiLaunchToolPlan`, unions mandatory paths into `extensionArgs` and
  refuses a capability ceiling that would deny extensions. `src/runs/shared/child-session.js`,
  `createDefaultChildSessionFactory`, creates a `DefaultResourceLoader` with `launch.cwd` and
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

## Notification and pending-manifest shapes

`src/runs/background/notify.js`, `sendCompletion` / `notifyRunDetails`, sends grouped results as
`details.runs[]`, each with `runId` and (when present) `handoffPath`. The host reads those as well as the tool's
`details.parallelHandoff.path`, and pairs background receipts by run id. `parallel-handoff.js`'s pending groups
have `laneBindings` and cleanup tasks before terminal `children` exist. These establish live worktree identity;
pending cleanup is not shown as a kept-worktree warning. Files are read at launch once and on completion,
including reopening recorded sessions; the 40ms projection only attaches cached data.

The root `usageBudget` contract in `src/extension/schemas.js` blocks new launches but does not stop running
children. The run-level notice therefore says the budget ran out and completed work is kept; it does not claim
that every unfinished child was stopped.

## Background children and their completion notices

- Launch: `src/runs/background/async-execution.js` returns `details: { asyncId: id, runId: id, asyncDir, ... }` for both
  a single background child and a background workflow (the two `details:` returns near the end of the file).
- Notice: `src/runs/background/notify.js`. `buildCompletionDetails` reads the run's result file and sets
  `runId` from `result.runId ?? result.id`, which is the same `id` as the launch's `asyncId`, plus `asyncDir`,
  `status`, `durationMs`, `handoffPath` and `childRuns`. `sendCompletion` sends
  `details: { runs: details.map(notifyRunDetails) }`, one entry per run in a grouped notice. So
  `details.runs[].runId` equals the launch's `asyncId`, and that is what the host pairs on
  (`noticeRunIds` in `delegation-hooks.ts`). A workflow's children appear under `childRuns` with their own run ids;
  they are not paired separately, since the launch step is the workflow.
- Evidence of life: `<asyncDir>/status.json` (`docs/observability.md`, "Async run artifacts"). `subagent-runner.js`
  writes `state` (`queued | running | complete | failed | partial | paused | stopped | rejected`), the runner's `pid`,
  `startedAt` and `lastUpdate`. The extension's own `stale-run-reconciler.js` (`reconcileAsyncRun`) treats a
  `running` status with a dead pid as failed, and one whose pid is alive but whose status is older than 24 hours as
  unverifiable. The host does the read-only part of that, without repairing the file: `background-runs.ts`,
  `stateFromStatus`. It reads the file only when `asyncDir` resolves to a folder named for the run directly in an
  `async-subagent-runs` folder under the extension's temp root. The rule, the 15-second launch grace, the 6-hour
  staleness bound and the 30-minute Changes window are documented there and tested in
  `scripts/background-runs.test.ts`.
- The status file is reliable for this purpose because the runner writes it on every state change and on its way
  out, and a runner that dies without writing leaves a dead pid. The cases it cannot settle (a pid reused by
  another process during the same boot) are bounded by the staleness rule.

## Where handoff files may be

`src/main/extension-paths.ts` lists the roots with the functions that define them: `TEMP_ROOT_DIR`, `ASYNC_DIR` and
`TEMP_ARTIFACTS_DIR` in `src/shared/types.js`; `getArtifactsDir` in `src/shared/artifacts.js` (`artifactDir` is
`session`, `temp` or `project`, never a path); `parallelHandoffPath` in `src/runs/shared/parallel-handoff.js`; patch
folders in `subagent-runner.js` (`<asyncDir>/worktree-diffs/step-<n>`) and `subagent-executor.js`
(`<artifactsDir>/worktree-diffs/<runId>`). The temp root's scope segment depends on the user name, so any
`pi-subagents-*` folder directly in the temp directory is accepted.

## Validation

- TypeScript: `npm run check`.
- Node suite: `npm test`, including workflow parsing, malformed details, pending and completed manifests,
  grouped notifications, per-session patch authorization, multi-file and binary patches, UTF-8 git-quoted names,
  child edit adoption/revert, permission mode from disk, worktree roots, mode persistence and prompt identity.
- `scripts/orchestrator-faux.test.ts` executes both the three-child writer workflow and the eight-child variant,
  observing their actual updates and reading their temporary handoff files. It removes its artifacts afterward.
- `npm run build` emits the standalone mandatory child extension alongside the main bundle.
- An isolated Electron renderer fixture at 360px was checked in English, Chinese and Japanese. It displayed all
  eight rows without horizontal overflow, with labeled button rows, a branch and patch in the drill-in, and
  keyboard Escape returning to the overview. Captures were visually inspected. This used rendered fixtures,
  not a provider-backed agent session.

## Try the faux extension

From this checkout in PowerShell:

```powershell
$env:TRIVIUM_DEV_FAUX = '1'
npm run dev
```

Create a Code session in a project folder, select **Trivium dev → Scripted** in the model picker, and type
`orchestrator`. It scouts, then shows two worktree writers and a reviewer; the web writer waits on the main
agent, a review fails, and a manifest contains one captured two-file patch and one capture error with a kept
worktree. Open Agents and click `api` or `web`. Type `orchestrator eight` for eight rows including a failed child
and a timeout. `subagent`, `format`, `server`, `slow`, `hang` and `diagram` keep their previous scripted stories.
The composer mode picker can be changed independently; the faux model follows its script, not the guidance.
Use a scratch project for the existing scenarios that edit files or launch a service.

## Not verified on a real run

- Provider-backed model compliance with the compact orchestration prompt, including scout-first splitting,
  preflight coverage, disjoint writer claims, foreground phases, concurrency and serial application/checks.
- Actual managed-worktree creation, cleanup and dirty-source refusal in an orchestrated task. These are owned
  by pi-subagents; its code and manifest shapes were inspected, while the faux data simulates allocation.
- End-to-end mandatory gate loading in real foreground, detached, revived and packaged children on Windows
  and macOS. Inspect that `.env` reads are blocked, risky calls return the no-UI reason, ordinary worktree edits
  succeed under Approve for me, and changing the permission mode reaches detached children on their next call.
- Real provider limits and supervisor dialogue. Confirm whether the selected child execution path can pause
  for a supervisor answer, or reports the documented foreground blocker instead.

No new dependencies, version bump, push or pull request. Research and Write receive no work-mode extension.
Applied-state tracking, overlap warnings, inferred post-application checks, dollars, predictive Next text and
denied-action display are outside this first version. There is no host-side git mutation or apply control.
