import type { GuardSettings, GuardView } from '../types'

export const DEFAULT_SETTINGS: GuardSettings = {
  isEnabled: true,
  threshold: 75,
  interceptAuto: false,
  autoResume: true,
}

export const EMPTY_VIEW: GuardView = {
  percent: null,
  tier: null,
  notifiedTier: null,
  dismissedTier: null,
  phase: 'idle',
  logTurnId: null,
  nonce: null,
  pressedAt: null,
  message: null,
  isError: false,
  logPath: null,
  instructions: null,
  isQueued: false,
  trace: [],
}

export type Reading = { percent?: number; tokens?: number; window: number; isCompactWindow: boolean }

/**
 * The fill measured against the window that matters: the compaction window when the
 * breakdown names one (an autoCompactWindow setting smaller than the model's), else the
 * model's own window as the status line counts it.
 */
export function readingOf(context: {
  tokens?: number
  window: number
  percent?: number
  breakdown?: { rawMaxTokens: number }
}): Reading {
  const compactWindow = context.breakdown?.rawMaxTokens
  if (compactWindow === undefined || compactWindow <= 0 || compactWindow >= context.window) {
    return { percent: context.percent, tokens: context.tokens, window: context.window, isCompactWindow: false }
  }
  const percent = context.tokens === undefined ? undefined : Math.round((context.tokens / compactWindow) * 100)
  return { percent, tokens: context.tokens, window: compactWindow, isCompactWindow: true }
}

const FIXED_TIERS = [85, 90, 95]

/** The tiers a threshold announces: the threshold itself, then 85, 90 and 95 above it. */
export function tiersFor(threshold: number): number[] {
  const all = [threshold, ...FIXED_TIERS.filter(t => t > threshold)]
  return [...new Set(all)].sort((a, b) => a - b)
}

/** The highest tier `percent` has reached, or null below the threshold. */
export function tierOf(percent: number, threshold: number): number | null {
  let reached: number | null = null
  for (const t of tiersFor(threshold)) {
    if (percent >= t) reached = t
  }
  return reached
}

/** Folds a new reading into the view; `isNewTier` says a toast is due. */
export function applyReading(
  view: GuardView,
  percent: number | undefined,
  threshold: number,
): { view: GuardView; isNewTier: boolean } {
  if (percent === undefined) {
    return { view: { ...view, percent: null, tier: null }, isNewTier: false }
  }
  const tier = tierOf(percent, threshold)
  if (tier === null) {
    // Back under the threshold (a compaction, a raised threshold): the tiers start over.
    return {
      view: { ...view, percent, tier: null, notifiedTier: null, dismissedTier: null },
      isNewTier: false,
    }
  }
  const isNewTier = view.notifiedTier === null || tier > view.notifiedTier
  return {
    view: { ...view, percent, tier, notifiedTier: isNewTier ? tier : view.notifiedTier },
    isNewTier,
  }
}

/** Whether the band shows the reminder (not counting a progress or outcome line). */
export function isReminderShown(view: GuardView, settings: GuardSettings): boolean {
  return (
    settings.isEnabled &&
    view.phase === 'idle' &&
    view.tier !== null &&
    (view.dismissedTier === null || view.tier > view.dismissedTier)
  )
}

export type LogReport = { log: string; goal: string; pending: string }

const BLOCK = /<<<CONTEXT-GUARD\s*([\s\S]*?)CONTEXT-GUARD>>>/g

/** Reads the last CONTEXT-GUARD block from the model's answer. */
export function parseReport(answer: string): LogReport | null {
  const blocks = [...answer.matchAll(BLOCK)]
  const body = blocks.at(-1)?.[1]
  if (body === undefined) return null
  const field = (name: string): string => {
    const m = body.match(new RegExp(`^\\s*[-*]?\\s*${name}\\s*[:：]\\s*(.*)$`, 'm'))
    return (m?.[1] ?? '').trim().replace(/^`(.*)`$/, '$1').trim()
  }
  const log = field('log')
  if (!log.startsWith('/')) return null
  return { log, goal: field('goal') || '（未给出）', pending: field('pending') || '（未给出）' }
}

export function logPrompt(nonce: string, percent: number | null): string {
  const used = percent === null ? '' : `上下文已用 ${percent}%。`
  return [
    `[context-guard:${nonce}] ${used}请调用 work-log-share skill，用交接模式为当前会话写工作日志：`,
    '1. 保存到当前项目已有的日志目录，没有就用 logs/；',
    '2. 恢复段用二级标题「## 恢复会话」；',
    '3. 保存后 read-back，确认文件已经落盘；',
    '4. 不要自己执行 /compact，本轮结束后 context-guard 会自动压缩。',
    '',
    '回复的最后，原样输出下面这个块（不放进代码块，尖括号保留），context-guard 靠它找到日志：',
    '<<<CONTEXT-GUARD',
    'log: <日志文件的绝对路径>',
    'goal: <当前目标，一句话>',
    'pending: <未完成项，用「；」分隔，没有就写「无」>',
    'CONTEXT-GUARD>>>',
  ].join('\n')
}

export function compactInstructions(report: LogReport): string {
  return [
    `压缩前已写好工作日志，完整记录与恢复 prompt 都在：${report.log}`,
    `当前目标：${report.goal}`,
    `未完成项：${report.pending}`,
    '摘要里必须原样保留上面这个日志的绝对路径，并写明：需要细节或恢复上下文时，先读该日志的恢复节。',
  ].join('\n')
}

/**
 * Whether a refused $.session.compact will never succeed in this session, as in Desktop Code,
 * which the engine runs as an SDK session: then /compact is the only way, so fall back at once.
 */
export function isCompactUnavailable(error: string): boolean {
  return /not available/i.test(error)
}

const RESUME_TAIL =
  '（context-guard 在压缩后自动发出）恢复上下文后，先用几句话确认你掌握的当前状态和下一步，然后直接按原计划继续执行未完成项，不要停下来等我。只有原计划已经全部完成、或下一步必须由我拍板时，才停下等我的指令。'

const PASTE_NOTE = /粘贴|\/clear/

/**
 * The prompt sent after a compaction: the log's own 恢复会话 section as written (without the
 * "paste this after /clear" note that opens it), or a pointer to it when the section is missing.
 * Quotes elsewhere in the section are the log's own words and stay, and a heading inside a
 * code block does not end the section.
 */
export function resumePrompt(logText: string | null, logPath: string): string {
  const lines = (logText ?? '').split('\n')
  const start = lines.findIndex(l => /^#{2,3}\s*恢复会话/.test(l))
  let body = ''
  if (start !== -1) {
    const rest = lines.slice(start + 1)
    let isFenced = false
    const end = rest.findIndex(l => {
      if (/^\s*(```|~~~)/.test(l)) isFenced = !isFenced
      return !isFenced && /^#{1,2}\s/.test(l)
    })
    const section = end === -1 ? rest : rest.slice(0, end)
    const first = section.findIndex(l => l.trim() !== '')
    const isNote = first !== -1 && section[first]!.startsWith('>') && PASTE_NOTE.test(section[first]!)
    body = section
      .filter((_, i) => !(isNote && i === first))
      .join('\n')
      .trim()
  }
  if (body === '') body = `请阅读工作日志 ${logPath} 末尾的「恢复会话」节，按它恢复上下文。`
  return `${body}\n\n${RESUME_TAIL}`
}

/** A file:// link for the band, the path's spaces and brackets escaped for markdown. */
export function fileLink(path: string): string {
  const name = (path.split('/').at(-1) ?? path).replace(/[[\]]/g, '\\$&')
  const href = encodeURI(`file://${path}`).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${name}](${href})`
}

export type Command =
  | { kind: 'status' }
  | { kind: 'threshold'; value: number }
  | { kind: 'enable'; isEnabled: boolean }
  | { kind: 'intercept'; isOn: boolean }
  | { kind: 'resume'; isOn: boolean }
  | { kind: 'reset' }
  | { kind: 'error'; text: string }

export const USAGE =
  '用法：/context-guard [status] | threshold <1-99> | on | off | intercept on|off | resume on|off | reset'

export function parseCommand(args: string): Command {
  const [verb = 'status', arg, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (rest.length > 0) return { kind: 'error', text: USAGE }
  switch (verb) {
    case 'status':
      return arg === undefined ? { kind: 'status' } : { kind: 'error', text: USAGE }
    case 'on':
    case 'off':
      return arg === undefined ? { kind: 'enable', isEnabled: verb === 'on' } : { kind: 'error', text: USAGE }
    case 'reset':
      return arg === undefined ? { kind: 'reset' } : { kind: 'error', text: USAGE }
    case 'threshold': {
      const value = Number(arg)
      if (!Number.isInteger(value) || value < 1 || value > 99) {
        return { kind: 'error', text: '阈值要是 1 到 99 之间的整数，例如 /context-guard threshold 75' }
      }
      return { kind: 'threshold', value }
    }
    case 'intercept':
    case 'resume':
      if (arg === 'on' || arg === 'off') return { kind: verb, isOn: arg === 'on' }
      return { kind: 'error', text: USAGE }
    default:
      return { kind: 'error', text: USAGE }
  }
}
