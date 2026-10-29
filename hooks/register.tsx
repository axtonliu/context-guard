import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardSettings, GuardView } from '../types'
import type { Reading } from './logic'
import {
  DEFAULT_SETTINGS,
  EMPTY_VIEW,
  USAGE,
  applyReading,
  compactInstructions,
  fileLink,
  isCompactUnavailable,
  isReminderShown,
  logPrompt,
  parseCommand,
  parseReport,
  readingOf,
  resumePrompt,
  tiersFor,
} from './logic'

const view = atom({ plugin: 'context-guard', key: 'view' } as const, EMPTY_VIEW)
const settings = atom({ plugin: 'context-guard', key: 'settings' } as const, DEFAULT_SETTINGS)
const autoSkipped = atom({ plugin: 'context-guard', key: 'autoSkipped' } as const, false)

const STORE_KEY = 'settings'
// The log must be written after the press; allow for a coarse filesystem clock.
const MTIME_SLACK_MS = 5000

type $ = EngineInterface

const TRACE_SIZE = 20

/** Appends one step to the flow's trace, so a stalled flow says where it stopped. */
async function note($: $, text: string): Promise<void> {
  const at = new Date(await $.clock.now()).toTimeString().slice(0, 8)
  await update($, view, v => ({ ...v, trace: [...(v.trace ?? []), `${at} ${text}`].slice(-TRACE_SIZE) }))
}

function newNonce(): string {
  return crypto.randomUUID().slice(0, 8)
}

async function saveSettings($: $, next: GuardSettings): Promise<void> {
  await update($, settings, () => next)
  await $.store.set(STORE_KEY, next)
}

/** The live reading; the summary breakdown is estimated locally and sends no request. */
async function currentReading($: $): Promise<Reading> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
  return readingOf(usage.context)
}

async function currentPercent($: $): Promise<number | undefined> {
  return (await currentReading($)).percent
}

/** Folds the live reading into the view and toasts a tier the first time it is reached. */
async function takeReading($: $): Promise<void> {
  const s = await read($, settings)
  const percent = await currentPercent($)
  let isDue = false
  await update($, view, v => {
    const folded = applyReading(v, percent, s.threshold)
    isDue = folded.isNewTier
    return folded.view
  })
  const v = await read($, view)
  if (isDue && s.isEnabled && v.phase === 'idle') {
    $.ui.toast(`上下文已用 ${v.percent}%，做完当前任务后建议写日志并压缩`, { timeoutMs: 8000 })
  }
}

async function fail($: $, message: string): Promise<void> {
  await note($, `fail: ${message}`)
  await update($, view, v => ({
    ...v,
    phase: 'idle' as const,
    logTurnId: null,
    nonce: null,
    instructions: null,
    message,
    isError: true,
  }))
  $.ui.toast(`context-guard：${message}`, { timeoutMs: 8000 })
}

/** Whether the flow `nonce` started is still the one running, i.e. nobody pressed 取消 since. */
async function isCurrent($: $, nonce: string | null): Promise<boolean> {
  return nonce !== null && (await read($, view)).nonce === nonce
}

async function startLogging($: $): Promise<void> {
  const v = await read($, view)
  if (v.phase !== 'idle') return
  const nonce = newNonce()
  const pressedAt = await $.clock.now()
  await update($, view, old => ({
    ...old,
    phase: 'logging' as const,
    nonce,
    pressedAt,
    logTurnId: null,
    message: null,
    isError: false,
    instructions: null,
    isQueued: false,
  }))
  await note($, `press: nonce=${nonce}`)
  try {
    const sent = await $.prompt.submit({ text: logPrompt(nonce, v.percent) })
    await note($, `prompt.submit resolved${sent.drop !== undefined ? ` drop=${sent.drop}` : ''}`)
    if (sent.drop !== undefined && (await isCurrent($, nonce))) await fail($, `写日志的消息被拦下：${sent.drop}`)
  } catch (err) {
    if (await isCurrent($, nonce)) await fail($, `写日志的消息没有发出去：${String(err)}`)
  }
}

/** Checks the log turn's answer and the file on disk; only then queues the compaction. */
async function finishLogging($: $, answer: string, isAnswered: boolean): Promise<void> {
  if (!isAnswered) {
    await fail($, '写日志那一轮没有正常结束，未压缩')
    return
  }
  const report = parseReport(answer)
  if (report === null) {
    await fail($, '回复里没找到 CONTEXT-GUARD 块，不知道日志在哪，未压缩')
    return
  }
  const v = await read($, view)
  const stat = await $.fs.stat(report.log).catch(async (err: unknown) => {
    await note($, `fs.stat failed: ${String(err)}`)
    return undefined
  })
  if (!(await isCurrent($, v.nonce))) {
    await note($, 'cancelled while the log was checked')
    return
  }
  await note($, `fs.stat ${report.log}: ${stat === undefined ? 'none' : `${stat.kind} mtime=${stat.mtimeMs} pressedAt=${v.pressedAt}`}`)
  if (stat === undefined || stat.kind !== 'file') {
    await fail($, `日志文件不存在：${report.log}，未压缩`)
    return
  }
  if (v.pressedAt !== null && stat.mtimeMs < v.pressedAt - MTIME_SLACK_MS) {
    await fail($, `日志文件不是这次写的（修改时间早于点击）：${report.log}，未压缩`)
    return
  }
  // The nonce stays: it names this flow until it ends, so a 取消 can be told from it.
  await update($, view, old => ({
    ...old,
    phase: 'compacting' as const,
    logTurnId: null,
    logPath: report.log,
    instructions: compactInstructions(report),
    isQueued: false,
  }))
  await note($, 'log verified, compaction pending')
}

// A compaction only runs between turns, and a timer a hook starts may not outlive that
// hook's dispatch: one interval started at session.start polls for a pending compaction.
const POLL_MS = 1500
// After this many refusals in a row, hand /compact to the engine, which queues it until idle.
const FALLBACK_AFTER = 10

let isPolling = false
let refusals = 0
let lastRefusal = ''

async function pollCompact($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const v = await read($, view)
    if (v.phase !== 'compacting' || v.instructions === null || v.isQueued === true) {
      refusals = 0
      return
    }
    await tryCompact($, v.instructions, v.nonce)
  } finally {
    isPolling = false
  }
}

async function tryCompact($: $, instructions: string, nonce: string | null): Promise<void> {
  let result
  try {
    result = await $.session.compact({ instructions })
    await note($, `compact resolved: ${result.skip !== undefined ? `skip=${result.skip}` : `${result.tokensBefore ?? '?'} -> ${result.tokensAfter ?? '?'}`}`)
  } catch (err) {
    if (!(await isCurrent($, nonce))) return
    refusals += 1
    const why = String(err)
    if (why !== lastRefusal) {
      lastRefusal = why
      await note($, `compact refused (${refusals}): ${why}`)
      await update($, view, old => ({ ...old, message: `压缩暂未执行，等会话空闲后重试：${why}` }))
    }
    if (refusals === FALLBACK_AFTER || (isCompactUnavailable(why) && refusals === 1)) {
      await note($, 'falling back to /compact through $.command.run')
      // isQueued stops the poller, so the queued /compact is the only one; the session.compact
      // hook still sees phase compacting and finishes the flow. The instructions stay for an
      // automatic compaction that may come first.
      refusals = 0
      lastRefusal = ''
      await update($, view, old => ({ ...old, isQueued: true, message: '改用 /compact 排队执行，会话空闲时开始' }))
      // Settles once the queued /compact has run; the session.compact hook records the outcome.
      void $.command.run({ command: 'compact', args: instructions }).catch(async (e: unknown) => {
        if (await isCurrent($, nonce)) await fail($, `/compact 也没能执行：${String(e)}`)
      })
    }
    return
  }
  refusals = 0
  lastRefusal = ''
  if (!(await isCurrent($, nonce))) {
    // 取消 came while the compaction ran: it stands, but the flow stops here.
    if (result.skip === undefined) {
      await note($, 'compacted after 取消, no resume')
      await update($, view, old => ({ ...old, message: '取消时压缩已经开始，已压缩完成；不会自动发恢复 prompt', isError: false }))
    }
    return
  }
  if (result.skip !== undefined) {
    await fail($, `压缩被跳过：${result.skip}`)
    return
  }
  await finishCompact($, result.tokensBefore, result.tokensAfter)
}

async function finishCompact($: $, before?: number, after?: number): Promise<void> {
  const sizes = before !== undefined && after !== undefined ? `（${before} → ${after} tokens）` : ''
  const { logPath } = await read($, view)
  const { autoResume } = await read($, settings)
  const willResume = autoResume && logPath !== null
  await update($, view, old => ({
    ...EMPTY_VIEW,
    trace: old.trace,
    logPath: old.logPath,
    message: `已压缩${sizes}${willResume ? '，已发出恢复 prompt' : ''}。日志：${old.logPath ?? '（未知）'}`,
    isError: false,
  }))
  $.ui.toast(`context-guard：已写日志并压缩${sizes}`, { timeoutMs: 6000 })
  if (willResume) await sendResume($, logPath)
}

/** Sends the log's recovery prompt as the person's next message; it runs once the session is idle. */
async function sendResume($: $, logPath: string): Promise<void> {
  const text = await $.fs.read(logPath).catch(async (err: unknown) => {
    await note($, `fs.read failed: ${String(err)}`)
    return null
  })
  await note($, `resume prompt queued (${text === null ? 'pointer' : 'from log'})`)
  // Not awaited: this may run inside the session.compact hook, and submit resolves only when the turn starts.
  void $.prompt.submit({ text: resumePrompt(text, logPath), asUser: true }).catch(async (err: unknown) => {
    await note($, `resume prompt failed: ${String(err)}`)
  })
}

/**
 * 取消: the flow stops and sends nothing more. A /compact already queued cannot be withdrawn,
 * so it still runs, but as someone else's compaction: no recovery prompt follows.
 */
async function cancel($: $): Promise<void> {
  refusals = 0
  lastRefusal = ''
  await update($, view, old => ({
    ...old,
    phase: 'idle' as const,
    instructions: null,
    nonce: null,
    logTurnId: null,
    isQueued: false,
    message: old.isQueued === true ? '已取消：排队的 /compact 撤不回，仍会在会话空闲时执行，但压缩后不会自动发恢复 prompt' : null,
    isError: false,
  }))
  await note($, 'cancelled')
}

async function statusText($: $): Promise<string> {
  const s = await read($, settings)
  const v = await read($, view)
  const r = await currentReading($)
  const used =
    r.percent === undefined
      ? '暂无读数（新会话或刚压缩，等下一次回复）'
      : `${r.percent}%（${r.tokens ?? '?'} / ${r.window} tokens，${r.isCompactWindow ? '按自动压缩窗口' : '按模型窗口'}）`
  return [
    `context-guard：${s.isEnabled ? '开启' : '关闭'}`,
    `当前占用：${used}`,
    `阈值：${s.threshold}%，提醒档位：${tiersFor(s.threshold).join('% / ')}%`,
    `已提醒到：${v.notifiedTier === null ? '无' : `${v.notifiedTier}%`}；阶段：${v.phase}`,
    `压缩后自动发恢复 prompt：${s.autoResume ? '开' : '关'}`,
    `自动压缩拦截：${s.interceptAuto ? `开（本会话${(await read($, autoSkipped)) ? '已拦过一次' : '尚未拦截'}）` : '关'}`,
    v.logPath === null ? '' : `上次日志：${v.logPath}`,
    v.phase === 'idle' ? '' : `流程：nonce=${v.nonce} logTurnId=${v.logTurnId} pressedAt=${v.pressedAt}`,
    v.message === null ? '' : `提示：${v.message}`,
    (v.trace ?? []).length === 0 ? '' : `轨迹：\n${(v.trace ?? []).join('\n')}`,
    USAGE,
  ]
    .filter(Boolean)
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get(STORE_KEY)) as Partial<GuardSettings> | undefined
    await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
    await $.command.register({
      name: 'context-guard',
      description: '查看上下文占用与提醒阈值，或调整：threshold <数字> | on | off',
      argumentHint: '[threshold <1-99> | on | off | intercept on|off | resume on|off | reset]',
      immediate: true,
    })
    $.clock.every(POLL_MS, () => {
      void pollCompact($)
    })
    return next(e)
  })

  on('command.run', { command: 'context-guard' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    const s = await read($, settings)
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'status':
        return { text: await statusText($) }
      case 'threshold':
        await saveSettings($, { ...s, threshold: cmd.value })
        // Tiers start over under the new threshold, and the band reflects it now.
        await update($, view, v => ({ ...v, notifiedTier: null, dismissedTier: null }))
        await takeReading($)
        return { text: `阈值改为 ${cmd.value}%，提醒档位：${tiersFor(cmd.value).join('% / ')}%` }
      case 'enable':
        await saveSettings($, { ...s, isEnabled: cmd.isEnabled })
        if (cmd.isEnabled) await takeReading($)
        return { text: cmd.isEnabled ? 'context-guard 已开启' : 'context-guard 已关闭（不再提醒，命令仍可用）' }
      case 'intercept':
        await saveSettings($, { ...s, interceptAuto: cmd.isOn })
        return {
          text: cmd.isOn
            ? '已开启：每个会话的第一次自动压缩会被跳过一次，留时间写日志；第二次照常压缩'
            : '已关闭自动压缩拦截'
        }
      case 'resume':
        await saveSettings($, { ...s, autoResume: cmd.isOn })
        return { text: cmd.isOn ? '已开启：压缩后自动发出日志里的恢复 prompt' : '已关闭：压缩后不再自动发恢复 prompt' }
      case 'reset':
        await update($, view, () => EMPTY_VIEW)
        await takeReading($)
        return { text: 'context-guard 状态已重置' }
    }
  })

  on('turn.start', async ($, e, next) => {
    const v = await read($, view)
    if (v.phase === 'logging' && v.logTurnId === null && v.nonce !== null) {
      const isOurs = e.text.includes(`[context-guard:${v.nonce}]`)
      await note($, `turn.start ${e.turnId} ours=${isOurs} text=${JSON.stringify(e.text.slice(0, 40))}`)
      if (isOurs) await update($, view, old => ({ ...old, logTurnId: e.turnId }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const v = await read($, view)
    const hasReport = parseReport(e.answer) !== null
    if (v.phase !== 'idle') {
      await note($, `turn.complete ${e.turnId} reason=${e.reason} logTurnId=${v.logTurnId} report=${hasReport}`)
    }
    // turn.start normally names the log turn; a report block in the answer is the fallback.
    const isLogTurn = v.logTurnId === e.turnId || (v.logTurnId === null && hasReport)
    if (v.phase === 'logging' && isLogTurn) {
      await finishLogging($, e.answer, e.reason === 'answer')
    }
    await takeReading($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const s = await read($, settings)
    const flow = await read($, view)
    if (e.trigger === 'auto' && flow.phase === 'logging') {
      // Compacting now would cut the log turn short; once it ends, the compaction carries the log.
      await note($, 'automatic compaction skipped while the log is written')
      return { skip: 'context-guard 正在写工作日志，先跳过这次自动压缩，日志写完会自动压缩' }
    }
    if (e.trigger === 'auto' && s.interceptAuto && s.isEnabled && !(await read($, autoSkipped))) {
      // Once per session only, so a full context still compacts on the next try.
      await update($, autoSkipped, () => true)
      await update($, view, old => ({
        ...old,
        message: '已拦下一次自动压缩：建议现在点「写日志并压缩」；下一次自动压缩不会再拦',
        isError: true,
      }))
      return { skip: 'context-guard 拦下了这次自动压缩，先写日志再压缩（只拦一次）' }
    }
    // An automatic compaction while ours is pending does its job: it tells the summarizer about the log.
    const isPending = e.trigger === 'auto' && flow.phase === 'compacting' && flow.instructions !== null
    const result = await next(isPending ? { ...e, instructions: flow.instructions ?? undefined } : e)
    if (result.skip === undefined && e.trigger !== 'plugin') {
      const v = await read($, view)
      if (v.phase === 'compacting') {
        await note($, `compacted by ${e.trigger}`)
        await finishCompact($, result.tokensBefore, result.tokensAfter)
        return result
      }
      // Someone else compacted (/compact or auto): the tiers start over, a pending flow is moot.
      await update($, view, old => ({
        ...EMPTY_VIEW,
        trace: old.trace,
        logPath: old.logPath,
        message: old.phase === 'idle' ? old.message : '会话已被其他方式压缩，本次流程结束',
        isError: false,
      }))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const v = await read($, view)
    const s = await read($, settings)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)

    if (v.phase === 'logging' || v.phase === 'compacting') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="warning">
            {v.phase === 'logging'
              ? 'context-guard：正在写工作日志，这一轮结束后自动压缩'
              : v.isQueued === true
                ? 'context-guard：日志已落盘，/compact 已排队，会话空闲时执行（已撤不回）'
                : 'context-guard：日志已落盘，正在压缩'}
            {v.phase === 'compacting' && v.isQueued !== true && v.message !== null ? `（${v.message}）` : ''}
          </Text>
          <Button key="cancel" label={v.isQueued === true ? '不要自动恢复' : '取消'} dimColor onPress={() => cancel($)} />
        </Box>
      )
    }

    const isReminder = isReminderShown(v, s)
    if (!isReminder && v.message === null) return next(e)

    return (
      <Box flexDirection="column">
        {v.message !== null && (
          <Box flexDirection="row" gap={1}>
            {!v.isError && v.logPath !== null && v.message.includes(v.logPath) ? (
              <Markdown text={`context-guard：${v.message.replace(v.logPath, fileLink(v.logPath))}`} />
            ) : (
              <Text color={v.isError ? 'error' : 'success'}>context-guard：{v.message}</Text>
            )}
            <Button key="ok" label="知道了" dimColor onPress={() => update($, view, old => ({ ...old, message: null, isError: false }))} />
          </Box>
        )}
        {isReminder && (
          <Box flexDirection="row" gap={1}>
            <Text color="warning" bold>
              上下文已用 {v.percent}%，做完当前任务后建议写日志并压缩
            </Text>
            <Button key="log-and-compact" label="写日志并压缩" variant="primary" onPress={() => void startLogging($)} />
            <Button key="later" label="稍后" dimColor onPress={() => update($, view, old => ({ ...old, dismissedTier: old.tier }))} />
          </Box>
        )}
      </Box>
    )
  })
}
