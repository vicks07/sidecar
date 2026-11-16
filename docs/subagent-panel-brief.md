# Subagent panel for Claude Code: prompt and design

A side panel for Claude Code that lists the subagents in the current session, shows what each is doing, flags the ones that need you, and lets you message or stop one. It is built as a mod (a Claude Code plugin with a hooks module) and runs in the terminal and in the Code tab of the Claude desktop app.

Visual design (desktop and terminal boards): https://claude.ai/artifact/43WsGExBSCBUunaMJDdzN3

---

## 1. Prompt to paste into Claude Code

Open a terminal on the Mac, run `claude` in a project folder, and paste everything in the block below.

```text
Build a Claude Code mod called "subagent-panel". It adds a side pane that
lists this session's subagents, shows what each one is doing, flags the ones
that need me, and lets me message or stop one.

Before writing any code, read the current mods docs (overview, create,
interface, API, reference) and answer these four questions:
1. Which mod events fire when a subagent starts and when it finishes?
2. Does a tool-call event tell you which subagent made the call?
3. Can a button in a pane pre-fill or change the prompt input, or does
   messaging an agent have to be a typed command?
4. Can a mod stop a running subagent?
Tell me the answers and what they mean for the plan below, then start.

STRUCTURE
- A plugin directory with .claude-plugin/plugin.json, hooks/hooks.json
  (with a "modules" entry pointing to the hooks module) and
  hooks/register.js.
- Inside register.js, three parts:
  a) Agent store: an in-memory list, one entry per subagent, with
     id, type/name, task (one line), status, startedAt, finishedAt,
     toolCallCount, lastAction, recentActions (last 5), model, tools,
     result summary.
  b) Collectors: hooks that update the store on subagent start, on each
     tool call a subagent makes, on a permission request, and on
     subagent finish.
  c) Pane: a ui.render hook that draws the list from the store.

STATUSES
- working: running normally
- needs you: waiting on a permission or an answer from me
- done: finished, keep it in the list with its result
- failed: stopped with an error
- stopped: I stopped it

PANE LAYOUT
- Header: "Subagents" and a count line, e.g. "2 working · 1 waiting · 1 done".
- One row per agent: status mark, name, and on the right either the
  elapsed time or the status word. Second line: the task in one line.
- Sort order: needs you first, then working (newest first), then done,
  failed and stopped.
- Status marks: "!" needs you, "●" working, "✓" done, "×" failed or
  stopped. Never rely on color alone; always show the mark or the word.
- Selecting a row shows a details section under the list: model, tools,
  scope, and the last few actions.
- When there are no subagents, show one line: "No subagents yet. Ask
  Claude to use subagents for a task."
- When more than six agents are done, collapse them into one row,
  "5 finished", that expands on selection.

INTERACTION
- One conversation and one input box. The pane is for seeing and picking;
  typing stays in the main prompt.
- Default target is the main Claude. Selecting an agent and choosing
  "message" targets that agent for the next message, with a visible
  "sending to @name" indicator and a clear way back to main Claude.
- When an agent needs me, the question itself appears in the main thread
  and I answer it there. The pane only flags it.
- Actions on a selected agent: view details, message, stop.
- "New agent": I type one line describing the job; no form.
- If panes can't take key presses or change the prompt target, fall back
  to commands: /subagents (toggle pane), /subagents show <name>,
  /subagents stop <name>, and plain @name for messaging.

BUILD ORDER (stop after each step and let me try it)
1. Scaffold the three files, load the mod, confirm it is listed as active.
2. Record subagent start and finish in the store. Test by running three
   subagents and printing the store.
3. Read-only pane: name, status, task, elapsed time, live updates.
4. Activity: tool-call count and last action per agent.
5. Needs you: flag and sort to the top.
6. Selection and details.
7. Message, stop and new agent.
8. Collapse finished agents, show token usage per agent if available.

RULES
- Read-only first. Nothing in steps 1 to 6 should change what any agent
  does.
- Stopping an agent asks for confirmation.
- Keep everything in memory for the session; no files written outside the
  plugin directory unless I ask.
- If something in this brief isn't possible with the mods API, say so and
  propose the closest alternative instead of working around it silently.
```

---

## 2. Design

### 2.1 Layout

Two regions side by side:

| Region | Contents |
| --- | --- |
| Main chat (left, wide) | The conversation, questions from agents that need you, and the single message input |
| Subagent panel (right, narrow) | Header with counts, agent list, details of the selected agent |

On a narrow window the panel stacks below the chat.

### 2.2 Agent row

Each row shows:

- Status mark and name
- Status word or elapsed time, right-aligned
- Task in one line
- A third line in the desktop version: time running and tool-call count

### 2.3 Statuses

| Status | Mark | Meaning | Sort |
| --- | --- | --- | --- |
| Needs you | `!` | Waiting on a permission or an answer | 1 |
| Working | `●` | Running | 2 |
| Done | `✓` | Finished, result kept | 3 |
| Failed / stopped | `×` | Ended without a result | 4 |

Color supports the mark but never replaces it: orange for needs you, blue for working, grey for done.

### 2.4 Details of the selected agent

- Name
- Model, tools, scope
- Recent activity: the last three to five actions, newest last
- Actions: view transcript, edit settings, stop agent

### 2.5 Navigating and communicating

- The panel is where you see and pick. The main thread is where you type.
- By default messages go to the main Claude, which delegates to subagents and relays their results.
- Selecting an agent switches the "sending to" indicator above the input to `@agent-name`. One control switches back to main Claude.
- An agent that needs you is flagged in the panel, and its question appears in the main thread with the choices (for example "Allow edit" and "Not now").
- There is no separate chat per agent.

### 2.6 Terminal version

```
 claude  ~/projects/shop-app
 ─────────────────────────────────────────────────────────────────────
 > Refactor the login flow to use     │ Subagents
   the new session store. Use         │ 2 working · 1 waiting · 1 done
   subagents for the search, the      │
   tests and the review.              │ ▌! code-reviewer     needs you
                                      │ ▌  Wants to edit session.ts
 ● Started 3 subagents:               │  ● Explore              2m 10s
   Explore, test-runner,              │    Searching for old session code
   code-reviewer                      │  ● test-runner             40s
                                      │    Running login test suite
 ! code-reviewer needs you            │  ✓ Plan                   done
   Wants to edit auth/session.ts      │    Drafted 4 migration steps
   to rename the session cookie.      │ ──────────────────────────────
   [y] allow   [n] not now            │ code-reviewer
                                      │ model  Sonnet
 ✓ Plan finished: 4 migration steps   │ tools  Read, Grep, Edit
                                      │ last   Asked to edit session.ts
 sending to @code-reviewer (esc: back to main Claude)
 > go ahead, but keep the old cookie name
 ─────────────────────────────────────────────────────────────────────
 tab panel · ↑↓ select · enter details · m message · n new · s stop · esc back
```

Proposed keys (subject to what a mod pane allows):

| Key | Action |
| --- | --- |
| Tab | Move focus between chat and panel |
| ↑ ↓ | Select an agent |
| Enter | Show details |
| m | Message the selected agent |
| n | New agent |
| s | Stop the selected agent (asks to confirm) |
| Esc | Back to main Claude |

### 2.7 Desktop version

Same structure with cards instead of text rows: rounded rows with a status pill, a highlighted border on the selected row, and buttons for the actions. See the "Desktop" board in the design link. Press Play there and select an agent to see the details and the "sending to" switch.

### 2.8 Sample data used in the design

The agents, tasks and file names in the boards and in the terminal sketch are examples only:

| Agent | Status | Task |
| --- | --- | --- |
| code-reviewer | Needs you | Wants to edit auth/session.ts |
| Explore | Working | Searching the repo for old session code |
| test-runner | Working | Running the login test suite |
| Plan | Done | Drafted four migration steps |

---

## 3. Open questions

These decide how much of sections 2.5 and 2.6 can be built as drawn. The prompt asks Claude Code to answer them first.

1. Which mod events fire when a subagent starts and finishes.
2. Whether a tool-call event identifies the subagent that made it. Activity and "needs you" depend on this.
3. Whether a pane button can change or pre-fill the message input. If not, messaging an agent is a typed `@name`.
4. Whether a mod can stop a running subagent.

Low risk: scaffold, start and finish tracking, read-only pane (build steps 1 to 3).
Depends on the answers: activity, needs you, selection, message, stop, new agent (steps 4 to 7).

---

## 4. Decisions already made

- Watch first, control second. The first working version is read-only.
- One chat's agents only, not agents across all sessions.
- "Needs you" always sorts to the top.
- Finished agents stay in the list with their results.
- New agents are created from a one-line description, not a form.
- One input box; no per-agent chat windows.

---

## 5. References

- Mods overview: https://code.claude.com/docs/en/plugins/mods/overview
- Create a mod: https://code.claude.com/docs/en/plugins/mods/create
- Draw in the interface with a mod: https://code.claude.com/docs/en/plugins/mods/interface
- Use the mods API: https://code.claude.com/docs/en/plugins/mods/api
- Mods reference: https://code.claude.com/docs/en/plugins/mods/reference
- Create custom subagents: https://code.claude.com/docs/en/sub-agents
- Hooks reference: https://code.claude.com/docs/en/hooks
