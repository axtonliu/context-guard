/** Where the guard stands in its log-then-compact flow. */
export type Phase = 'idle' | 'logging' | 'compacting'

/** What the band draws: the last reading and the flow's progress. */
export type GuardView = {
  /** The context window's fill after the last main-loop turn, or null before one. */
  percent: number | null
  /** The highest tier that reading reached, or null below the threshold. */
  tier: number | null
  /** The tier already toasted, so a tier is announced once. */
  notifiedTier: number | null
  /** The tier the person dismissed with 「稍后」; the band stays hidden until a higher one. */
  dismissedTier: number | null
  phase: Phase
  /** The turn the log prompt started, matched at turn.complete. */
  logTurnId: string | null
  /** The nonce the log prompt carries, matched at turn.start. */
  nonce: string | null
  /** When the button was pressed, ms since the epoch; the log must be newer. */
  pressedAt: number | null
  /** The last outcome line, shown in the band until dismissed. */
  message: string | null
  /** Whether the message reports a failure. */
  isError: boolean
  /** The log path the last flow wrote. */
  logPath: string | null
  /** What the pending compaction tells the summarizer, held while phase is compacting. */
  instructions: string | null
  /** Whether the compaction was handed to a queued /compact, which nothing can withdraw. */
  isQueued?: boolean
  /** The last steps of the flow, newest last, for /context-guard to show. */
  trace: string[]
}

/** The person's settings, kept across sessions in $.store. */
export type GuardSettings = {
  isEnabled: boolean
  threshold: number
  /** Skip the first automatic compaction of a session so the person can log first. Off by default. */
  interceptAuto: boolean
  /** After a compaction, send the log's recovery prompt as the next message. On by default. */
  autoResume: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-guard': {
      view: GuardView
      settings: GuardSettings
      /** Set once this session's first automatic compaction was skipped. */
      autoSkipped: boolean
    }
  }
}
