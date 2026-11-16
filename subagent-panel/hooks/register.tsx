// subagent-panel: a side pane that lists this session's subagents.
//
// Three parts, as the brief lays them out:
//   a) the agent store: `$.state` values, changed by the functions in store.ts
//   b) the collectors: hooks that watch spawns, tool calls, permission checks
//      and turn ends, and only ever pass `next(e)` on unchanged
//   c) the pane: a ui.render hook that draws the list from the store
//
// This version is read-only (build steps 1 to 6): nothing here changes what
// any agent does. Message, stop and new agent come after it.

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
  upsert,
  withAction,
  working,
} from './store'

const PANE = 'subagents'
const TITLE = 'Subagents'
const EMPTY = 'No subagents yet. Ask Claude to use subagents for a task.'
const BRIEF = 600
const USAGE =
  'Usage: /subagents (toggle the pane), /subagents list, /subagents show <name>'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Show or hide the subagent panel',
      argumentHint: '[list | show <name>]',
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

    return { text: USAGE }
  })

  // ---- Pane -------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = sorted(await read($, agents))
    const picked = await read($, selected)
    const at = await read($, now)
    const isOpen = await read($, isFinishedOpen)
    const isTerminal = e.surface === 'terminal'
    // A card's border and padding take four cells of the body.
    const columns = Math.max(12, e.props.bodyColumns - (isTerminal ? 0 : 4))

    const done = list.filter(isFinished)
    const isCollapsible = done.length > COLLAPSE_OVER
    const shown = isCollapsible && !isOpen ? list.filter(isActive) : list
    const detail = list.find(agent => agent.id === picked)

    const select = (id: string) => () =>
      update($, selected, current => (current === id ? null : id))

    const right = (agent: PanelAgent): string =>
      agent.status === 'working' ? runtime(agent, at) : WORD[agent.status]

    const row = (agent: PanelAgent) => {
      const isPicked = agent.id === picked
      const color = COLOR[agent.status]
      const side = right(agent)
      // The row also holds the mark, a space, a gap and, on the terminal, the
      // selection bar.
      const name = clip(
        label(agent),
        Math.max(8, columns - side.length - (isTerminal ? 4 : 3)),
      )
      const second = sublabel(agent)

      const head = (
        <Box justifyContent="space-between">
          <Button key={`row-${agent.id}`} plain onPress={select(agent.id)}>
            {isTerminal ? (isPicked ? '▌' : ' ') : ''}
            <Text {...(color ? { color } : {})} dimColor={isFinished(agent)}>
              {MARK[agent.status]}
            </Text>{' '}
            <Text weight={isPicked ? 'bold' : 'regular'}>{name}</Text>
          </Button>
          <Text {...(color ? { color } : {})} dimColor={color === undefined}>
            {side}
          </Text>
        </Box>
      )
      const task = (
        <Text dimColor wrap="truncate-end">
          {isTerminal ? '   ' : ''}
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
          </Box>
        )}
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
