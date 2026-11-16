# Orchestrator mode: observing a split task

This spec goes with [mockups.html](mockups.html) (mockups numbered 1–16, plus 1b).

## Owner decisions (these override the text and the mockups below wherever they differ)

Decided after review. Where a section or a mockup says otherwise, this list wins.

1. **Wording.** Status text says "the main agent". Only the mode picker says "Orchestrator".
2. **All children show.** Up to 8 rows, in launch order, never collapsed or reordered.
3. **Panel closed.** The pane-header button (§6.1) is the signal. No row above the composer.
4. **"Now", not "Next".** §6.4 item 5 is replaced: the Agents tab shows a **Now** line stating what the main
   agent is actually doing, read from the run's current step with the same logic as the thread's live line
   (`Now: applying api's patch`, `Now: running npm test`, `Now: waiting for 3 agents`, `Now: writing the
   answer`), and under it the main agent's latest note in one line. It never predicts a later step. The
   mockups' "Next:" line is not built.
5. **Agents tab is added, not selected.** On the first multi-child fan-out the tab is added with its live dot.
   It is never switched to automatically (answers open question 1).
6. **The plan is required.** The Orchestrator instructions tell the agent to pass `options.preflight`, one
   lane per child, with `claims` for writers (answers open question 2).
7. **Foreground fan-outs.** Writer and reviewer fan-outs launch with `async: false`, one workflow call per
   phase, so the main agent can apply patches and run checks between phases (answers open question 3).
8. **Four at a time.** The instructions cap a workflow fan-out at 4 running children (answers open question 9).
9. **Tokens, not dollars.** This view shows tokens and time only; money stays in Settings → Usage. The
   mockups' dollar amounts are not built (answers open question 5).
10. **Draft-only buttons stay.** `Ask about this`, `Don't apply this` and `Ask the agent to clean it up` put a
    draft in the message box and do nothing else.
11. **Smaller first version.** v1 is: the host data (workflow children, preflight lanes, handoff manifest
    counts, `timedOut`, waiting on the main agent); the fan-out block; the work-mode picker and its setting;
    the pane-header button; the sidebar agent count and `Needs you`; the Agents tab with child detail,
    including a writer's branch, change counts, file list and patch in the diff view; problem states 8.1, 8.2,
    8.4, 8.5, 8.6, 8.7 and the run-level part of 8.8. Moved to **v1.1**: the applied / not applied state
    (§7.2), the overlap warning (§7.3), the "Checked after applying" list, per-child limit classification, and
    everything §13 already lists under v1.1. Denied-action display (§8.3) waits for the permission-gate work.
12. **Applied state, when it comes, is inferred from the agent's steps only.** The host runs no `git apply`
    check (answers open question 4).

Design spec for how a Code session shows the user a task the agent has split across subagents. The concept
(two work modes, the agent splits, one writer by default, parallel writers in worktrees, the main agent applies
patches and tests) is decided; this spec covers what the user sees.

Legend used throughout:

- **v1**: in the smallest shippable version. **v1.1**: soon after, same data. **Later**: needs new data or a decision.
- **Data**: `P:` an existing protocol field (`src/shared/protocol.ts`), `M:` a field the extension already
  produces in its details or handoff manifest (`node_modules/pi-subagents/src/shared/types.d.ts`) that the host
  doesn't read yet, `N:` new, with what it needs.
- **Needs verification**: an assumption the implementer has to check against a real run before relying on it.
- **[n]**: the mockup in `mockups.html` that shows it.

---

## 1. Principles

1. **One story, told in the conversation.** The thread stays the record of what happened. A fan-out is a step,
   like any other step, that has more to say.
2. **One place that doesn't scroll away.** A single **Agents** tab in Code's side panel holds the overview of the
   current task. No strip above the composer, no floating dock.
3. **The plan before the work.** Before any child starts, the user can see the parts, who gets each, and which
   ones write.
4. **Status is shape and word, not just color.** Every state has a mark, a word and an accessible label. Color
   backs them up.
5. **Name what needs the user, and only that.** Most states are information. Only a question card (or something
   the host can't fix by itself, such as a kept worktree) gets the "needs you" treatment.
6. **Cost is a fact, not an alarm.** Tokens and time sit in the quiet mono meta column, like today's
   `subagent-usage`.
7. **The words work in both modes.** Default sessions run subagents too, so status copy says "the main agent",
   not "the orchestrator". Only the mode picker says "Orchestrator".

---

## 2. Information architecture

| The user asks | Where they look first | In depth |
|---|---|---|
| Is this session in Orchestrator? | Composer mode picker (tinted label) [1] | Settings → Code [1b] |
| What was the task split into, and why? | Thread: the main agent's announcement, then the fan-out block in its **plan** state [2] | Agents tab → **Plan** [7] |
| Who is working on what right now? | Thread: live fan-out rows [3, 4] | Agents tab rows → child detail [7, 9] |
| Who is waiting, blocked, done or failed? | Row mark + word, head counts, segment bar [3, 4] | Agents tab, child detail |
| What did each one change? | Step meta `+182 −40` [6], writer row meta | Child detail → **Changes** + DiffView [9] |
| Will two changes collide? | Overlap note in the fan-out block [2, 6] | Agents tab [8], child detail file tag [9] |
| Was a patch applied? Did tests pass? | Agents tab → **After the agents** [8] | The main agent's own steps in the thread |
| What is it costing? | Head time; Agents tab footer [7, 8] | Child detail usage [9] |
| What happens next? | Agents tab → **Next** line [7] | The main agent's prose |
| Does anything need me? | Question card in thread; header button; sidebar [10, 14, 15] | The card itself |

Surfaces, and nothing else:

1. **Composer work-mode picker** (+ Settings → Code default). §3
2. **Fan-out block** in the thread: an evolution of `SubagentLive` and of the subagent `StepRow`. §4–5
3. **Agents tab** in Code's side panel, with a header button that opens it. §6–7
4. **Sidebar row and mode switcher** signals. §9

---

## 3. Mode selection and presence

### 3.1 Composer picker (v1) [1, 1b]

A second `Dropdown` with `variant="ghost"`, placed **before** `PermissionPicker` in `.composer-bar`
(`Composer.tsx`, around line 341). Code only, sessions with a project (`!view.chat`: a chat has no repository and
no worktrees).

- Trigger: a new 13px icon `OrchestrateIcon` in `icons.tsx` (a fork: one node to three; the existing `SplitIcon`
  means split view) + the value.
  - Default: `Default`, in the usual `.dd-ghost` `--ink-2`.
  - Orchestrator: `Orchestrator`, in `var(--accent-text)` (`.dd-ghost.is-accent`). This tint is the session's whole
    visible presence. No banner, no badge in the header.
- Menu: two options, each with a label and a description line under it. Today's `DropdownOption.hint` renders
  as mono inline `.dd-hint`, which doesn't fit sentences. **Extend `Dropdown`** with an optional
  `description` per option, rendered as `.dd-desc` (12px, `--ink-3`, wraps; `.dd-menu` already caps width at
  320px). Options with a description align their check to the first line (`.dd-check` gets `padding-top: 3px`).
- A footnote `.dd-foot` at the bottom of the menu (new: 11.5px, `--ink-4`, top border `--line`). It exists because
  the two pickers side by side differ in scope: the permission mode is shared by every Code session, the work mode
  belongs to this session.

Copy:

| | Label | Description |
|---|---|---|
| default | **Default** | Works on the task itself, and uses subagents when it decides to. |
| orchestrator | **Orchestrator** | Splits large tasks across subagents: scouts first, one writer unless parts touch separate files, then applies and tests here. |

Menu header (`.dd-group`): `Work mode`.
Footnote: `For this session. New sessions start in {mode}. Change that in Settings → Code.`
While a run is going, the footnote starts with `Applies from your next message.` (the instruction reaches the agent
with the next prompt).

Accessible name: `Work mode: Orchestrator` (`label="Work mode"`).
Keyboard: as `Dropdown` today. No global shortcut in v1.

Placeholder: in Orchestrator, idle, the textarea placeholder becomes
`Describe the task. The agent splits it if it's large, or type / for commands`. Running placeholder unchanged.

Narrow composer (container query on `.composer` below 480px): the trigger shows the icon only (accent-tinted in
Orchestrator), value kept in `aria-label` and `title`. Do the same for the permission picker at the same time.

Forks inherit the mode. Data: `N: SessionView.workMode: "default" | "orchestrator"`, `N: trivium.setWorkMode(path,
mode)`. How the mode reaches the agent (an extension adding the instruction per prompt) is outside this spec.

### 3.2 Settings → Code (v1) [1b]

In `Settings.tsx`, a new `Group` after `PermissionsGroup`, same pattern (`Item` + `Dropdown align="right"`, the
`hint` showing the chosen option's description):

- Group title `Work mode`, description `How new Code sessions start. Each session can change it in the message box.`
- Item label `New sessions start in`, options `Default` / `Orchestrator`.

Data: `N: AppSettings.code.workMode`.

### 3.3 Presence without nagging

- The tinted picker value. That's all while idle.
- Once a fan-out has run, the **Agents** tab exists in the panel (§6) and the header button (§6.1) shows while
  anything runs. Both appear because there is work to see, not because of the mode.
- The mode is not shown in the sidebar or the pane header.

---

## 4. The split moment (v1) [2]

The real sequence: the main agent scouts (a `subagent` call, usually `scout`), says the split in a sentence or two
(a note between steps, rendered by `Steps` as `.answer`), then makes one `subagent` call with a workflow script
whose `runs.all` items carry `worktree: true` for the writers.

**There is no separate plan card.** The agent's sentence is the "why"; the fan-out block that follows starts in a
**plan state** listing the parts before any child does anything, then becomes the live block in place. Plan and
progress are one thing and nothing jumps.

### 4.1 Where the plan comes from

`M: details.preflight.lanes[]` (`WorkflowPreflight`, "display-only fanout plan supplied with a workflow launch",
accepted for raw workflow scripts): per lane `key`, `mode` (`mutation | review | scout | gate`), `decision`,
`claims` (files), `expectedOutput`, `independence`.

**Recommendation:** the Orchestrator instruction tells the agent to always pass `options.preflight`, one lane per
child, `mode: "mutation"` for writers, `claims` listing the files each writer will touch. It costs the agent a few
lines and makes this view reliable instead of parsed from prose.

Fallbacks, in order: `M: details.workflowChildren.children[]` (agent, `childId`, `state`) as children launch;
`P: Subagent.children` from `results`/`progress`; finally the single line `Starting subagents…`.

Who writes: `lane.mode === "mutation"`; else the agent being a writer by name (`worker`, `delegate`, `*-writer`);
else unknown (no role glyph). Note that `scout` has `bash` and `write` (it writes `context.md`), so "read-only"
means "not asked to change the project", not enforced. In a worktree: `N: SubagentChild.worktree`, from the
workflow item's `worktree: true` in the launch args, or the manifest's `patch.branch` once present.

### 4.2 Plan-state block

`.live-cmd.subagent-live.fanout.is-plan`: head, segment bar (all empty), one row per lane, optional notes.

Head: `{Phase} · {count summary}` + time. Examples:

- `Implementing · 2 writers in their own worktrees, 1 reviewer`
- `Implementing · 1 writer` (the default: one writer in the project folder)
- `Reviewing · 3 reviewers`

Phase word, from lane modes, else agent names:

| Lanes / agents | Phase |
|---|---|
| any `mutation`, or writer agents | Implementing |
| all `review`, or `reviewer` | Reviewing |
| all `scout`, or `scout` | Scouting |
| `gate` | Checking |
| `researcher` | Researching |
| `oracle` | Consulting |
| other or mixed readers | Delegating |

Rows (plan state): hollow mark, `AgentTag`, key (`.subagent-label`), role glyph, and in the activity column the
lane's `claims` in mono (`src/api/session.ts, src/routes.ts, +1 more`) or, without claims, the first line of the
task in `--ink-4`. Right column: `Starting`.

Role glyph (`.subagent-role`, 11px, `--ink-4`, its words in `aria-label` and `title`):

- Writer in its own worktree: **branch** glyph, `Writes in its own worktree`.
- Writer in the project folder: **pen** glyph, `Writes in the project folder`.
- Reader: no glyph; `aria-label` still says `Reads only`.

Notes under the rows (`.fanout-note`: 12px, leading icon, white on the tray background; `.warn` variant in amber):

- Planned overlap, when two lanes' `claims` share a path (warn):
  `api and web both plan to change src/routes.ts. The main agent applies their patches one at a time.`
- One writer because the folder isn't clean (§8.6).

| Element | Data |
|---|---|
| Phase | `M: preflight.lanes[].mode`, else `P: SubagentChild.agent` |
| Key | `M: lane.key` / `P: SubagentChild.label` (workflowKey) |
| Files | `M: lane.claims` |
| Role, worktree | `M: lane.mode`; `N: SubagentChild.role`, `N: SubagentChild.worktree` from launch args |
| Planned overlap | `N:` computed in the renderer from `claims` |

---

## 5. Live observation in the conversation (v1)

The block is today's `SubagentLive`, extended. As today it shows only while the fan-out step is the current step
(`LiveStep` → `SubagentLive`).

### 5.1 Head [3, 4]

`[live-dot] {Phase} · {n} of {total} finished · {extras}                {time}`

- `{n} of {total} finished` replaces `Running {n} subagents · {n} done`. Finished counts done, failed and stopped.
- Extras, only when non-zero, in this order: `· 1 failed` (`--del`, as `.steps-failed`),
  `· 1 waiting on the main agent` (amber), `· 2 stopped` (amber).
- Time: the step's elapsed time, as now.

Under the head, for 2+ children, a **segment bar** `.fanout-bar`: one 3px segment per child in launch order,
filled by state (done `--add`, running `--accent`, waiting/denied amber, failed `--del`, stopped `--ink-4`, pending
`--line`). `aria-hidden`: the head text says the same. Never animates.

### 5.2 Rows

All rows share one grid so the activity column lines up without a fixed label width:
`.fanout-rows { display: grid; grid-template-columns: 12px auto auto 14px minmax(0, 1fr) auto; column-gap: 8px }`
and each `.subagent-row` is `grid-column: 1 / -1; display: grid; grid-template-columns: subgrid` (Electron 45 has
subgrid). Columns: mark · agent tag · key · role · activity · meta. Remove the fixed `width: 96px` on
`.subagent-row .subagent-label`; give it `max-width: 120px`, ellipsis and `title`. The activity cell switches from
mono to `--sans` (12px) so prose and CJK read well; tool names inside it stay mono (`.tl`).

Marks (`.subagent-mark`, 12px box, `aria-hidden`):

| State | Mark | Activity text (exact) | Meta |
|---|---|---|---|
| pending | hollow ring | `Starting`, or `Queued · starts when a slot frees` when the extension reports it waiting on concurrency | – |
| running | accent dot + ring (as `.step.running .mark`) | `{tool} {target}`; workflow children: `{tool}` only (§11); before any tool `Starting`; between tools `Thinking` | `{n} tools · {time}` |
| waiting on main agent | amber pause | `Waiting on the main agent` + ` · {question first line}` when known | time |
| denied (still running) | accent dot, activity amber with a shield | `Denied {command} · left for the main agent` | tools · time |
| done, reader | check, `--add` | `Done · {first line of output}` | time |
| done, writer | check | `Done · {first line of output}` | `+120 −14` (`.plus`/`.minus`) once the manifest has it, else time |
| done, writer, no changes | check | `Done · no changes` | time |
| failed | ×, `--del` | `Failed · {first line of error}` | time |
| timed out | ×, `--del` | `Timed out after {time}` | – |
| stopped | small square, `--ink-4` | `Stopped`, or `Stopped · usage limit` (amber) | time |

Finished rows rest (`.finished`: agent tag `quiet`, activity at 0.85 opacity), as today.
Rows keep launch order. Nothing reorders while running.

### 5.3 One, three and eight children

- **1 child** (scout, or the single writer): today's two-line form (head + `↳ activity`), plus the role glyph after
  the agent tag for a writer and, once done, its `+/−`. [11]
- **3 children:** rows as above with the segment bar. [3]
- **8 children** (the per-call maximum): all 8 rows show. 8 × 22px is 176px, about a short command's output, and
  every child stays one glance away. [4] Nested fan-outs (depth 2) show as a count in the child's activity,
  `· 2 subagents`, not as nested rows (v1).

### 5.4 Interaction

- Each row is a `<button>` (styles reset): it opens the Agents tab on that child's detail
  (`showPanelView(path, "agents")` + selected child). Title `Show in the panel`. In a chat session (no panel) the
  click opens the step's detail in the thread instead.
- The block is not collapsible while live; it is the live line.
- Keyboard: rows are in tab order; Enter opens. Esc in the composer still stops the whole run.

### 5.5 After it finishes [5, 6]

When the fan-out ends, the block leaves and the step shows in the steps list as a row. `SubagentTarget` already
renders agent tags + `N agents`; extend `describeSubagent`:

- target: agent tags (max 3) + `{Phase} · {summary}`, e.g. `Implementing · 2 writers, 1 reviewer`
- meta: writers' total `+182 −40 · 7 files`; or `1 failed`; or tools count for readers (as now).
- A finished-fan-out note under the step row when it applies (overlap, kept worktree) [6].

Opening the step (`SubagentDetail`) shows each child as today, plus for writers one line
`+120 −14 · 4 files · pi-sub/7f3a-api` and the link `Show changes in the panel`.

When the run's answer arrives, `Steps` folds everything into `Worked for {time} · {n} steps`. Add `· {n} agents`
when the run used subagents (v1). [5]

**Receipt line (v1.1)** [5]: under the folded toggle, one line `.fanout-receipt`:
`✓ scout · ✓ api +120 −14 · ✓ web +62 −26 · ✓ 4 reviewers · Show agents`. Keeps "who did what" visible after the
fold without opening anything. Out of v1 because the Agents tab covers it.

### 5.6 Accessibility

- The block: `role="group"`, `aria-label="{Phase}, {n} of {total} finished"`.
- One visually hidden `aria-live="polite"` node per pane announces **state changes only**, never tool activity:
  `api finished`, `tests failed`, `web is waiting on the main agent`, `All 3 agents finished`.
- Row `aria-label`: `{agent} {key}, {role words}, {state word}, {activity}, {meta}`.
- Reduced motion: `.live-dot` doesn't pulse today; the running mark's ring is static; no shimmer on the head; the
  bar never animates.

---

## 6. The persistent overview: the Agents tab (v1) [7, 8]

### 6.0 Decision

**An `agents` view in Code's tabbed side panel**, opened by a header button.

| Option | Verdict |
|---|---|
| **Agents tab** (chosen) | The panel is already tabbed and resizable; `ServicesPanel` is the precedent ("things running for this session"); it has room for a child's detail and the DiffView already lives there; it costs the conversation no height. |
| Pinned strip above the composer | Competes with the tray (queued/steering), the command menu and the question card for the same space; with 8 children it either grows into the conversation or hides what matters; at 360px it shows one line, which the header button already says. |
| Summary cards | Hidden by default, 272px, meant for one-line facts that open a panel view. A fine entry point later (an **Agents** card, v1.1), not the overview. |
| Floating dock / overlay | New visual language; covers the work; poor for screen readers. |

When the panel is closed, the header button (6.1) is the persistent signal; it never scrolls away.

### 6.1 Header button (v1) [10, 15]

`AgentsButton` in `SessionPane.tsx` beside `ServicesButton`, same classes: `.changes-toggle.agents-toggle`
(`--accent-text`). Shows while the current task has children running, waiting or queued, and after it finishes
with a failure, kept worktree or overlap until the user opens the tab once.

| State | Content | Title |
|---|---|---|
| running | live dot + fork icon + `3 agents` | `3 agents working. Show them in the panel.` |
| a child waits on the main agent | amber dot + fork icon + `1 waiting` | `1 agent is waiting on the main agent.` |
| needs you (question card open) | amber dot + `Needs you` on `--warn-bg` | `The main agent is asking you something.` |
| finished with a problem | warn icon + `1 failed` / `Worktree kept` | as text |

`aria-pressed` while the panel shows Agents. Click: `showPanelView(view.path, "agents")`. In "Needs you" the click
scrolls to the question card instead of opening the panel.

### 6.2 Tab mechanics

- `PanelView` in `panels.ts` gains `"agents"`; `VIEW_ICONS.agents` (fork icon), `VIEW_NAMES.agents = "Agents"`.
- While anything runs, the tab label carries a 5px live dot after the name [7].
- The tab is **added** (not selected) the first time a session runs a multi-child fan-out. It is **selected once
  per session**, on the first writer fan-out, only if the user hasn't hidden the panel
  (`changesHidden[path] !== true`). Never switched to automatically after that. (Open question 1.)
- Closable like Services; it comes back on the next fan-out.

### 6.3 What "the current task" is

All subagent children since the user's latest prompt, including background children whose step ended at launch
and whose `SubagentNotice` hasn't arrived. Earlier tasks sit behind a quiet `Earlier tasks ({n})` disclosure at
the bottom (v1.1).

Derived in the renderer from `view.runs` (new `src/renderer/agents.ts`, `agentsOf(runs)`); the host needs no new
channel for the overview. Background children need `N: Subagent.asyncId` and `N: SubagentNotice.runId` to pair
launch and result (today a background child is `done` at launch, wrong for this view; §11).

### 6.4 Running state [7]

`.agents` (laid out like `.services`: column, gap 12px, padding 12px, scrolls).

1. **Task head** `.agents-head` (`role="status"`): first line of the user's prompt (14px, 600, 2-line clamp) and
   `Working · 6m 10s · 2 of 4 agents finished · 184k tokens`.
2. **Needs-you banner** `.agents-attn` (amber), only when it applies: `The main agent is asking you something.` +
   button `Go to question` (scrolls the thread to the question card and focuses it). Not mocked; same look as the
   kept-worktree callout [13].
3. **Plan** `.agents-plan`: heading `Plan`, the main agent's announcement as written (Markdown, 3-line clamp,
   `Show all`). Data: the note block before the first fan-out step of the task (`blocksOf` in `timeline.ts`).
4. **Phases** `.agents-phase`, one card per `subagent` call in the task, in order: number (green when done),
   phase word, counts, time, chevron. Finished phases fold to one line (`1 Scouting · scout · done · 1m 12s`);
   the current one is open. Inside, one `.agent-row` per child: same anatomy as §5.2 on two lines (line 1 mark ·
   agent · key · role · meta; line 2 activity, full width), because the panel can be as narrow as 340px.
   Background children add `· in the background` after the key.
5. **Next** `.agents-next`, one line derived from the mode's fixed protocol, not guessed:
   - writer fan-out running: `Next: the main agent applies each patch here, one at a time, then runs the checks.`
   - patches applied, no checks yet: `Next: checks in the project folder.`
   - reviewers running: `Next: the main agent reads the reviews and decides what to change.`
   - between fan-outs, run still going: `The main agent is working on it.`
   Left out in Default mode (no fixed protocol to read it from) and once the run is done.
6. **Footer** `.agents-foot` (11px mono, `--ink-4`): `4 agents · 184k tokens · $0.74 · 6m 10s · agent time 9m 40s`.
   Agent time adds up the children's durations; title attribute: `Agents work at the same time, so their time adds
   up to more than the task took.` Dollars only when reported (`M: details.totalCost`); with a subscription login,
   `Plan`, as Settings → Usage does.

### 6.5 Finished state [8, 13]

Head status: `Done · 14m 20s · 7 agents` (or `Stopped after {time}`, or `Done · 1 failed`). All phases fold.

**After the agents** `.agents-after` (tray background), shown once any writer finished:

- **Patches**: one line per writer: `api  +120 −14 · 4 files  Applied` / `Not applied yet` / `Couldn't apply` /
  `No changes` / `Patch couldn't be captured: {error}`. Data in §7.2.
- **Overlap** note (§7.3); once both patches show Applied, it softens to the info style with `Both applied.`
- **Checked after applying**: the main agent's `bash` steps after the last apply, `command  Passed in 42s` /
  `Failed in 9s` (exit code only, not interpreted). None: `No checks ran after the patches were applied.` in
  `--ink-3`, a fact, not an alarm.
- **Kept worktrees** callout (§8.7).

---

## 7. Child detail (v1) [9]

Opened from a row in the Agents tab or the thread. Drill-in inside the tab (as History → commit → file): a
`‹ All agents` back button `.agents-back`; Backspace, Alt+← and Esc go back, restoring scroll and focusing the row
it came from. One scroll, sections labelled with `.step-detail-label`:

1. **Head**: mark, `AgentTag`, key, state word, time. Under it the role line:
   `Writes in its own worktree · pi-sub/7f3a-api` (branch in mono, copy button) /
   `Writes in the project folder` / `Reads only`.
2. **Task**: full text (`.subagent-task`), 6-line clamp + `Show all`.
3. **Callouts** when they apply: waiting (§8.4), denied (§8.3), timed out (§8.2).
4. **Activity**: `recentTools` as `.subagent-steps`, each call's end time on the right (`endMs` relative to the
   child's start), the current one marked running, `+ {n} more` as today. Workflow children: tool names only live;
   the list fills in with the result.
5. **Result**: `Markdown` of `finalOutput` (`.subagent-result`), or the error (`.subagent-error`).
6. **Changes** (writers): `+120 −14 · 4 files`, then the files, each with its own `+/−` (`.change-count`,
   `.plus`, `.minus`). A file also in another child's patch carries the tag `Also changed by web` (warn). Clicking
   a file shows its hunks in `DiffView` under the list (first file with an overlap, else the first file, selected
   by default). Status line under the diff: `Applied by the main agent · 13:58` / `Not applied yet` /
   `The main agent couldn't apply it` / `Patch couldn't be captured: {error}`.
   Buttons: `Ask about this` (always), `Don't apply this` (only while `Not applied yet`), `Copy patch path`.
7. **Usage**: `{model} · {fresh|fork} context · 48k in · 6k out · 22 tools · 4m 12s` (+ `· $0.31` when reported).

`Ask about this` / `Don't apply this` **only put a draft in the composer** (as "Open in Write" does):
`About api (worker): ` / `Don't apply the api patch: `. The user finishes and sends it. This keeps "the host never
writes to git" and "reject by telling the agent" literal, and saves typing the key.

Per-child **Stop** and **Steer** (later, needs verification): the extension has `action: "interrupt"` and
`action: "steer"` with `id` + `index`, run by the agent. If the host can call them directly, put `Stop` (as
`.btn.service-stop`) in the head and a one-line steer box under Activity. Without them the design still works:
Esc stops the run, and the user can tell the main agent to stop one child.

### 7.1 Data per section

| Element | Data |
|---|---|
| agent, key, task, status, steps, tools, tokens, duration, model, context, output, error | `P: SubagentChild.*` |
| role | `M: lane.mode`; `N: SubagentChild.role` |
| branch | `M: ParallelHandoffPatch.branch`; `N: SubagentChild.worktree.branch` |
| `+/−`, file count, changed | `M: patch.insertions / deletions / filesChanged / changed` |
| file list with per-file `+/−`, diff | `N:` main process reads `patch.path` (multi-file unified diff), splits per file into the `DiffLine[]` shape the Changes diff uses; IPC `readPatch(path)` |
| patch error | `M: patch.error` |
| in/out tokens | `M: AgentProgress.inputTokens / outputTokens` |
| cost | `M: details.totalCost` (run); per child needs verification |
| step end times | `M: recentTools[].endMs`; `N: SubagentChild.steps[].endMs` |

The manifest is a file: `M: details.parallelHandoff.path` (+ `childCount`, `changedPatches`, `cleanupState`). The
main process reads it (read-only) when the step ends and on `subagent-notify`, adds `N: Subagent.handoff` to the
step, and joins children by `index` / `workflowKey`.

### 7.2 Applied or not (v1, derived)

No field says a patch was applied (the manifest's `merge` evidence is about PRs). Derive it from the main agent's
steps after the fan-out: a `bash` step whose command contains `git apply` and the patch's path or file name →
`Applied` if it succeeded, `Couldn't apply` if it failed. None yet, run still going → `Not applied yet`. Run ended
with no match → show nothing rather than `Not applied`: unknown is better than wrong (the agent may have applied
it some other way). The Orchestrator instruction should say "apply each patch with `git apply <path>`", which makes
this reliable. A read-only `git apply --check --reverse` in the host could settle it later (open question 4).

### 7.3 Overlap (v1) [2, 6, 8, 9]

Computed in the renderer from the file lists of writers in the **same fan-out** (any path in two or more
patches). Same sentence in every place:

- Fan-out block after it finishes, and the step note: `api and web both changed src/routes.ts. Applied one at a
  time, the second may not apply cleanly.` + `Show both`.
- Agents tab → After the agents.
- Child detail: per-file tag `Also changed by web`.

Variants: `api and web both changed 3 files: src/routes.ts, src/types.ts, +1 more.`;
`api, web and docs all changed src/routes.ts.` After both apply: `api and web both changed src/routes.ts. Both
applied.` (info style). Before the run, from `claims`: §4.2.

---

## 8. Problem states

All v1 unless marked.

### 8.1 Child failed [4]
- Row: × mark, `Failed · {error first line}`. Head `· 1 failed`. Step meta `1 failed` (exists).
- Detail: `Error` section (exists), plus `Failed after {time} at {tool}` with `M: progress.failedTool`.
- The main agent decides what to do; its next prose says so. No buttons.
- Data: `P: status === "error"`, `P: error`.

### 8.2 Timed out (no mockup: same row as 8.1, different words)
- Row: `Timed out after 30m`. Detail callout: `It ran out of time. What it wrote so far is below.` when
  `M: outputPartial`.
- Data: `M: SingleResult.timedOut`, `details.timedOut`, `outputPartial`; `N: SubagentChild.timedOut`.

### 8.3 Denied a risky action [10]
A child can't show a question card. When the gate would ask (rm -r, sudo, git push, outside the project) it
blocks the call; the main agent does that step where the user can answer.
- Row stays running; activity `Denied rm -r dist · left for the main agent` in amber with a shield, for 10s, then
  normal activity resumes and a small shield stays after the key until the fan-out ends.
- Detail callout: `Trivium blocked "rm -r dist" because subagents can't ask you. The main agent will do it if it's
  needed, and ask you then.`
- When the main agent then hits the gate, the usual question card appears, the header button turns to
  `Needs you`, and §9 applies.
- Data: `N: SubagentChild.denied[] { tool, target, reason }` from the child's blocked tool results. The gate's
  reason when there's no UI is fixed: `Blocked: this needs the user's approval, and no one can answer here.`
  (`permission-gate.ts`). **Needs verification**: whether Trivium's gate is loaded in child sessions at all (§11.8).

### 8.4 Waiting on the main agent (`contact_supervisor`) [3, 7, 16]
- Row: amber pause mark, `Waiting on the main agent · {question first line}`. Head `· 1 waiting on the main agent`.
  Header button `1 waiting`.
- Detail callout: `It asked the main agent: "{question}"`, and once answered, `Answered: "{reply}"` as a step in
  Activity.
- Not a "needs you" state: the main agent answers. It becomes "needs you" only if the main agent asks the user.
- Data: `P: SubagentChild.current.tool === "contact_supervisor"`; for non-workflow children the question is in
  `current.target` (`currentToolArgs`; verify it holds the message). Workflow children report no arguments, so
  the question must come from the parent side: the supervisor request is delivered to the main session (and the
  main agent's `subagent_supervisor` reply is one of its steps). **Needs verification**: what that delivery looks
  like to the host. Without it, the row says `Waiting on the main agent` alone. Paused workflow children:
  `M: workflowChildren.children[].state === "paused"`.

### 8.5 Patch failed to capture [13]
- Row: check mark, activity `Done · changes not captured` in amber.
- Agents tab → Patches: `Patch couldn't be captured: {patch.error}`; the kept-worktree callout follows.
- Data: `M: patch.error`.

### 8.6 Uncommitted changes: one writer, or the fan-out refused [11]
- **The agent chose one writer** (it saw uncommitted changes): the block shows the single writer with the note
  `One writer, in the project folder: there are uncommitted changes, and separate worktrees need a clean folder.`
  Shown when a fan-out has one writer, not in a worktree, while `P: git status` shows changes (the host already
  has it: `otherChanges`). Clean tree: no note.
- **The extension refused the group** (dirty source at allocation: "a rejected group dispatches no children";
  "isolation is never dropped automatically"): the step ends in error before any child runs. The block shows its
  plan rows at 55% opacity with `Not started` and an amber (not red: nothing broke) note:
  `Not started: the project folder has uncommitted changes, and separate worktrees need a clean folder. The main
  agent will use one writer or ask you.` (No mockup; same note style as [11].)
  Data: `P: Step.status === "error"` with no child run + the error text. **Needs verification**: the exact error
  shape for a dirty-source rejection.
- No "Commit" or "Stash" button. The host never writes to git and the agent never commits or stashes on its own.

### 8.7 Worktree kept after the run [13]
- Agents tab, warn callout: `1 worktree was kept: {reason}.` + path (mono, ellipsis) + `Copy path` +
  `Ask the agent to clean it up` (draft: `Clean up the kept worktree at {path} if it's no longer needed.`).
- Header button `Worktree kept` until the tab is opened once.
- Data: `M: cleanup.state === "partial"`, `cleanup.tasks[] { path, branch, preserved, reason, errors }`.

### 8.8 Usage limit mid fan-out [12]
- **Provider limit**: children fail with the provider's message. Rows `Stopped · usage limit` (amber, square
  mark); head `· 2 stopped`. Block note, reusing `LimitNotice` wording and link:
  `Your {provider} usage limit ran out at 14:02. 2 agents stopped; the one that finished kept its work. It resets
  at 17:00.` + `Check usage`. The main run's own limit footer shows as today if it hit it too.
  Data: `P: Run.limit`; per child `N:` run the child's error through `limits.ts`'s matcher.
- **Subagent budget** (pi-subagents' own token/cost budget; no mockup): `The subagent budget of {n} tokens ran out.
  Agents that hadn't finished were stopped.` Data: `M: details.usageBudget.exhausted`, `.reason`; workflow
  `terminalOutcome.reason === "budget_exhausted"`.

### 8.9 Needs attention / stalled (v1.1, no mockup)
- Row activity adds ` · no activity for 4m` in amber; detail callout `It hasn't done anything for 4 minutes.`
- Data: `M: AgentProgress.activityState === "needs_attention"`, `lastActivityAt`.

---

## 9. Attention when the user is elsewhere (v1) [14, 15]

### 9.1 Sidebar row (`Sidebar.tsx`, `SessionRow`)
- Running with children: `.running-meta` becomes `[live-dot] [fork]3 · 4:12`; the count is children running or
  waiting now. `aria-label="3 agents working"` on the count.
  Data: `N: SessionSummary.agents?: { running: number; waiting: number }` from the main process, which already
  sees each session's live steps.
- Needs you (a question card open; already raises a notification): the dot turns amber (`.live-dot.attn`) and the
  timer is replaced by `Needs you` (`--warn`, 11px, 500). Applies to any Code session waiting on a question, with
  or without subagents. `aria-label`: `{title}, needs your answer`. Data: `N: SessionSummary.needsYou`.
- Waiting on the main agent: no change in the sidebar; the main agent is handling it.

### 9.2 Mode switcher
`.busy-dot` on another mode's button (exists) turns amber when a session in that mode needs the user; its
`aria-label` adds `· a session needs you`. No count.

### 9.3 Notifications
Existing: a background session's question card notifies. Add (v1.1) one notification when a writer fan-out
finishes in a session that isn't shown: `{title}: 3 agents finished. The main agent is applying their changes.`
Never per child.

---

## 10. Cost

- Per child: `{n} tools · {time}` in the row meta while running; tokens in/out and cost in the detail.
  The thread row has room for one number family; time is the one people read.
- Per fan-out: block head time; the opened finished step shows `3 agents · 156k tokens · $0.62` under the children
  (`.subagent-usage`).
- Per task: Agents tab footer: `7 agents · 412k tokens · $1.84 · 14m 20s · agent time 31m`.
- Settings → Usage should count children; **needs verification** that `usage.ts` reads child usage.
- No charts, no red when it's expensive. Mono, `--ink-4`.

Data: `P: SubagentChild.tokens, durationMs`; `M: inputTokens/outputTokens, details.totalChildUsage,
details.totalCost`.

---

## 11. Data: what the host must add, and what the brief got wrong

```ts
interface SubagentChild {
  // existing ...
  role?: "writer" | "reader";
  worktree?: { branch?: string; path?: string };
  patch?: { changed: boolean; files: number; insertions: number; deletions: number; path: string; error?: string };
  waiting?: { question?: string };          // current tool is contact_supervisor
  denied?: { tool: string; target: string; reason: string }[];
  timedOut?: boolean;
  stopped?: boolean;
  inputTokens?: number; outputTokens?: number;
  steps: { tool: string; target: string; endMs?: number }[];
  background?: boolean;
  runId?: string;
}
interface Subagent {
  // existing ...
  workflow?: boolean;
  plan?: { key: string; mode?: "mutation" | "review" | "scout" | "gate"; claims?: string[]; decision?: string }[];
  handoff?: { path: string; changedPatches: number; cleanup: "complete" | "partial";
              kept: { path: string; branch: string; reason?: string }[] };
  usage?: { tokens: number; costUsd?: number };
  budgetExhausted?: "tokens" | "costUsd";
  asyncId?: string;
}
interface SubagentNotice { runId?: string }                 // pairs with Subagent.asyncId
interface SessionSummary { agents?: { running: number; waiting: number }; needsYou?: boolean }
interface SessionView { workMode: "default" | "orchestrator" }
```

Found while reading the code and the extension, against the brief:

1. **Worktree isolation only exists in workflow scripts.** `worktree: true` goes on `runs.run` / `runs.all` items,
   or `{ workflow: true, worktree: true }` for all children. Top-level `tasks` / `parallel` aren't supported unless
   `workflow-scripts` is disabled. Every parallel-writer fan-out is a workflow call.
2. **The host doesn't read workflow children.** `subagentOf` reads `details.results` and `details.progress`; a
   workflow's live children come in `details.workflowChildren.children[]` (`childId`, `agent`, `state`,
   `activity`). A running workflow fan-out today most likely shows the one-line `workflow` fallback with no rows.
   **Needs verification on a real run**, and is the first thing to build.
3. **Workflow child activity has no tool arguments and no task text** ("arguments and transcripts are not
   forwarded"). Live rows can say `edit · 14 tools`, not `edit src/api/session.ts`. `claims` fill "what is it
   working on"; task text arrives with `results`, or from the script.
4. **Workflows may run in the background by default.** The docs say to pass `async: false` "only when the parent
   must block", which suggests async is the default for watched workflows. A background workflow ends its step at
   launch: no live rows, results as `subagent-notify`. The Orchestrator instruction should launch writer fan-outs
   with `async: false` (the main agent has to wait to apply anyway; blocking workflows also get the 30-minute
   default timeout). **Needs verification.**
5. **There is a structured plan**: `options.preflight` (display-only lanes with `mode` and `claims`). The brief
   assumed only prose.
6. **The manifest gives counts, not file names.** `ParallelHandoffPatch` has `filesChanged`, `insertions`,
   `deletions`, `diffStat` and the patch `path`; file names for the list and for overlap need the patch parsed.
7. **"4 at a time" doesn't hold for workflows.** `concurrency: 4` / `maxTasks: 8` are the `parallel` settings.
   Workflow children are bounded by `globalConcurrencyLimit` (default 20) and `maxSubagentSpawnsPerRun`, so an
   8-child workflow likely runs all 8 at once unless the script sets `globalConcurrencyLimit`. The design works
   either way; "Queued" is shown only when the extension reports a child waiting.
8. **The gate and worktrees.** A worktree lives outside the project folder. If Trivium's gate runs in child
   sessions with the parent's project as its root, every worktree edit would be blocked as "outside the project".
   If it doesn't run in children, they run ungated (git push included) and the "denied" story doesn't happen.
   Either way, check before shipping (open question 6).
9. **Scouts aren't read-only by construction.** `scout` declares `bash` and `write` (it writes `context.md`);
   `researcher` has `write`. "Read-only scouts" is a request in the instruction, not an extension guarantee.
10. **Background child status is wrong for an overview today**: `subagentOf` marks a background child `done` at
    launch. Fine for the step, wrong for "who is still working".
11. **Streamed child prose may exist**: `AgentProgress.recentOutput: string[]` (non-workflow children). Unused in
    v1; **needs verification** before showing it.

---

## 12. Layout and edge cases

- **Pane at 360px** [16]: container query on `.fanout` at `max-width: 420px`: the agent-tag column drops (the key
  names the child; the agent goes into the row's `aria-label` and `title`; a child with no key shows its agent tag
  in the key column), keys cap at 72px, the meta shows time only, activity ellipsizes. The segment bar stays.
- **Side panel closed**: header button + sidebar; the thread block has everything else.
- **Panel min width** `min(340px, 45%)`: rows in the panel are two-line for that reason.
- **Long text**: agent names (`claude-code-writer`) and keys ellipsize with `title`; task text clamps (3 lines in
  the plan, 6 in detail) with `Show all`; paths in the files list ellipsize; branch names ellipsize in the middle,
  since the end tells them apart.
- **zh-CN / ja** [16]: no fixed widths on translated text (the 96px label width goes). Activity cells use `--sans`,
  so CJK isn't rendered in a fallback mono. Every sentence is one `t()` string with placeholders, never assembled
  from pieces (`{a} and {b} both changed {file}.` is one key; plurals are separate keys, as the codebase does).
  The mark carries the state, so a longer phrase can ellipsize without losing it.
- **Keyboard**: in the Agents tab, rows are buttons in a `role="list"`, ↑/↓ moves (roving tabindex), Enter opens,
  Backspace/Alt+←/Esc go back. Thread rows: Tab + Enter. `Go to question` focuses the question card (its 1–9 keys
  then work). Live updates never move focus.
- **Screen readers**: §5.6; amber notes start with a visually hidden `Warning:`.
- **Reduced motion**: §5.6; no smooth scroll on `Go to question`; phase cards fold without height transitions.
- **Nested fan-out** (depth 2): a count on the child's row and `Started 2 subagents` in its detail (v1); nested
  rows later.
- **Light theme only.** Amber reuses existing values: `#8a4f06` (`.summary-row.is-pull`), `#6e3c05` on `#fdf1e1`
  (`.s-tag.warn`). Add them as `--warn`, `--warn-ink`, `--warn-bg` in `:root` rather than new colors.

---

## 13. Scope

### Smallest shippable version (v1)

1. Host: read workflow children, `preflight` lanes, the handoff manifest (counts + per-file from the patch),
   `timedOut`, `contact_supervisor` as waiting. (§11)
2. Fan-out block: plan state, head with counts, segment bar, rows with marks/role/waiting/failed/stopped, finished
   step meta with `+/−`, `· {n} agents` on the folded toggle. (§4, §5)
3. Agents tab: task head, plan, phases with rows, Next line, footer; child detail with task, activity, result,
   changes + DiffView, usage; After the agents with applied state, overlap, checks. (§6, §7)
4. Work-mode picker in the composer (Dropdown `description` + footnote) and Settings → Code default. (§3)
5. Header button, sidebar agent count and `Needs you`. (§6.1, §9)
6. Problem states 8.1–8.8 (8.3 depends on the gate question).
7. Drafts: `Ask about this`, `Don't apply this`, `Ask the agent to clean it up`.

If that's too much for one release, keep this order and cut from the bottom: host data → fan-out block → mode
picker → header button + sidebar → Agents tab without child detail → child detail. The thread block alone already
answers "who is doing what" and "what changed"; the tab adds persistence and depth.

### v1.1
Receipt line under the folded run; Agents summary card; `Earlier tasks`; watchdog "no activity"; one notification
per finished writer fan-out; icon-only pickers in narrow composers.

### Later
Per-child Stop/Steer; nested fan-out rows; read-only `git apply --check --reverse` for applied state; showing
`recentOutput`; per-child cost.

---

## 14. Rejected alternatives

- **A plan card that asks for approval**: decided out; picking the mode is the consent.
- **A separate plan card before the fan-out block**: two things saying the same plan, one of which goes stale.
- **Reordering rows by state** (running first): rows that move can't be followed by eye.
- **Folding finished or queued rows** for 8 children: saves ~60px and hides who did what.
- **Pinned strip above the composer**, **summary cards as the overview**, **floating dock**: §6.0.
- **"Apply patch" buttons**: out of v1 by decision; drafts give the user a faster way to tell the agent.
- **"Commit or stash" on the dirty-tree note**: the host never writes to git and the agent doesn't on its own.
- **A badge in the pane header**: nags; the composer trigger says it where the mode is changed.
- **Per-child colors**: collide with mode accents and diff colors; the key does the job.

---

## 15. Open questions for the owner

1. **Auto-select the Agents tab** once per session on the first writer fan-out (proposed), or only add it?
2. **Require `options.preflight`** in the Orchestrator instruction (proposed)? Without it the plan state is thin
   and "what is each one working on" falls back to tool names.
3. **`async: false` for writer fan-outs** (proposed), so they show live and the main agent waits to apply?
   Reviewers could stay in the background.
4. **Applied state**: step inference only (v1), or also a read-only `git apply --check --reverse` from the host?
   It runs git but writes nothing.
5. **Dollars** in the thread at all, or only in the tab and Settings → Usage?
6. **The permission gate in children**: does it load there, and is a child's worktree its project root? Decides
   whether "denied" exists and whether worktree writers can write at all.
7. **Scope of the two pickers**: the work mode is per session beside a permission mode that is global. Is the
   footnote enough, or should the permission menu also say `All Code sessions`?
8. **A child's question** (`contact_supervisor` with `need_decision`): should the main agent always relay product
   decisions to the user as a question card, or decide itself? It sets how often `Needs you` appears.
9. **`globalConcurrencyLimit`**: should the instruction cap workflow fan-outs at 4 (cost, rate limits), or let
   all 8 run?
