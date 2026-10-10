import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { LimitState, LimitStopReason } from '../types'

// /limit — stop this session's work now or at a 5-hour usage percentage, and restart it after the reset.
//   /limit stop-now           stop all work at once (tool calls of the main thread, subagents and workflows are refused)
//   /limit stop-limit <pct>   stop all work when the 5-hour usage reaches <pct> %
//   /limit continue-limit     after a stop by stop-limit or the real usage limit, send "continue" to THIS session
//                             2 minutes after the 5-hour window resets (other sessions are never touched)
//   /limit status | off       show the settings / switch stop-limit and continue-limit off
// "continue" (typed by the person or sent by the restart) lifts the stop.

const ST = { plugin: 'limit', key: 'st' } as const
const EMPTY: LimitState = { stopped: null, threshold: null, autoRestart: false, restartAt: null }
/** How long after the reported reset the restart waits, so the new window is really open. */
const RESTART_DELAY_MS = 2 * 60 * 1000

// Module variables start over on a reload; everything that must survive one is in $.state.
let runningTurn: string | null = null
let restartTimer: { cancel: () => void } | null = null
/** The latest 5-hour window the engine reported. */
let fiveHour: SessionRateLimit | null = null

type $ = EngineInterface

async function load($: $): Promise<LimitState> {
  const { value } = await $.state.get(ST)
  return { ...EMPTY, ...(value ?? {}) }
}

async function save($: $, st: LimitState) {
  await $.state.set(ST, st)
  showStatus($, st)
}

/** The 5-hour percentage, or null when unknown or when the window it belongs to has already reset. */
function fiveHourPercent(): number | null {
  if (!fiveHour) return null
  if (fiveHour.resetsAt && Date.parse(fiveHour.resetsAt) <= Date.now()) return null
  return fiveHour.percentUsed
}

const clock = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : 'unknown')

function showStatus($: $, st: LimitState) {
  const parts: string[] = []
  const pct = fiveHourPercent()
  if (pct !== null) parts.push(`5h ${Math.round(pct)}%`)
  if (st.threshold !== null) parts.push(`stop at ${st.threshold}%`)
  if (st.autoRestart) parts.push('auto-restart on')
  if (st.stopped) parts.push(`STOPPED (${st.stopped.reason})`)
  if (st.restartAt) parts.push(`restart ${clock(st.restartAt)}`)
  $.ui.status(parts.length > 1 || st.stopped ? `limit: ${parts.join(' · ')}` : undefined)
}

function abortRunningTurn($: $) {
  if (runningTurn) void $.turn.abort({ turnId: runningTurn }).catch(() => undefined)
}

/** Stops all work; with continue-limit armed, a stop caused by the usage limit also schedules the restart. */
async function stop($: $, reason: LimitStopReason, resetsAt?: string) {
  const st = await load($)
  if (!st.stopped) st.stopped = { reason, at: new Date().toISOString(), resetsAt }
  await save($, st)
  abortRunningTurn($)
  if (reason !== 'stop-now') await scheduleRestart($)
}

async function scheduleRestart($: $) {
  const st = await load($)
  if (!st.autoRestart || !st.stopped || st.stopped.reason === 'stop-now') return
  const resetsAt = st.stopped.resetsAt ?? fiveHour?.resetsAt
  if (!resetsAt) {
    $.ui.toast('limit: no reset time known, so no automatic restart. Say "continue" after the reset.', { timeoutMs: 10000 })
    return
  }
  const at = Math.max(Date.parse(resetsAt) + RESTART_DELAY_MS, Date.now() + 5000)
  st.restartAt = new Date(at).toISOString()
  await save($, st)
  armTimer($, at)
}

function armTimer($: $, at: number) {
  restartTimer?.cancel()
  restartTimer = $.clock.after(Math.max(0, at - Date.now()), () => {
    restartTimer = null
    // The prompt hook below lifts the stop when it sees "continue".
    void $.prompt.submit({ text: 'continue', asUser: true }).catch(() => undefined)
  })
}

async function lift($: $) {
  const st = await load($)
  restartTimer?.cancel()
  restartTimer = null
  await save($, { ...st, stopped: null, restartAt: null })
}

function help(st: LimitState) {
  return [
    '/limit stop-now           stop all work now; say "continue" to resume',
    '/limit stop-limit <pct>   stop all work when the 5-hour usage reaches <pct> %',
    '/limit continue-limit     restart this session after the 5-hour reset when the limit stopped it',
    '/limit status             show the settings',
    '/limit off                switch stop-limit and continue-limit off',
    '',
    statusText(st),
  ].join('\n')
}

function statusText(st: LimitState) {
  const pct = fiveHourPercent()
  return [
    `5-hour usage: ${pct === null ? 'not known yet' : `${pct}%`}${fiveHour?.resetsAt ? ` (resets ${clock(fiveHour.resetsAt)})` : ''}`,
    `stop-limit: ${st.threshold === null ? 'off' : `${st.threshold}%`}`,
    `continue-limit: ${st.autoRestart ? 'on (this session only)' : 'off'}`,
    `state: ${st.stopped ? `stopped by ${st.stopped.reason} at ${clock(st.stopped.at)}` : 'running'}`,
    ...(st.restartAt ? [`automatic restart: ${clock(st.restartAt)}`] : []),
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'limit',
      description: 'Stop work now or at a 5-hour usage %, and restart this session after the reset',
      argumentHint: 'stop-now | stop-limit <pct> | continue-limit | status | off',
      immediate: true,
    })
    const usage = await $.session.usage().catch(() => null)
    fiveHour = usage?.rateLimits.find(w => w.kind === 'five_hour') ?? fiveHour
    const st = await load($)
    // A reload drops timers: put back a restart that was scheduled.
    if (st.restartAt) armTimer($, Date.parse(st.restartAt))
    showStatus($, st)
    return next(e)
  })

  on('command.run', { command: 'limit' }, async ($, e) => {
    const [word = '', arg] = e.args.trim().toLowerCase().split(/\s+/)
    const st = await load($)
    if (word === 'stop-now') {
      await stop($, 'stop-now')
      return {
        text: 'Stopped. Every tool call (main thread, subagents and workflows) is refused until you say "continue".',
        context: [
          'The user ran /limit stop-now: all work was stopped at once and further tool calls are refused. ' +
            'Do not try to work around it. When the user says "continue", resume exactly where the work stopped: ' +
            'relaunch stopped workflows with resumeFromRunId and re-run interrupted steps.',
        ],
      }
    }
    if (word === 'stop-limit') {
      const pct = Number(arg)
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { text: 'Usage: /limit stop-limit <percent>, for example /limit stop-limit 85' }
      await save($, { ...st, threshold: pct })
      const now = fiveHourPercent()
      if (now !== null && now >= pct) await stop($, 'stop-limit', fiveHour?.resetsAt)
      return { text: `stop-limit set: all work stops when the 5-hour usage reaches ${pct}% (now ${now === null ? 'not known yet' : `${now}%`}).` }
    }
    if (word === 'continue-limit') {
      await save($, { ...st, autoRestart: true })
      await scheduleRestart($)
      const after = await load($)
      return {
        text:
          'continue-limit on for this session: when stop-limit or the real usage limit stops it, it sends "continue" ' +
          '2 minutes after the 5-hour reset. Keep this session open.' +
          (after.restartAt ? `\nRestart scheduled: ${clock(after.restartAt)}` : ''),
      }
    }
    if (word === 'off') {
      restartTimer?.cancel()
      restartTimer = null
      await save($, { ...st, threshold: null, autoRestart: false, restartAt: null })
      return { text: 'stop-limit and continue-limit are off. (A stop in place stays until you say "continue".)' }
    }
    if (word === 'status') return { text: statusText(st) }
    return { text: help(st) }
  })

  // The guard: while stopped, every tool call is refused, in the main thread, subagents and workflow agents alike.
  on('tool.call', async ($, e, next) => {
    let st = await load($)
    const pct = fiveHourPercent()
    if (!st.stopped && st.threshold !== null && pct !== null && pct >= st.threshold) {
      await stop($, 'stop-limit', fiveHour?.resetsAt)
      st = await load($)
    }
    if (st.stopped) {
      const when = st.restartAt ? ` It restarts by itself at ${clock(st.restartAt)}.` : ' Say "continue" to resume.'
      return { deny: `Stopped by /limit (${st.stopped.reason}).${when}` }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a failing guard must never block the session

  // The engine's usage figures, pushed after each turn and whenever a window moves a whole point.
  on('session.measure', async ($, e, next) => {
    fiveHour = e.rateLimits.find(w => w.kind === 'five_hour') ?? fiveHour
    const st = await load($)
    const pct = fiveHourPercent()
    if (!st.stopped && st.threshold !== null && pct !== null && pct >= st.threshold) await stop($, 'stop-limit', fiveHour?.resetsAt)
    else showStatus($, st)
    return next(e)
  })

  // The real usage limit was hit (by this session or by any other session of the account).
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await stop($, 'limit-hit', fiveHour?.resetsAt)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    runningTurn = e.turnId
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId && e.turnId === runningTurn) runningTurn = null
    return next(e)
  })

  // "continue" lifts the stop, whether the person typed it or the restart sent it.
  on('prompt.submit', async ($, e, next) => {
    if (/^\s*continue\s*$/i.test(e.text)) {
      const st = await load($)
      if (st.stopped) await lift($)
    }
    return next(e)
  })
}
