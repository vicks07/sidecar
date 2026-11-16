import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describeAction } from '../hooks/store'

const PANE = {
  plugin: 'subagent-panel',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Nothing sits beneath the plugin in a test: each hook here stands for the
// engine. Spawns are answered a1, a2, ... in the order they are made.
type StopAnswer = { result: unknown } | { deny: string }

const engine = (on: On, taskStop?: (taskId: unknown) => StopAnswer) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let spawned = 0

  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) =>
    e.tool === 'TaskStop' && taskStop !== undefined
      ? taskStop(e.task_id)
      : { result: {} },
  )
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'sonnet', agentId: `a${spawned}` }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return clock
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const spawn = (
  $: Engine,
  subagentType: string,
  description: string,
  permissionMode?: string,
) =>
  $.agent.spawn({
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    tool_use_id: `toolu_${subagentType}`,
    prompt: `${description}. Report back.`,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })

const finish = ($: Engine, agentId: string, answer: string) =>
  $.turn.complete({
    answer,
    durationMs: 1000,
    isAborted: false,
    turnId: `turn-${agentId}`,
    agentId,
    reason: 'answer',
  })

test('an empty pane says how to start, on every surface', async ($, on) => {
  engine(on)
  await start($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(
      await ui.find({ type: 'Text', text: /No subagents yet/ }),
    ).toBeDefined()
    await ui.unmount()
  }
})

test('started and finished subagents are listed and counted', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'Explore', 'Searching for old session code')
  await spawn($, 'test-runner', 'Running login test suite')
  await spawn($, 'Plan', 'Drafting migration steps')
  await clock.advance(40_000)
  await finish($, 'a3', 'Drafted 4 migration steps\n\nDetails follow.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(
      await ui.find({ type: 'Text', text: '2 working · 1 done' }),
    ).toBeDefined()
    expect((await ui.find({ key: 'row-a1' }))?.text).toContain('● Searching for old session code')
    expect((await ui.find({ key: 'row-a3' }))?.text).toContain('✓ Drafting migration steps')
    // The finished agent keeps its result; the running ones show their time.
    expect(
      await ui.find({ type: 'Text', text: /Drafted 4 migration steps/ }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40s/ })).toBeDefined()

    // Working agents come before finished ones.
    const rows = (await ui.findAll({ type: 'Button' })).map(row => row.key)
    expect(rows.indexOf('row-a3')).toBe(2)
    await ui.unmount()
  }
})

test('a tool call shows as the agent’s last action', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'Explore', 'Searching for old session code')
  await $.tool.call({ tool: 'Read', file_path: '/app/auth/session.ts', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
  // The main loop's calls are not an agent's.
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: 'Ran npm test' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 tool calls/ })).toBeDefined()
  await ui.unmount()
})

test('an agent waiting on a permission is flagged and sorts first', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await spawn($, 'code-reviewer', 'Reviewing the login flow')
  await spawn($, 'Explore', 'Searching for old session code')
  await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/app/auth/session.ts' },
    tool_use_id: 'toolu_edit',
    agentId: 'a1',
    approver: 'person',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(
      await ui.find({ type: 'Text', text: '1 working · 1 waiting' }),
    ).toBeDefined()
    expect((await ui.find({ key: 'row-a1' }))?.text).toContain('! Reviewing the login flow')
    expect(await ui.find({ type: 'Text', text: 'needs you' })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /Wants to edit session\.ts/ }),
    ).toBeDefined()
    expect((await ui.findAll({ type: 'Button' }))[0]?.key).toBe('row-a1')
    await ui.unmount()
  }

  // Its turn ending clears the flag.
  await finish($, 'a1', 'Reviewed.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'needs you' })).toBeUndefined()
  await ui.unmount()
})

test('pressing a row shows its details, pressing again hides them', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'Explore', 'Searching for old session code')
  await $.tool.call({ tool: 'Read', file_path: '/app/auth/session.ts', agentId: 'a1' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /^model/ })).toBeUndefined()
    await ui.press({ key: 'row-a1' })
    expect((await ui.find({ type: 'Text', text: /^model/ }))?.text).toContain('sonnet')
    expect((await ui.find({ type: 'Text', text: /^tools/ }))?.text).toContain('Read')
    expect((await ui.find({ type: 'Text', text: /^type/ }))?.text).toContain('Explore')
    // Why it was started: the brief it was given.
    expect(
      await ui.find({
        type: 'Text',
        text: 'Searching for old session code. Report back.',
      }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read session\.ts/ })).toBeDefined()
    await ui.press({ key: 'row-a1' })
    expect(await ui.find({ type: 'Text', text: /^model/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a row says what the agent was asked to do, not only its type', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'general-purpose', 'Review the panel code')
  await spawn($, 'general-purpose', 'Write the setup guide')
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ key: 'row-a1' }))?.text).toContain('Review the panel code')
    expect((await ui.find({ key: 'row-a2' }))?.text).toContain('Write the setup guide')
    expect(
      await ui.find({ type: 'Text', text: 'general-purpose · Ran npm test' }),
    ).toBeDefined()
    await ui.unmount()
  }
})

test('the main loop’s forks and unknown loops make no row', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'compact', turnId: 't-x', agentId: 'fork-1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'fork-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a host’s ask is not flagged as needing you', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await spawn($, 'Explore', 'Searching')
  await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/a.ts' },
    tool_use_id: 'toolu_edit',
    agentId: 'a1',
    approver: 'host',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'needs you' })).toBeUndefined()
  await ui.unmount()
})

test('a woken agent starts a new run without its old result', async ($, on) => {
  const clock = engine(on)
  await start($)
  await spawn($, 'Explore', 'Searching')
  await finish($, 'a1', 'Found three files')
  await clock.advance(3_600_000)
  await $.turn.start({ text: 'one more thing', turnId: 't-2', agentId: 'a1' })
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1 working' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Found three files/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '5s' })).toBeDefined()
  await ui.unmount()
})

test('more than six finished agents collapse into one row', async ($, on) => {
  engine(on)
  await start($)

  for (let n = 1; n <= 7; n += 1) {
    await spawn($, `worker-${n}`, `Job ${n}`)
    await finish($, `a${n}`, `Did job ${n}`)
  }

  await spawn($, 'Explore', 'Still searching')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'finished' }))?.text).toContain('7 finished')
  expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'row-a8' })).toBeDefined()
  await ui.press({ key: 'finished' })
  expect(await ui.find({ key: 'row-a1' })).toBeDefined()
  await ui.unmount()
})

test('a result that opens with a table is summed up by its first prose line', async ($, on) => {
  engine(on)
  await start($)
  await spawn($, 'general-purpose', 'Probing')
  await $.turn.complete({
    answer: '| Step | Tool |\n|---|---|\n| 1 | Read |\n\n## All four steps ran\nNo prompt was shown.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't-1',
    agentId: 'a1',
    reason: 'answer',
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 9_700,
      model: 'sonnet',
    },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row-a1' })
  expect(await ui.find({ type: 'Text', text: /All four steps ran/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\| Step/ })).toBeUndefined()
  // The hand-back is a tool of the engine's own that the kit does not raise.
  expect(describeAction('SubagentHandback', {})).toBe('Handed back its report')
  expect((await ui.find({ type: 'Text', text: /^ran/ }))?.text).toContain('50,000 tokens')
  await ui.unmount()
})

// ---- Permission modes ----------------------------------------------------
// The engine's verdict for each mode is stood in for by the test's own
// `tool.check` hook, as the declarations describe the modes: these show what
// the pane does with each verdict, not that the engine gives it.

const check = ($: Engine, tool: string, input: Record<string, unknown>) =>
  $.tool.check({
    tool,
    input,
    tool_use_id: `toolu_${tool}`,
    agentId: 'a1',
    approver: 'person',
  })

const flagged = async ($: Engine): Promise<boolean> => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = await ui.find({ type: 'Text', text: 'needs you' })
  await ui.unmount()

  return found !== undefined
}

const modeLine = async ($: Engine): Promise<string | undefined> => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row-a1' })
  const line = (await ui.find({ type: 'Text', text: /^mode\s/ }))?.text
  await ui.press({ key: 'row-a1' })
  await ui.unmount()

  return line
}

test('manual mode: an edit asks, so the agent needs you', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await spawn($, 'Explore', 'Renaming the cookie', 'default')
  await check($, 'Edit', { file_path: '/app/session.ts' })

  expect(await flagged($)).toBe(true)
  expect(await modeLine($)).toContain('manual')
})

test('accept edits mode: an edit runs unflagged, a command still asks', async ($, on) => {
  engine(on)
  on('tool.check', (_, e) => ({ decision: e.tool === 'Bash' ? 'ask' : 'allow' }))
  await start($)
  await spawn($, 'Explore', 'Renaming the cookie', 'acceptEdits')
  await check($, 'Edit', { file_path: '/app/session.ts' })

  expect(await flagged($)).toBe(false)

  await check($, 'Bash', { command: 'npm test' })

  expect(await flagged($)).toBe(true)
  expect(await modeLine($)).toContain('accept edits')
})

test('plan mode: a refused edit leaves the agent working, unflagged', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'plan mode' }))
  await start($)
  await spawn($, 'Plan', 'Drafting the migration', 'plan')
  await check($, 'Edit', { file_path: '/app/session.ts' })

  expect(await flagged($)).toBe(false)
  expect(await modeLine($)).toContain('plan')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1 working' })).toBeDefined()
  await ui.unmount()
})

test('auto mode: an ask goes to the classifier, not to you', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await spawn($, 'Explore', 'Renaming the cookie', 'auto')
  await check($, 'Bash', { command: 'npm test' })

  expect(await flagged($)).toBe(false)
  expect(await modeLine($)).toContain('auto')
})

// ---- Nesting --------------------------------------------------------------

const spawnUnder = ($: Engine, parentAgentId: string, description: string) =>
  $.agent.spawn({
    tool_use_id: `toolu_${description}`,
    prompt: description,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
    parentAgentId,
  })

test('an agent another agent started sits under it and lifts it when it needs you', async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  await spawn($, 'Explore', 'Parent job')
  await spawnUnder($, 'a1', 'Child job')
  await spawn($, 'Plan', 'Other job')
  await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/a.ts' },
    tool_use_id: 'toolu_edit',
    agentId: 'a2',
    approver: 'person',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = (await ui.findAll({ type: 'Button' }))
      .map(row => row.key)
      .filter(key => key?.startsWith('row-'))

    // The child needs you, so its parent's group comes before the newer agent.
    expect(rows).toEqual(['row-a1', 'row-a2', 'row-a3'])
    expect((await ui.find({ key: 'row-a2' }))?.text).toContain('└ ! Child job')
    await ui.unmount()
  }
})

// ---- Message, view, stop, new agent ---------------------------------------

const BAND = {
  plugin: 'subagent-panel',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const typed = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('Message sends the next typed prompt to the agent, once', async ($, on) => {
  engine(on)
  const sent: Array<{ to: string; text: string }> = []
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.fill', () => ({ isFilled: true }))
  await start($)
  await spawn($, 'code-reviewer', 'Reviewing the login flow')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'row-a1' })
  await pane.press({ key: 'act-message' })
  expect((await pane.find({ key: 'act-message' }))?.text).toContain('Cancel message')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(
    await band.find({ type: 'Text', text: 'sending to Reviewing the login flow' }),
  ).toBeDefined()
  expect(await band.find({ key: 'back-to-main' })).toBeDefined()

  // A slash command is never redirected.
  const command = await $.prompt.submit({
    text: '/help',
    command: { name: 'help', args: '' },
    wait: false,
    origin: { kind: 'composer' },
  })
  expect(command.drop).toBeUndefined()
  expect(sent).toHaveLength(0)

  const first = await typed($, 'go ahead, but keep the old cookie name')
  expect(first.drop).toContain('Sent to Reviewing the login flow')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toBe('go ahead, but keep the old cookie name')
  expect(sent[0]?.to).toContain('a1')

  // One message only: the next one is main Claude's again.
  const second = await typed($, 'and now you, Claude')
  expect(second.drop).toBeUndefined()
  expect(second.text).toBe('and now you, Claude')
  expect(sent).toHaveLength(1)
  expect(await band.find({ type: 'Text', text: /sending to/ })).toBeUndefined()

  await band.unmount()
  await pane.unmount()
})

test('a message that is not delivered is reported, not lost', async ($, on) => {
  engine(on)
  const filled: string[] = []
  on('session.send', () => ({ isDelivered: false, reason: 'the agent has ended' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  await start($)
  await spawn($, 'Explore', 'Searching')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'row-a1' })
  await pane.press({ key: 'act-message' })

  const result = await typed($, 'one more thing')
  expect(result.drop).toContain('Not delivered to Searching: the agent has ended')
  expect(filled).toEqual(['one more thing'])
  await pane.unmount()
})

test('Back to main Claude clears the target', async ($, on) => {
  engine(on)
  const views: unknown[] = []
  on('ui.view', (_, e) => {
    views.push(e)

    return { value: {} }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  await spawn($, 'Explore', 'Searching')

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'row-a1' })
  await pane.press({ key: 'act-message' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'back-to-main' })

  expect(await band.find({ type: 'Text', text: /sending to/ })).toBeUndefined()
  expect((await typed($, 'hello')).text).toBe('hello')
  expect(views).toEqual([{}])
  await band.unmount()
  await pane.unmount()
})

test('View transcript asks the engine to show the agent', async ($, on) => {
  engine(on)
  const views: unknown[] = []
  on('ui.view', (_, e) => {
    views.push(e)

    return { value: {} }
  })
  await start($)
  await spawn($, 'Explore', 'Searching')

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'row-a1' })
    await pane.press({ key: 'act-view' })
    await pane.press({ key: 'row-a1' })
    await pane.unmount()
  }

  expect(views).toEqual(SURFACES.map(() => ({ agentId: 'a1' })))

  // While an agent's transcript is the view, the band says where typing goes.
  const band = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, view: { agentId: 'a1' } },
    surface: 'terminal',
  })
  expect(
    await band.find({ type: 'Text', text: /viewing Searching: messages go to this agent/ }),
  ).toBeDefined()
  await band.unmount()
})

test('Stop asks first, then stops the agent with TaskStop', async ($, on) => {
  const stops: unknown[] = []
  engine(on, taskId => {
    stops.push(taskId)

    return { result: { message: 'stopped', task_id: 'a1', task_type: 'subagent' } }
  })
  await start($)
  await spawn($, 'Explore', 'Searching')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'row-a1' })
  expect(await pane.find({ key: 'stop-yes' })).toBeUndefined()

  // Cancel leaves it running.
  await pane.press({ key: 'act-stop' })
  await pane.press({ key: 'stop-no' })
  expect(stops).toHaveLength(0)
  expect(await pane.find({ type: 'Text', text: '1 working' })).toBeDefined()

  await pane.press({ key: 'act-stop' })
  expect(await pane.find({ type: 'Text', text: 'Stop this agent?' })).toBeDefined()
  await pane.press({ key: 'stop-yes' })

  expect(stops).toEqual(['a1'])
  expect(await pane.find({ type: 'Text', text: '1 stopped' })).toBeDefined()
  // An ended agent has no Stop.
  expect(await pane.find({ key: 'act-stop' })).toBeUndefined()
  await pane.unmount()
})

test('a refused stop leaves the agent as it was', async ($, on) => {
  engine(on, () => ({ deny: 'not a background task' }))
  await start($)
  await spawn($, 'Explore', 'Searching')

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'row-a1' })
  await pane.press({ key: 'act-stop' })
  await pane.press({ key: 'stop-yes' })

  expect(await pane.find({ type: 'Text', text: '1 working' })).toBeDefined()
  await pane.unmount()
})

test('New agent starts the one line in the prompt', async ($, on) => {
  engine(on)
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  await start($)

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'new-agent' })
    await pane.unmount()
  }

  expect(filled).toEqual(SURFACES.map(() => 'Use a subagent to '))
})
