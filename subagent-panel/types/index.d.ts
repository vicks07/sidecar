export type PanelStatus = 'working' | 'needs-you' | 'done' | 'failed' | 'stopped'

/** One subagent of the session, as the pane keeps it. */
export type PanelAgent = {
  id: string
  /** The agent type it was spawned as (`Explore`, `general-purpose`, ...). */
  type: string
  /** The agent whose loop spawned it; absent when the main loop did. */
  parentId?: string
  /** What SendMessage addresses it by, when the spawn named it. */
  name?: string
  /** The task in one line: the short description the spawn gave. */
  task: string
  /** The brief it was started with: the opening of its prompt. */
  prompt?: string
  status: PanelStatus
  startedAt: number
  finishedAt?: number
  toolCallCount: number
  lastAction?: string
  /** The last five actions, newest last. */
  recentActions: string[]
  model?: string
  /** The distinct tools it has called so far. */
  tools: string[]
  /** Where its definition comes from: built-in, or a tier and plugin. */
  scope?: string
  isBackground: boolean
  /** The permission mode it inherited when it started (`default`, `plan`, ...). */
  mode?: string
  /** First line of its final answer. */
  result?: string
  /** What it is waiting on while it needs you. */
  question?: string
  /** The tool call whose permission it waits on. */
  waitingOn?: string
  /** Input plus output tokens of its finished turns. */
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-panel': {
      agents: Shaped<PanelAgent[]>
      selected: string | null
      now: number
      isFinishedOpen: boolean
      /** The agent the next typed message goes to; null for main Claude. */
      target: string | null
      /** The agent whose stop waits on a yes. */
      confirming: string | null
    }
  }
}
