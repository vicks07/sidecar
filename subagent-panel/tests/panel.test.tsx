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
const engine = (on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let spawned = 0

  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
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
