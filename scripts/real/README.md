# Real runs of pi-subagents

`npm test` and `dev/faux-extension.ts` stand in for the pi-subagents package. These check that what they stand in for is what the package does. Both are opt-in, need no account, key or network, and leave your own Trivium profile, pi settings and sessions alone: everything is written to a folder under the system temp directory.

| File | What it is |
| --- | --- |
| `model-server.ts` | A scripted model behind a local OpenAI-compatible endpoint. A marker such as `@@writer@@` in a prompt picks the script. |
| `harness.ts` | The throwaway folders, and `SessionHost` bundled from `src/` as `npm run build` bundles it. |
| `pi-subagents.real.ts` | The automatic checks. |
| `live.ts` | The same model and folders for a built or packaged app, driven by hand. |

Run both after changing the pi-subagents version, or anything in `src/main` that reads what the package reports.

## Automatic

```
npm run test:real
node --experimental-strip-types --test --test-force-exit --test-name-pattern="lock:" scripts/real/pi-subagents.real.ts
```

About half a minute. It starts real runner processes and covers:

- **gate** — `gate` and `acceptance.verify` really run outside every tool; they are asked about by mode, and `.env` is blocked in all of them.
- **detach** — a foreground child that asks leaves its call with exit code -2, stays running across idle and reload, hears the reply, and is still refused `git push`.
- **handoffs** — a workflow's three patches, from two background children and one in this process, finishing out of order, are matched to their writers, and again after a reopen.
- **fork** — the writer's first request holds the user's earlier messages word for word.
- **async** — the turn ends at launch, the user talks to the main agent, the question is answered, the result arrives.
- **lock** — a second writer and the main agent's own changes are refused while one lives; scouts and reading go on.
- **kill** — a runner process that is killed stops counting, releases the lock and lets the session unload.
- **reload** — a live writer keeps its session loaded; after a restart it is counted and locks again from its status file.
- **ask mode** — a writer is refused before it starts, with no question to the user.

## Against a live build

```
npm run build
npm run real:live
```

It prints environment variables and the prompts it knows. In another shell, set those variables and start the app under test: `npm start`, or the packaged app (`release/win-unpacked/Trivium.exe` on Windows). Open the printed project in Code and send a prompt.

| Prompt | Mode | Look for |
| --- | --- | --- |
| `@@gate@@` | Any work mode; Approve for me | A question naming `git push`. Deny it: no subagent starts. In Bypass it is not asked. |
| `@@workflow@@` | Approve for me | A question that the workflow's commands can't be checked, with no "for this session" choice. |
| `@@ask@@` | Orchestrator | The turn ends; a row "asks the main agent", Waiting; the sidebar counts 1. Send `@@approve@@`: Answered, with the reply inside. The subagent's session shows `git push` blocked. The notice says "Reported done". |
| `@@detach@@` | Default | The same, from a foreground call. While it waits, change an extension in Settings → Code: the session is not unloaded. |
| `@@write@@`, then `@@edit@@` | Orchestrator | The edit and the second writer are refused, the scout runs. After a minute the writer reports, and `@@edit@@` writes the file. |
| `@@write@@`, then quit and reopen the app | Orchestrator | The writer is still counted, and `@@edit@@` is still refused until it ends. |
| `@@write@@`, then end its process | Orchestrator | Within a few seconds the row stops counting, and `@@edit@@` works. Its process id is in `temp/async-subagent-runs/<run>/status.json`. |
| `@@attribution@@`, and edit `src/app.ts` yourself while it runs | Any | Both files are marked "may include your edits" in Source Control; discarding one says so. |
| `@@ask@@` | Orchestrator, Always ask | Refused at once, with no question. |

In a folder without a repository, the same files are listed under This session with Revert. Delete `.git` in the printed project first to try that.
