import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const LOG = '/home/user/project/logs/2026-10-09-demo.md'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const RECOVERY_LOG = '# 日志\n## 恢复会话\n> 下次粘贴以下内容：\n请阅读工作日志 Demo 继续工作。\n'

type World = { percent: number; submitted: string[]; compacted: string[]; mtimeMs: number; isFile: boolean; busyFor: number; isSdk: boolean; queued: string[]; attempts: number; logText: string; compactWindow?: number }

/** The engine beneath the plugin: usage, the prompt, the compaction and the file system. */
function world(on: On, start: Partial<World> = {}): World {
  const w: World = { percent: 80, submitted: [], compacted: [], mtimeMs: 5000, isFile: true, busyFor: 0, isSdk: false, queued: [], attempts: 0, logText: RECOVERY_LOG, ...start }
  mock.store(on)
  on('session.usage' as never, ((_$: unknown, e: { breakdown?: string }) => ({
    value: {
      startedAt: 0,
      context: {
        window: 1000,
        tokens: w.percent * 10,
        percent: w.percent,
        ...(e?.breakdown !== undefined && w.compactWindow !== undefined
          ? { breakdown: { rawMaxTokens: w.compactWindow } }
          : {}),
      },
      rateLimits: [],
    },
  })) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.compact', ($, e) => {
    if (e.trigger !== 'manual') w.attempts += 1
    if (w.isSdk && e.trigger !== 'manual') {
      throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet')
    }
    if (w.busyFor > 0) {
      w.busyFor -= 1
      throw new Error('a turn is running')
    }
    w.compacted.push(e.instructions ?? '')
    w.percent = 10
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 800, tokensAfter: 100 }
  })
  on('fs.read' as never, (() => ({ value: w.logText })) as never)
  on('fs.stat', () => {
    if (!w.isFile) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 10, mtimeMs: w.mtimeMs, isLink: false } }
  })
  // The engine queues /compact until the session is idle; the test runs it with flushCompact.
  on('command.run', { command: 'compact' }, ($, e) => {
    w.queued.push(e.args)
    return { text: '' }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast' as never, (() => ({ value: undefined })) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  return w
}

/** Runs /context-guard as the person would; origin and presentation are the engine's. */
const run = ($: { command: { run: (e: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({
    command: 'context-guard',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as never)

const done = (turnId: string, answer = '') =>
  ({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const

const reportFor = (log: string) =>
  `日志写好了。\n<<<CONTEXT-GUARD\nlog: ${log}\ngoal: 做完 context-guard\npending: 装到 user scope\nCONTEXT-GUARD>>>`

for (const surface of ['terminal', 'desktop'] as const) {
  test(`reminder → button → log → compact on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 4000 })
    const w = world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    await $.turn.complete(done('t0'))
    const ui = await $.ui.mount({ plugin: 'context-guard', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: '上下文已用 80%' }))).toBeDefined()

    await ui.press({ key: 'log-and-compact' })
    expect(w.submitted.length).toBe(1)
    const text = w.submitted[0] ?? ''
    expect(text).toContain('work-log-share')
    expect(text).toContain('<<<CONTEXT-GUARD')
    expect(await ui.find({ type: 'Text', text: '正在写工作日志' })).toBeDefined()

    await $.turn.start({ text, turnId: 't1' })
    await $.turn.complete(done('t1', reportFor(LOG)))
    await clock.advance(3000)
    await clock.settle()

    expect(w.compacted.length).toBe(1)
    expect(w.compacted[0]).toContain(LOG)
    expect(w.compacted[0]).toContain('做完 context-guard')
    expect(await ui.find({ type: 'Markdown', text: '已压缩' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'file:///home/user' })).toBeDefined()
    // The log's recovery prompt goes out as the next message.
    await clock.settle()
    expect(w.submitted.length).toBe(2)
    expect(w.submitted[1]).toContain('请阅读工作日志 Demo 继续工作。')
    expect(w.submitted[1]).not.toContain('粘贴以下内容')
    await ui.unmount()
  })
}

test('no compaction when the log file is missing', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on, { isFile: false })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'terminal', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete(done('t1', reportFor(LOG)))
  await clock.advance(3000)
  expect(w.compacted.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: '日志文件不存在' })).toBeDefined()
  await ui.unmount()
})

test('no compaction without the report block', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'terminal', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete(done('t1', '写好了'))
  await clock.advance(3000)
  expect(w.compacted.length).toBe(0)
  await ui.unmount()
})

test('threshold, off and on through the command', async ($, on) => {
  mock.clock(on, { now: 4000 })
  const w = world(on, { percent: 30 })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '上下文已用' })).toBeUndefined()

  const set = await run($, 'threshold 20')
  expect(set.text).toContain('20%')
  expect(await ui.find({ type: 'Text', text: '上下文已用 30%' })).toBeDefined()

  await run($, 'off')
  expect(await ui.find({ type: 'Text', text: '上下文已用' })).toBeUndefined()
  await run($, 'on')
  expect(await ui.find({ type: 'Text', text: '上下文已用 30%' })).toBeDefined()

  const status = await run($, '')
  expect(status.text).toContain('阈值：20%')
  expect(w.compacted.length).toBe(0)
  await ui.unmount()
})

test('automatic compaction passes by default', async ($, on) => {
  mock.clock(on, { now: 4000 })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.session.compact({ trigger: 'auto', messages: [] } as never)
  expect(r.skip).toBeUndefined()
  expect(w.compacted.length).toBe(1)
})

test('intercept on skips only the first automatic compaction', async ($, on) => {
  mock.clock(on, { now: 4000 })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await run($, 'intercept on')
  const auto = { trigger: 'auto', messages: [] } as never
  expect((await $.session.compact(auto)).skip).toContain('只拦一次')
  expect(w.compacted.length).toBe(0)
  expect((await $.session.compact(auto)).skip).toBeUndefined()
  expect(w.compacted.length).toBe(1)
})

test('a refused compaction is retried on the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on, { busyFor: 2 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete(done('t1', reportFor(LOG)))
  await clock.advance(1600)
  expect(w.compacted.length).toBe(0)
  await clock.advance(6000)
  expect(w.compacted.length).toBe(1)
  expect(await ui.find({ type: 'Markdown', text: '已压缩' })).toBeDefined()
  await ui.unmount()
})

test('a session that keeps refusing hands the compaction to /compact', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on, { isSdk: true })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete(done('t1', reportFor(LOG)))
  await clock.advance(1600 * 9)
  expect(w.queued.length).toBe(0)
  await clock.advance(1600 * 2)
  expect(w.queued.length).toBe(1)
  expect(w.queued[0]).toContain(LOG)
  // While the queued /compact waits (a compaction takes a minute), nothing else is tried or queued.
  const tried = w.attempts
  await clock.advance(1600 * 30)
  expect(w.attempts).toBe(tried)
  expect(w.queued.length).toBe(1)
  // The queued /compact runs once the session is idle.
  await $.session.compact({ trigger: 'manual', instructions: w.queued[0], messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(w.compacted.length).toBe(1)
  expect(await ui.find({ type: 'Markdown', text: '已压缩' })).toBeDefined()
  await ui.unmount()
})

test('the band counts against the auto-compact window', async ($, on) => {
  // 400 of a 1000-token model window is 40%, but 80% of a 500-token compaction window.
  const w = world(on, { percent: 40, compactWindow: 500 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '上下文已用 80%' })).toBeDefined()
  expect((await run($, '')).text).toContain('按自动压缩窗口')
  expect(w.compacted.length).toBe(0)
  await ui.unmount()
})

test('resume off sends nothing after the compaction', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect((await run($, 'resume off')).text).toContain('不再自动')
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.start({ text: w.submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete(done('t1', reportFor(LOG)))
  await clock.advance(3000)
  await clock.settle()
  expect(w.compacted.length).toBe(1)
  expect(w.submitted.length).toBe(1)
  await ui.unmount()
})

test('the log turn is found by its report when turn.start never named it', async ($, on) => {
  const clock = mock.clock(on, { now: 4000 })
  const w = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(done('t0'))
  const ui = await $.ui.mount({ plugin: 'context-guard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'log-and-compact' })
  await $.turn.complete(done('t1', reportFor(LOG)))
  await clock.advance(3000)
  expect(w.compacted.length).toBe(1)
  await ui.unmount()
})
