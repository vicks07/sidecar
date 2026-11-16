// The agent store's pure half: how a list of agents changes and how it reads.
// Nothing here touches the engine, so the same functions serve the collectors,
// the pane and the tests.

import type { PanelAgent, PanelStatus } from '../types'

export const RECENT = 5
export const COLLAPSE_OVER = 6

export const isFinished = (agent: PanelAgent): boolean =>
  agent.status === 'done' ||
  agent.status === 'failed' ||
  agent.status === 'stopped'

export const isActive = (agent: PanelAgent): boolean => !isFinished(agent)

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

export const firstLine = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''

/**
 * One line that says what an answer came to: its first line of prose, with
 * table rows, rules and code fences passed over and heading marks dropped.
 */
export const summaryLine = (text: string): string => {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const prose = lines.find(
    line => !line.startsWith('|') && !/^([-=*_]{3,}|```.*)$/.test(line),
  )

  if (prose === undefined) {
    return lines.length === 0 ? '' : 'Reported a table'
  }

  return prose.replace(/^#+\s*/, '').replace(/\*\*/g, '')
}

export const newAgent = (
  id: string,
  startedAt: number,
  fields: Partial<PanelAgent> = {},
): PanelAgent => ({
  id,
  type: 'agent',
  task: '',
  status: 'working',
  startedAt,
  toolCallCount: 0,
  recentActions: [],
  tools: [],
  isBackground: false,
  tokens: 0,
  ...fields,
})

/** Changes the agent with `id`, or adds it first when the list has none. */
export const upsert = (
  list: PanelAgent[],
  id: string,
  at: number,
  change: (agent: PanelAgent) => PanelAgent,
  fields: Partial<PanelAgent> = {},
): PanelAgent[] =>
  list.some(agent => agent.id === id)
    ? list.map(agent => (agent.id === id ? change(agent) : agent))
    : [...list, change(newAgent(id, at, fields))]

/** Changes the agent with `id`; a list without it is left as it is. */
export const patch = (
  list: PanelAgent[],
  id: string,
  change: (agent: PanelAgent) => PanelAgent,
): PanelAgent[] =>
  list.map(agent => (agent.id === id ? change(agent) : agent))

export const withAction = (
  agent: PanelAgent,
  tool: string,
  action: string,
): PanelAgent => ({
  ...agent,
  toolCallCount: agent.toolCallCount + 1,
  lastAction: action,
  recentActions: [...agent.recentActions, action].slice(-RECENT),
  tools: agent.tools.includes(tool) ? agent.tools : [...agent.tools, tool],
})

export const working = (agent: PanelAgent): PanelAgent => {
  const { finishedAt: _f, question: _q, waitingOn: _w, ...rest } = agent

  return { ...rest, status: 'working' }
}

/** Running again: a finished agent that is woken starts a new run. */
export const resumed = (agent: PanelAgent, at: number): PanelAgent => {
  if (!isFinished(agent)) {
    return working(agent)
  }

  const { result: _r, ...rest } = working(agent)

  return { ...rest, startedAt: at }
}

export const finished = (
  agent: PanelAgent,
  status: PanelStatus,
  at: number,
  result?: string,
): PanelAgent => {
  const { question: _q, waitingOn: _w, ...rest } = agent

  return {
    ...rest,
    status,
    finishedAt: at,
    ...(result !== undefined && result !== '' ? { result } : {}),
  }
}

const RANK: Record<PanelStatus, number> = {
  'needs-you': 0,
  working: 1,
  done: 2,
  failed: 3,
  stopped: 3,
}

/** Needs you first, then working (newest first), then done, failed, stopped. */
export const sorted = (list: readonly PanelAgent[]): PanelAgent[] =>
  [...list].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      (isFinished(a)
        ? (b.finishedAt ?? 0) - (a.finishedAt ?? 0)
        : b.startedAt - a.startedAt),
  )

export type Placed = {
  agent: PanelAgent
  /** 0 for an agent the main loop started, 1 for one it started, and so on. */
  depth: number
  /** True when it and everything it started, or its ancestors did, has ended. */
  isSettled: boolean
}

/**
 * The list as the pane draws it: each agent followed by the agents it started.
 * A group is ordered by the most urgent status anywhere inside it, so an agent
 * that needs you lifts the agent that started it to the top with it.
 */
export const tree = (list: readonly PanelAgent[]): Placed[] => {
  const ids = new Set(list.map(agent => agent.id))
  const childrenOf = (id: string) => list.filter(agent => agent.parentId === id)
  const within = (agent: PanelAgent, seen: Set<string>): PanelAgent[] => {
    if (seen.has(agent.id)) {
      return []
    }

    seen.add(agent.id)

    return [agent, ...childrenOf(agent.id).flatMap(child => within(child, seen))]
  }
  const urgency = (agent: PanelAgent): number =>
    Math.min(...within(agent, new Set()).map(one => RANK[one.status]))
  const order = (group: PanelAgent[]): PanelAgent[] =>
    sorted(group)
      .map((agent, index) => ({ agent, index, rank: urgency(agent) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(one => one.agent)

  const placed: Placed[] = []
  const seen = new Set<string>()
  const walk = (agent: PanelAgent, depth: number, isSettled: boolean) => {
    if (seen.has(agent.id)) {
      return
    }

    seen.add(agent.id)
    placed.push({ agent, depth, isSettled })

    for (const child of order(childrenOf(agent.id))) {
      walk(child, depth + 1, isSettled)
    }
  }
  const roots = list.filter(
    agent => agent.parentId === undefined || !ids.has(agent.parentId),
  )

  for (const root of order(roots)) {
    walk(root, 0, within(root, new Set()).every(isFinished))
  }

  return placed
}

export const MARK: Record<PanelStatus, string> = {
  'needs-you': '!',
  working: '●',
  done: '✓',
  failed: '×',
  stopped: '×',
}

export const WORD: Record<PanelStatus, string> = {
  'needs-you': 'needs you',
  working: 'working',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/** What a row is titled: its name, else what it was asked to do, else its type. */
export const label = (agent: PanelAgent): string =>
  agent.name ?? (agent.task !== '' ? agent.task : agent.type)

/** The line under the title: what the title left unsaid, then what it is doing. */
export const sublabel = (agent: PanelAgent): string => {
  const isTitledByTask = agent.name === undefined && agent.task !== ''
  const about = isTitledByTask ? agent.type : agent.task

  switch (agent.status) {
    case 'needs-you':
      return agent.question ?? about
    case 'working':
      return [about, agent.lastAction].filter(Boolean).join(' · ')
    default:
      return agent.result ?? about
  }
}

/** "2 working · 1 waiting · 1 done"; empty for an empty list. */
export const countLine = (list: readonly PanelAgent[]): string => {
  const count = (status: PanelStatus) =>
    list.filter(agent => agent.status === status).length
  const parts: Array<[number, string]> = [
    [count('working'), 'working'],
    [count('needs-you'), 'waiting'],
    [count('done'), 'done'],
    [count('failed'), 'failed'],
    [count('stopped'), 'stopped'],
  ]

  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

/** 40s, 2m 10s, 1h 05m. */
export const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export const runtime = (agent: PanelAgent, now: number): string =>
  elapsed((agent.finishedAt ?? Math.max(now, agent.startedAt)) - agent.startedAt)

const text = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]

  return typeof value === 'string' && value !== '' ? value : undefined
}

const fileOf = (input: Record<string, unknown>): string | undefined => {
  const path =
    text(input, 'file_path') ?? text(input, 'notebook_path') ?? text(input, 'path')

  return path?.split('/').filter(Boolean).pop()
}

const toolName = (tool: string): string =>
  tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool

/** One line for a tool call: "Read session.ts", "Ran npm test". */
export const describeAction = (
  tool: string,
  input: Record<string, unknown>,
): string => {
  const file = fileOf(input)

  switch (tool) {
    case 'Read':
      return file ? `Read ${file}` : 'Read a file'
    case 'Edit':
    case 'NotebookEdit':
      return file ? `Edited ${file}` : 'Edited a file'
    case 'Write':
      return file ? `Wrote ${file}` : 'Wrote a file'
    case 'Bash':
      return `Ran ${clip(text(input, 'command') ?? 'a command', 48)}`
    case 'Grep':
    case 'Glob':
      return `Searched for ${clip(text(input, 'pattern') ?? 'files', 40)}`
    case 'WebFetch':
      return `Fetched ${clip(text(input, 'url') ?? 'a page', 40)}`
    case 'WebSearch':
      return `Searched the web for ${clip(text(input, 'query') ?? '…', 32)}`
    case 'Agent':
      return `Started ${clip(text(input, 'description') ?? 'a subagent', 40)}`
    case 'SubagentHandback':
      return 'Handed back its report'
    default:
      return `Used ${toolName(tool)}`
  }
}

/** What an agent waiting on a permission wants: "Wants to edit session.ts". */
export const describeAsk = (
  tool: string,
  input: Record<string, unknown>,
): string => {
  const file = fileOf(input)

  switch (tool) {
    case 'Edit':
    case 'NotebookEdit':
      return `Wants to edit ${file ?? 'a file'}`
    case 'Write':
      return `Wants to write ${file ?? 'a file'}`
    case 'Read':
      return `Wants to read ${file ?? 'a file'}`
    case 'Bash':
      return `Wants to run ${clip(text(input, 'command') ?? 'a command', 48)}`
    case 'WebFetch':
      return `Wants to fetch ${clip(text(input, 'url') ?? 'a page', 40)}`
    default:
      return `Wants to use ${toolName(tool)}`
  }
}

/** Modes in which an ask is never put to a person: a classifier or a rule settles it. */
const UNASKED = new Set(['auto', 'dontAsk', 'bypassPermissions'])

/** Whether a permission ask in this agent's mode waits on the person. */
export const asksPerson = (agent: PanelAgent): boolean =>
  agent.mode === undefined || !UNASKED.has(agent.mode)

const MODE: Record<string, string> = {
  default: 'manual (asks before edits and commands)',
  acceptEdits: 'accept edits (asks before commands)',
  plan: 'plan (no edits)',
  auto: 'auto (a classifier decides)',
  dontAsk: "don't ask (refuses what is not pre-approved)",
  bypassPermissions: 'bypass permissions',
}

export const modeWord = (mode: string): string => MODE[mode] ?? mode

/** The agent a typed name means: its id, its name or its type, any case. */
export const findByName = (
  list: readonly PanelAgent[],
  query: string,
): PanelAgent | undefined => {
  const wanted = query.trim().replace(/^@/, '').toLowerCase()

  if (wanted === '') {
    return undefined
  }

  const order = sorted(list)

  return (
    order.find(agent => agent.id.toLowerCase() === wanted) ??
    order.find(agent => agent.name?.toLowerCase() === wanted) ??
    order.find(agent => agent.type.toLowerCase() === wanted) ??
    order.find(agent => label(agent).toLowerCase().startsWith(wanted))
  )
}
