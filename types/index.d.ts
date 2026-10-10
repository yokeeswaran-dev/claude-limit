/** Why this session's work is stopped. */
export type LimitStopReason = 'stop-now' | 'stop-limit' | 'limit-hit'

/** The /limit settings and stop state of one session. */
export type LimitState = {
  /** Set while work is stopped; cleared by "continue" (typed, or sent by the automatic restart). */
  stopped: { reason: LimitStopReason; at: string; resetsAt?: string } | null
  /** /limit stop-limit <percent>: stop when the 5-hour usage reaches this; null when off. */
  threshold: number | null
  /** /limit continue-limit: restart THIS session after the 5-hour reset when it was stopped by the limit. */
  autoRestart: boolean
  /** When the automatic restart will send "continue" (ISO), while one is scheduled. */
  restartAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    limit: { st: LimitState }
  }
}
