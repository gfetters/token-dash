import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const PANE = {
  plugin: 'token-dash',
  component: 'Pane',
  requestId: 'token-dash',
  props: {
    title: 'Token Dash',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const agent = (status: AgentInfo['status']): AgentInfo => ({
  id: 'a1',
  description: 'Find auth code',
  type: 'Explore',
  status,
})

// Everything beneath the plugin: these hooks stand for the engine.
function engine(on: On, list: () => AgentInfo[], stop: (id: string) => string | undefined) {
  const toasts: string[] = []
  const stops: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'dash' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: list() }))
  on('tool.call', { tool: 'TaskStop' }, (_, e) => {
    const id = e.task_id ?? ''
    stops.push(id)
    const deny = stop(id)
    if (deny !== undefined) return { deny }

    return { result: { message: 'stopped', task_id: id, task_type: 'local_agent' } }
  })

  return { clock, toasts, stops }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Kill stops a running subagent (${surface})`, async ($, on) => {
    let status: AgentInfo['status'] = 'running'
    const world = engine(on, () => [agent(status)], () => {
      status = 'killed'

      return undefined
    })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await world.clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'kill-a1' })).toBeDefined()

    await ui.press({ key: 'kill-a1' })

    expect(world.stops).toEqual(['a1'])
    expect(world.toasts.some(t => t.startsWith('Stopped "Find auth code"'))).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'kill-a1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Find auth code.*killed/ })).toBeDefined()

    // Later ticks keep it shown as killed.
    await world.clock.advance(3000)
    expect(await ui.find({ type: 'Text', text: /Find auth code.*killed/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'kill-a1' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a refused stop says why and keeps Kill (${surface})`, async ($, on) => {
    const world = engine(on, () => [agent('running')], () => 'No task found with ID: a1')
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await world.clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'kill-a1' })

    expect(world.stops).toEqual(['a1'])
    expect(world.toasts).toEqual([
      'Could not stop "Find auth code": No task found with ID: a1',
    ])
    expect(await ui.find({ type: 'Button', key: 'kill-a1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Find auth code.*running/ })).toBeDefined()
    await ui.unmount()
  })

  test(`a finished subagent has no Kill (${surface})`, async ($, on) => {
    const world = engine(on, () => [agent('completed')], () => undefined)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await world.clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Find auth code.*completed/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'kill-a1' })).toBeUndefined()
    await ui.unmount()
  })
}
