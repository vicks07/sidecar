// subagent-panel: a side pane that lists this session's subagents.
//
// Three parts, as the brief lays them out:
//   a) the agent store: `$.state` values, changed by the functions in store.ts
//   b) the collectors: hooks that watch spawns, tool calls, permission checks
//      and turn ends, and only ever pass `next(e)` on unchanged
//   c) the pane: a ui.render hook that draws the list from the store
//
// The collectors only observe: they pass `next(e)` on unchanged. What acts on
// an agent is what the person presses or types: view transcript, message, stop
// and new agent, each at the bottom of this file's helpers.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PanelAgent, PanelStatus } from '../types'
import {
  COLLAPSE_OVER,
  MARK,
  asksPerson,
  modeWord,
  WORD,
  clip,
  countLine,
  describeAction,
  describeAsk,
  findByName,
  finished,
  firstLine,
  isActive,
  isFinished,
  label,
  patch,
  resumed,
  runtime,
  sorted,
  sublabel,
  summaryLine,
  tree,
  upsert,
  withAction,
  working,
} from './store'

const PANE = 'subagents'
const TITLE = 'Subagents'
const EMPTY = 'No subagents yet. Ask Claude to use subagents for a task.'
const BRIEF = 600
const NEW_AGENT = 'Use a subagent to '
const USAGE =
  'Usage: /subagents (toggle the pane) · list · show <name> · view <name> · ' +
  'message <name> <text> · stop <name> · new <job> · main'

// Change the tag when PanelAgent's fields change: it declines what an earlier
// version stored, which outlives a reload.
const agents = atom({ plugin: 'subagent-panel', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const selected = atom({ plugin: 'subagent-panel', key: 'selected' } as const, null)
const now = atom({ plugin: 'subagent-panel', key: 'now' } as const, 0)
const isFinishedOpen = atom(
  { plugin: 'subagent-panel', key: 'isFinishedOpen' } as const,
  false,
)

const target = atom({ plugin: 'subagent-panel', key: 'target' } as const, null)
const confirming = atom(
  { plugin: 'subagent-panel', key: 'confirming' } as const,
  null,
)

const COLOR: Record<PanelStatus, string | undefined> = {
  'needs-you': 'warning',
  working: 'suggestion',
  done: undefined,
  failed: 'error',
  stopped: undefined,
}

const END: Record<string, PanelStatus> = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

/** A collector's own work never fails the hook it runs in. */
const quietly = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // The pane misses one update; the agent is untouched.
  }
}

const scopeOf = (provider: { plugin: string; tier: string }): string =>
  provider.tier === 'core' ? 'built-in' : `${provider.tier} (${provider.plugin})`

/** Fills in what the engine's own list knows of an agent no spawn told us of. */
const known = async (
  $: EngineInterface,
  id: string,
): Promise<Partial<PanelAgent>> => {
  const info = (await $.agent.list()).find(agent => agent.id === id)

  return info === undefined
    ? {}
    : {
        type: info.type,
        task: info.description,
        ...(info.name !== undefined ? { name: info.name } : {}),
        ...(info.parentId !== undefined ? { parentId: info.parentId } : {}),
      }
}

/** Brings the store in line with the engine's list: ends we did not hear. */
const reconcile = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list()
  const at = await $.clock.now()

  await update($, agents, list => {
    let next = list

    for (const info of listed) {
      const end = END[info.status]
      const mine = next.find(agent => agent.id === info.id)

      if (mine === undefined) {
        if (end === undefined) {
          next = upsert(next, info.id, at, agent => agent, {
            type: info.type,
            task: info.description,
            ...(info.name !== undefined ? { name: info.name } : {}),
          })
        }
      } else if (end !== undefined && isActive(mine)) {
        next = patch(next, info.id, agent => finished(agent, end, at))
      }
    }

    return next
  })
}

let ticks = 0

/** Once a second while an agent runs: moves the pane's clock on. */
const tick = async ($: EngineInterface): Promise<void> => {
  const list = await read($, agents)

  if (!list.some(isActive)) {
    return
  }

  ticks += 1

  if (ticks % 5 === 0) {
    await reconcile($)
  }

  const at = await $.clock.now()
  await update($, now, () => at)
}

const open = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: TITLE, columns: 48 })

const why = (error: unknown): string =>
  error instanceof Error ? error.message : 'the engine refused it'

/** Puts an agent's transcript in the main view; a toast says why not. */
const viewAgent = async ($: EngineInterface, agent: PanelAgent): Promise<void> => {
  try {
    const shown = await $.ui.view({ agentId: agent.id })

    if (shown.deny !== undefined) {
      $.ui.toast(`Cannot show ${clip(label(agent), 30)}: ${shown.deny}`)
    }
  } catch (error) {
    $.ui.toast(`Cannot show ${clip(label(agent), 30)}: ${why(error)}`)
  }
}

/** Typing goes to main Claude again, and the main view shows it. */
const backToMain = async ($: EngineInterface): Promise<void> => {
  await update($, target, () => null)

  try {
    await $.ui.view({})
  } catch {
    // No main view to switch: the target is cleared all the same.
  }
}

/** Sends one message to an agent; resolves why it was not delivered, if so. */
const sendTo = async (
  $: EngineInterface,
  agent: PanelAgent,
  text: string,
): Promise<string | undefined> => {
  try {
    const sent = await $.session.send({ to: { agentId: agent.id }, text })

    return sent.isDelivered ? undefined : sent.reason
  } catch (error) {
    return why(error)
  }
}

/** Stops an agent with the TaskStop tool; resolves why it did not stop, if so. */
const stopAgent = async (
  $: EngineInterface,
  agent: PanelAgent,
): Promise<string | undefined> => {
  try {
    const ran = await $.tool.call({
      tool: 'TaskStop',
      task_id: agent.id,
      consent: `The user pressed "Yes, stop" for the subagent "${label(agent)}" in the subagent panel.`,
    })

    if (ran.deny !== undefined) {
      return ran.deny
    }

    if (ran.isError === true) {
      return ran.text ?? 'TaskStop reported an error'
    }

    const at = await $.clock.now()
    await update($, agents, list =>
      patch(list, agent.id, one =>
        isFinished(one) ? one : finished(one, 'stopped', at),
      ),
    )

    return undefined
  } catch (error) {
    return why(error)
  }
}

const confirmStop = async ($: EngineInterface, agent: PanelAgent): Promise<string> => {
  await update($, confirming, () => null)
  const failure = await stopAgent($, agent)
  const name = clip(label(agent), 30)

  return failure === undefined
    ? `Stopped ${name}.`
    : `Could not stop ${name}: ${failure}`
}

/** Starts the one line that asks main Claude for a new agent. */
const startNew = async ($: EngineInterface): Promise<void> => {
  const filled = await $.prompt.fill({ text: NEW_AGENT })

  if (!filled.isFilled) {
    $.ui.toast(`Type "${NEW_AGENT}…" in the prompt to start one.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Show or hide the subagent panel',
      argumentHint: '[list | show|view|stop <name> | message <name> <text> | new <job> | main]',
    })
    $.clock.every(1000, () => {
      void quietly(() => tick($))
    })

    return next(e)
  })

  // ---- Collectors -------------------------------------------------------

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId

    if (id !== undefined) {
      await quietly(async () => {
        const at = await $.clock.now()
        const fields: Partial<PanelAgent> = {
          type: e.subagentType,
          task: clip(e.description || firstLine(e.prompt), 120),
          ...(e.prompt.trim() !== '' ? { prompt: clip(e.prompt, BRIEF) } : {}),
          isBackground: e.background,
          scope: scopeOf(e.provider),
          ...(e.permissionMode !== undefined ? { mode: e.permissionMode } : {}),
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.parentAgentId !== undefined ? { parentId: e.parentAgentId } : {}),
          ...(started.model !== undefined ? { model: started.model } : {}),
        }

        await update($, agents, list =>
          upsert(
            list,
            id,
            at,
            agent =>
              e.resume === undefined
                ? working({ ...agent, ...fields })
                : resumed(agent, at),
            fields,
          ),
        )
        await update($, now, () => at)
        // Unasked, so the surface seats it only where there is room for it.
        void open($).catch(() => undefined)
      })
    }

    return started
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId

    if (id !== undefined) {
      await quietly(async () => {
        const at = await $.clock.now()
        const list = await read($, agents)

        if (list.some(agent => agent.id === id)) {
          await update($, agents, all =>
            patch(all, id, agent => resumed(agent, at)),
          )

          return
        }

        // A loop no spawn told us of is a row only when the engine lists it as
        // an agent: its own forks (compaction, memory) carry ids nobody lists
        // and would never be seen to end.
        const fields = await known($, id)

        if (fields.type === undefined) {
          return
        }

        await update($, agents, all =>
          upsert(all, id, at, working, {
            ...(e.text.trim() !== '' ? { prompt: clip(e.text, BRIEF) } : {}),
            ...fields,
          }),
        )
      })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId

    if (id === undefined) {
      return next(e)
    }

    const tool = String(e.tool)
    const callId = e.tool_use_id

    await quietly(async () => {
      const action = describeAction(tool, e as unknown as Record<string, unknown>)

      await update($, agents, list =>
        patch(list, id, agent => withAction(agent, tool, action)),
      )
    })

    try {
      return await next(e)
    } finally {
      // The call is over, allowed, refused or failed: it waits on nobody now.
      await quietly(() =>
        update($, agents, list =>
          patch(list, id, agent =>
            agent.status === 'needs-you' && agent.waitingOn === callId
              ? working(agent)
              : agent,
          ),
        ),
      )
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.agentId
    const callId = e.tool_use_id

    // An ask waits on you only where a person answers it, not a host.
    if (
      id !== undefined &&
      callId !== undefined &&
      verdict.decision === 'ask' &&
      e.approver === 'person'
    ) {
      await quietly(async () => {
        const question = describeAsk(
          e.tool,
          (e.input ?? {}) as Record<string, unknown>,
        )

        await update($, agents, list =>
          patch(list, id, agent =>
            // In auto and the modes that never prompt, nobody is asked.
            isFinished(agent) || !asksPerson(agent)
              ? agent
              : { ...agent, status: 'needs-you', question, waitingOn: callId },
          ),
        )
      })
    }

    return verdict
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId

    if (id !== undefined) {
      await quietly(async () => {
        const at = await $.clock.now()
        const status: PanelStatus =
          e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
        const result = clip(summaryLine(e.answer), 200)
        // Everything the turn's requests read and wrote, cached input included,
        // which is most of what an agent uses.
        const tokens =
          (e.usage?.input_tokens ?? 0) +
          (e.usage?.output_tokens ?? 0) +
          (e.usage?.cache_read_input_tokens ?? 0) +
          (e.usage?.cache_creation_input_tokens ?? 0)

        await update($, agents, list =>
          patch(list, id, agent => ({
            ...finished(agent, status, at, result),
            tokens: agent.tokens + tokens,
          })),
        )
      })
    }

    return next(e)
  })

  // ---- Messaging -------------------------------------------------------

  // One input box: while an agent is the target, the next typed message goes
  // to it instead of main Claude, and the target goes back to main Claude.
  on('prompt.submit', async ($, e, next) => {
    const id = await read($, target)

    if (
      id === null ||
      e.origin.kind !== 'composer' ||
      e.command !== undefined ||
      e.isMeta === true ||
      e.text.trim() === ''
    ) {
      return next(e)
    }

    await update($, target, () => null)
    const agent = (await read($, agents)).find(one => one.id === id)

    if (agent === undefined) {
      return next(e)
    }

    const name = clip(label(agent), 30)
    const failure = await sendTo($, agent, e.text)

    if (failure === undefined) {
      return { drop: `Sent to ${name}. Typing goes to main Claude again.` }
    }

    void $.prompt.fill({ text: e.text }).catch(() => undefined)

    return {
      drop: `Not delivered to ${name}: ${failure}. Your message is back in the prompt.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, agents)
    const id = await read($, target)
    const sending = list.find(agent => agent.id === id)
    const viewing = list.find(agent => agent.id === e.props.view.agentId)
    const agent = sending ?? viewing

    if (agent === undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const name = clip(label(agent), Math.max(12, e.props.bodyColumns - 42))

    return (
      <Box columnGap={2} flexWrap="wrap">
        <Text color="suggestion">
          {sending !== undefined
            ? `sending to ${name}`
            : `viewing ${name}: messages go to this agent`}
        </Text>
        <Button key="back-to-main" onPress={() => backToMain($)}>
          Back to main Claude
        </Button>
      </Box>
    )
  })

  // ---- Command ----------------------------------------------------------

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const list = sorted(await read($, agents))

    if (verb === '') {
      const panes = await $.ui.panes()

      if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
        await $.ui.close({ id: PANE })

        return { text: 'Subagent panel closed.' }
      }

      const opened = await open($)

      return {
        text: opened.isPlaced
          ? 'Subagent panel opened.'
          : `Subagent panel is waiting to be drawn: ${opened.reason}`,
      }
    }

    if (verb === 'list') {
      if (list.length === 0) {
        return { text: EMPTY }
      }

      const at = await $.clock.now()
      const lines = list.map(
        agent =>
          `${MARK[agent.status]} ${label(agent)} · ${WORD[agent.status]} · ` +
          `${runtime(agent, at)} · ${agent.toolCallCount} tool calls` +
          `\n  ${sublabel(agent)}`,
      )

      return { text: [countLine(list), ...lines].join('\n') }
    }

    if (verb === 'show') {
      const found = findByName(list, rest.join(' '))

      if (found === undefined) {
        return { text: `No subagent named "${rest.join(' ')}". ${USAGE}` }
      }

      await update($, selected, () => found.id)
      await open($)

      return { text: `Showing ${label(found)} in the subagent panel.` }
    }

    if (verb === 'main') {
      await backToMain($)

      return { text: 'Typing goes to main Claude.' }
    }

    if (verb === 'new') {
      const job = rest.join(' ')

      if (job === '') {
        return { text: 'Say what the agent should do: /subagents new <job>' }
      }

      void $.prompt.submit({ text: `${NEW_AGENT}${job}`, asUser: true })

      return { text: `Asked Claude to start a subagent: ${job}` }
    }

    if (verb === 'view' || verb === 'stop' || verb === 'message') {
      const isSure = verb === 'stop' && rest.at(-1) === 'yes'
      const words = isSure ? rest.slice(0, -1) : rest
      const query = verb === 'message' ? (words[0] ?? '') : words.join(' ')
      const found = findByName(list, query)

      if (found === undefined) {
        return { text: `No subagent named "${query}". ${USAGE}` }
      }

      const name = label(found)

      if (verb === 'view') {
        await viewAgent($, found)

        return { text: `Showing ${name}. /subagents main goes back.` }
      }

      if (verb === 'message') {
        const text = words.slice(1).join(' ')

        if (text === '') {
          await update($, target, () => found.id)

          return { text: `Your next message goes to ${name}.` }
        }

        const failure = await sendTo($, found, text)

        return {
          text:
            failure === undefined
              ? `Sent to ${name}.`
              : `Not delivered to ${name}: ${failure}`,
        }
      }

      if (isFinished(found)) {
        return { text: `${name} has already ended.` }
      }

      if (!isSure) {
        await update($, selected, () => found.id)
        await update($, confirming, () => found.id)
        await open($)

        return {
          text: `Stop ${name}? Press "Yes, stop" in the panel, or run /subagents stop ${query} yes`,
        }
      }

      return { text: await confirmStop($, found) }
    }

    return { text: USAGE }
  })

  // ---- Pane -------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const placed = tree(list)
    const picked = await read($, selected)
    const at = await read($, now)
    const isOpen = await read($, isFinishedOpen)
    const sendingTo = await read($, target)
    const asking = await read($, confirming)
    const isTerminal = e.surface === 'terminal'
    // A card's border and padding take four cells of the body.
    const columns = Math.max(12, e.props.bodyColumns - (isTerminal ? 0 : 4))

    // An agent is put away only once it and all it started have ended.
    const done = placed.filter(one => one.isSettled)
    const isCollapsible = done.length > COLLAPSE_OVER
    const shown =
      isCollapsible && !isOpen ? placed.filter(one => !one.isSettled) : placed
    const detail = list.find(agent => agent.id === picked)

    const select = (id: string) => async () => {
      await update($, confirming, () => null)
      await update($, selected, current => (current === id ? null : id))
    }

    const right = (agent: PanelAgent): string =>
      agent.status === 'working' ? runtime(agent, at) : WORD[agent.status]

    const row = ({ agent, depth }: { agent: PanelAgent; depth: number }) => {
      const isPicked = agent.id === picked
      const color = COLOR[agent.status]
      const side = right(agent)
      // An agent another agent started sits under it, stepped in.
      const step = Math.min(depth, 3)
      const indent = step === 0 ? '' : `${'  '.repeat(step - 1)}└ `
      const pad = ' '.repeat(indent.length)
      // The row also holds the mark, a space, a gap and, on the terminal, the
      // selection bar.
      const name = clip(
        label(agent),
        Math.max(8, columns - side.length - indent.length - (isTerminal ? 4 : 3)),
      )
      const second = sublabel(agent)

      const head = (
        <Box justifyContent="space-between">
          <Button key={`row-${agent.id}`} plain onPress={select(agent.id)}>
            {isTerminal ? (isPicked ? '▌' : ' ') : ''}
            {indent === '' ? '' : <Text dimColor>{indent}</Text>}
            <Text {...(color ? { color } : {})} dimColor={isFinished(agent)}>
              {MARK[agent.status]}
            </Text>{' '}
            <Text weight={isPicked ? 'bold' : 'regular'}>{name}</Text>
            {agent.id === sendingTo ? <Text color="suggestion"> ←</Text> : ''}
          </Button>
          <Text {...(color ? { color } : {})} dimColor={color === undefined}>
            {side}
          </Text>
        </Box>
      )
      const task = (
        <Text dimColor wrap="truncate-end">
          {isTerminal ? '   ' : ''}
          {pad}
          {second}
        </Text>
      )

      if (isTerminal) {
        return (
          <Box flexDirection="column">
            {head}
            {task}
          </Box>
        )
      }

      // Cards off the terminal: a border that marks the selection, and a third
      // line with the time running and the tool-call count.
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={isPicked ? 'suggestion' : 'subtle'}
          paddingX={1}
        >
          {head}
          {task}
          <Text dimColor size="caption">
            {runtime(agent, at)} · {agent.toolCallCount} tool calls
            {agent.lastAction === undefined ? '' : ` · ${agent.lastAction}`}
          </Text>
        </Box>
      )
    }

    const field = (name: string, value: string) => (
      <Text wrap="truncate-end">
        <Text dimColor>{name.padEnd(7)}</Text>
        {value}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text weight="bold">{TITLE}</Text>
        {list.length === 0 ? (
          <Text dimColor>{EMPTY}</Text>
        ) : (
          <Text dimColor>{countLine(list)}</Text>
        )}
        {list.length > 0 && <Text> </Text>}
        {shown.map(row)}
        {isCollapsible && (
          <Button
            key="finished"
            plain
            dimColor
            onPress={() => update($, isFinishedOpen, value => !value)}
          >
            {isOpen
              ? `${isTerminal ? ' ' : ''}▾ hide ${done.length} finished`
              : `${isTerminal ? ' ' : ''}▸ ${done.length} finished`}
          </Button>
        )}
        {detail !== undefined && (
          <Box flexDirection="column">
            <Text dimColor>{isTerminal ? '─'.repeat(columns) : ' '}</Text>
            <Text weight="bold">{label(detail)}</Text>
            {field('status', `${MARK[detail.status]} ${WORD[detail.status]}`)}
            {field('type', detail.type)}
            {detail.model !== undefined && field('model', detail.model)}
            {field(
              'tools',
              detail.tools.length === 0 ? 'none used yet' : detail.tools.join(', '),
            )}
            {field(
              'scope',
              [detail.scope, detail.isBackground ? 'background' : 'foreground']
                .filter(Boolean)
                .join(' · '),
            )}
            {detail.mode !== undefined && field('mode', modeWord(detail.mode))}
            {field(
              'ran',
              `${runtime(detail, at)} · ${detail.toolCallCount} tool calls` +
                (detail.tokens > 0 ? ` · ${detail.tokens.toLocaleString('en-US')} tokens` : ''),
            )}
            {detail.name !== undefined && detail.task !== '' && (
              <Text wrap="wrap">{detail.task}</Text>
            )}
            {detail.prompt !== undefined && (
              <Box flexDirection="column">
                <Text dimColor>asked to</Text>
                <Text wrap="wrap">{detail.prompt}</Text>
              </Box>
            )}
            {detail.question !== undefined && (
              <Text color="warning" wrap="wrap">
                ! {detail.question}. Answer it in the main thread.
              </Text>
            )}
            {detail.recentActions.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>recent</Text>
                {detail.recentActions.map(action => (
                  <Text wrap="truncate-end">  {action}</Text>
                ))}
              </Box>
            )}
            {detail.result !== undefined && (
              <Box flexDirection="column">
                <Text dimColor>result</Text>
                <Text wrap="wrap">  {detail.result}</Text>
              </Box>
            )}
            <Text> </Text>
            {asking === detail.id ? (
              <Box columnGap={2} flexWrap="wrap">
                <Text color="warning">Stop this agent?</Text>
                <Button
                  key="stop-yes"
                  plain
                  hotkey="y"
                  onPress={async () => {
                    $.ui.toast(await confirmStop($, detail))
                  }}
                >
                  Yes, stop
                </Button>
                <Button
                  key="stop-no"
                  plain
                  hotkey="c"
                  onPress={() => update($, confirming, () => null)}
                >
                  Cancel
                </Button>
              </Box>
            ) : (
              <Box columnGap={2} flexWrap="wrap">
                <Button
                  key="act-view"
                  plain
                  hotkey="v"
                  onPress={() => viewAgent($, detail)}
                >
                  View transcript
                </Button>
                <Button
                  key="act-message"
                  plain
                  hotkey="m"
                  onPress={() =>
                    update($, target, current =>
                      current === detail.id ? null : detail.id,
                    )
                  }
                >
                  {sendingTo === detail.id ? 'Cancel message' : 'Message'}
                </Button>
                {isActive(detail) && (
                  <Button
                    key="act-stop"
                    plain
                    hotkey="s"
                    onPress={() => update($, confirming, () => detail.id)}
                  >
                    Stop
                  </Button>
                )}
              </Box>
            )}
            {sendingTo === detail.id && (
              <Text color="suggestion" wrap="wrap">
                Your next message goes to this agent. Type it in the prompt.
              </Text>
            )}
          </Box>
        )}
        <Text> </Text>
        <Button key="new-agent" plain hotkey="n" onPress={() => startNew($)}>
          New agent
        </Button>
        {list.length > 0 && isTerminal && (
          <Text dimColor>
            {e.props.isFocused
              ? 'tab select · enter details · esc back'
              : 'ctrl+x tab: focus · click: details'}
          </Text>
        )}
      </Box>
    )
  })
}
