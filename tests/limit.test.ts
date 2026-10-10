import { expect, mock, test } from 'claude-code/testing'

const HOUR = 60 * 60 * 1000

/** The test's hooks stand for the engine beneath the plugin: tools run, prompts are recorded. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const prompts: string[] = []
  on('tool.call', () => ({ result: 'ran', text: 'ran' }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', () => undefined)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  return prompts
}

const ran = async ($: any) => JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'echo hi' }))

test('stop-now refuses every tool call until "continue"', async ($: any, on: any) => {
  engine(on)
  expect(await ran($)).toContain('ran')

  await $.command.run({ command: 'limit', args: 'stop-now' })
  expect(await ran($)).toContain('Stopped by /limit (stop-now)')

  await $.prompt.submit({ text: 'continue' })
  expect(await ran($)).toContain('ran')
})

test('stop-limit stops at the percentage; continue-limit restarts this session after the reset', async ($: any, on: any) => {
  const clock = mock.clock(on, { now: Date.now() })
  const prompts = engine(on)
  const resetsAt = new Date(Date.now() + HOUR).toISOString()
  const measure = (percentUsed: number) =>
    $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }], changed: ['rateLimits'] })

  await $.command.run({ command: 'limit', args: 'stop-limit 85' })
  await $.command.run({ command: 'limit', args: 'continue-limit' })
  await measure(60)
  expect(await ran($)).toContain('ran')

  await measure(86)
  expect(await ran($)).toContain('Stopped by /limit (stop-limit)')
  expect(prompts).toEqual([])

  // Nothing is sent before the reset (+2 minutes)...
  await clock.advance(HOUR)
  expect(prompts).toEqual([])
  // ...and "continue" after it, which lifts the stop.
  await clock.advance(3 * 60 * 1000)
  expect(prompts).toEqual(['continue'])
})

test('without continue-limit, a stop by the limit is never restarted', async ($: any, on: any) => {
  const clock = mock.clock(on, { now: Date.now() })
  const prompts = engine(on)
  await $.command.run({ command: 'limit', args: 'stop-limit 50' })
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 70, resetsAt: new Date(Date.now() + HOUR).toISOString() }],
    changed: ['rateLimits'],
  })
  expect(await ran($)).toContain('Stopped by /limit (stop-limit)')
  await clock.advance(2 * HOUR)
  expect(prompts).toEqual([])
})
