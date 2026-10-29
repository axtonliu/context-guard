import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_VIEW,
  DEFAULT_SETTINGS,
  applyReading,
  compactInstructions,
  fileLink,
  resumePrompt,
  isCompactUnavailable,
  isReminderShown,
  parseCommand,
  parseReport,
  readingOf,
  tiersFor,
} from '../hooks/logic'

describe('tiers', () => {
  test('75 announces 75, 85, 90, 95', () => {
    expect(tiersFor(75)).toEqual([75, 85, 90, 95])
  })
  test('a low test threshold keeps the fixed tiers above it', () => {
    expect(tiersFor(10)).toEqual([10, 85, 90, 95])
  })
  test('a threshold above 95 is its own only tier', () => {
    expect(tiersFor(97)).toEqual([97])
  })
})

describe('readings', () => {
  test('each tier is announced once', () => {
    let v = EMPTY_VIEW
    const steps: [number, boolean][] = [
      [60, false],
      [76, true],
      [80, false],
      [86, true],
      [88, false],
      [91, true],
      [92, false],
    ]
    for (const [percent, isDue] of steps) {
      const r = applyReading(v, percent, 75)
      expect(r.isNewTier).toBe(isDue)
      v = r.view
    }
    expect(v.notifiedTier).toBe(90)
  })

  test('dropping under the threshold starts the tiers over', () => {
    let v = applyReading(EMPTY_VIEW, 80, 75).view
    v = { ...v, dismissedTier: 75 }
    v = applyReading(v, 20, 75).view
    expect(v.notifiedTier).toBe(null)
    expect(v.dismissedTier).toBe(null)
    expect(applyReading(v, 77, 75).isNewTier).toBe(true)
  })

  test('「稍后」 hides the band until the next tier', () => {
    let v = applyReading(EMPTY_VIEW, 78, 75).view
    expect(isReminderShown(v, DEFAULT_SETTINGS)).toBe(true)
    v = { ...v, dismissedTier: v.tier }
    expect(isReminderShown(v, DEFAULT_SETTINGS)).toBe(false)
    v = applyReading(v, 86, 75).view
    expect(isReminderShown(v, DEFAULT_SETTINGS)).toBe(true)
  })

  test('off hides the band', () => {
    const v = applyReading(EMPTY_VIEW, 90, 75).view
    expect(isReminderShown(v, { ...DEFAULT_SETTINGS, isEnabled: false })).toBe(false)
  })
})

describe('report', () => {
  const answer = [
    '日志写好了。',
    '<<<CONTEXT-GUARD',
    'log: /home/user/project/logs/2026-10-09-a.md',
    'goal：做完 context-guard',
    'pending: 装到 user scope；终端实测',
    'CONTEXT-GUARD>>>',
  ].join('\n')

  test('reads the block', () => {
    expect(parseReport(answer)).toEqual({
      log: '/home/user/project/logs/2026-10-09-a.md',
      goal: '做完 context-guard',
      pending: '装到 user scope；终端实测',
    })
  })

  test('takes the last block and strips backticks', () => {
    const two = `${answer}\n<<<CONTEXT-GUARD\nlog: \`/tmp/b.md\`\nCONTEXT-GUARD>>>`
    expect(parseReport(two)?.log).toBe('/tmp/b.md')
  })

  test('no block or a relative path is no report', () => {
    expect(parseReport('写好了')).toBe(null)
    expect(parseReport('<<<CONTEXT-GUARD\nlog: logs/a.md\nCONTEXT-GUARD>>>')).toBe(null)
  })

  test('the compaction names the log path', () => {
    const r = parseReport(answer)
    expect(r).not.toBe(null)
    if (r) expect(compactInstructions(r)).toContain(r.log)
  })
})

describe('command', () => {
  test('parses each form', () => {
    expect(parseCommand('')).toEqual({ kind: 'status' })
    expect(parseCommand('threshold 10')).toEqual({ kind: 'threshold', value: 10 })
    expect(parseCommand('off')).toEqual({ kind: 'enable', isEnabled: false })
    expect(parseCommand('on')).toEqual({ kind: 'enable', isEnabled: true })
    expect(parseCommand('intercept on')).toEqual({ kind: 'intercept', isOn: true })
    expect(parseCommand('reset')).toEqual({ kind: 'reset' })
    expect(parseCommand('resume off')).toEqual({ kind: 'resume', isOn: false })
  })
  test('refuses bad thresholds', () => {
    expect(parseCommand('threshold 0').kind).toBe('error')
    expect(parseCommand('threshold 100').kind).toBe('error')
    expect(parseCommand('threshold abc').kind).toBe('error')
    expect(parseCommand('bogus').kind).toBe('error')
  })
})

describe('compaction refusals', () => {
  test('an SDK session refusal falls back at once, a busy turn does not', () => {
    const sdk =
      'HooksError: context-guard: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'
    expect(isCompactUnavailable(sdk)).toBe(true)
    expect(isCompactUnavailable('HooksError: a turn is running')).toBe(false)
  })
})

describe('resume', () => {
  const log = [
    '# 日志',
    '## 总结',
    '做完了一半',
    '## 恢复会话',
    '',
    '> 下次 `/clear` 后粘贴以下内容继续工作：',
    '',
    '请阅读工作日志 /a/b.md 继续工作。',
    '下一步任务：',
    '- 写 README',
  ].join('\n')

  test('sends the recovery section as written, without the paste note', () => {
    const text = resumePrompt(log, '/a/b.md')
    expect(text.startsWith('请阅读工作日志 /a/b.md 继续工作。\n下一步任务：\n- 写 README')).toBe(true)
    expect(text).not.toContain('粘贴以下内容')
    expect(text).not.toContain('做完了一半')
    expect(text).toContain('按原计划继续执行未完成项')
    expect(text).not.toContain('等我的下一条指令')
  })

  test('keeps the quoted lines that are the log\'s own words', () => {
    const text = resumePrompt(`${log}\n> 约束：不要动 main 分支，只在 dev 上提交`, '/a/b.md')
    expect(text).toContain('> 约束：不要动 main 分支，只在 dev 上提交')
    expect(text).not.toContain('粘贴以下内容')
  })

  test('a heading inside a code block does not end the section', () => {
    const text = resumePrompt(`${log}\n\`\`\`bash\n# 先跑测试\nnpm test\n\`\`\`\n- 再提交`, '/a/b.md')
    expect(text).toContain('# 先跑测试')
    expect(text).toContain('- 再提交')
  })

  test('stops at the next section', () => {
    expect(resumePrompt(`${log}\n## 附录\n别带上我`, '/a/b.md')).not.toContain('别带上我')
  })

  test('points at the log when the section is missing or unreadable', () => {
    expect(resumePrompt('# 只有标题', '/a/b.md')).toContain('/a/b.md')
    expect(resumePrompt(null, '/a/b.md')).toContain('「恢复会话」')
  })

  test('the band link escapes spaces and brackets', () => {
    expect(fileLink('/x/2026 日志 (a).md')).toBe('[2026 日志 (a).md](file:///x/2026%20%E6%97%A5%E5%BF%97%20%28a%29.md)')
  })
})

describe('reading', () => {
  test('measures against a smaller compaction window', () => {
    const r = readingOf({ tokens: 359863, window: 1000000, percent: 36, breakdown: { rawMaxTokens: 400000 } })
    expect(r).toEqual({ percent: 90, tokens: 359863, window: 400000, isCompactWindow: true })
  })
  test('falls back to the model window without a breakdown or a smaller window', () => {
    expect(readingOf({ tokens: 300, window: 1000, percent: 30 }).percent).toBe(30)
    expect(readingOf({ tokens: 300, window: 1000, percent: 30, breakdown: { rawMaxTokens: 1000 } }).isCompactWindow).toBe(false)
  })
  test('no tokens yet is no reading', () => {
    expect(readingOf({ window: 1000, breakdown: { rawMaxTokens: 400 } }).percent).toBe(undefined)
  })
})
