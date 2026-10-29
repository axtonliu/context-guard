# context-guard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)

A Claude Code mod that warns you before your context fills up, and on one click writes a work log, compacts, then hands the log's resume prompt back to the session, so a long task survives compaction.

## Status

> **Status: Experimental**
>
> - A small prototype I use every day. It works for my sessions, but it has not been tested across every Claude Code version and setup.
> - The quality of the log depends on the model writing it.
> - Low-maintenance project. If something breaks, please open an issue with a reproducible case (steps, Claude Code version, CLI or Desktop, and the output of `/context-guard`). That output includes local file paths and the first words of prompts sent while a log was being written, so remove anything private before posting.

## Why

On a long task, automatic compaction keeps a summary but loses the details you need to keep going: what was decided, why, which ideas were dropped, and what is left. context-guard makes the order explicit: write the log first, check it is on disk, then compact, then resume from the log.

## What it does

When the context passes a threshold (75% by default), a band appears above the prompt:

> 上下文已用 X%，做完当前任务后建议写日志并压缩　［写日志并压缩］［稍后］

The band's text is in Chinese (it says "Context is X% used; when you finish the current task, consider writing a log and compacting", with the buttons "Write log and compact" and "Later"). The prompts it sends into the session and the bundled skill are in Chinese too, so the log comes out in Chinese unless you ask for another language.

It only reminds. Nothing happens until you press the button. Each tier (the threshold, then 85 / 90 / 95) is announced once, and 「稍后」 (Later) hides the band until the next tier.

The percentage is measured against the auto-compact window when you set one smaller than the model's window (for example 400k on a 1M model), which is the same figure Desktop's context popover shows. Otherwise it is measured against the model's window.

Pressing 「写日志并压缩」 (Write log and compact):

1. Submits a prompt asking Claude to write a work log with the bundled `work-log-share` skill, into the project's existing log folder or `logs/`. The log ends with a `## 恢复会话` (Resume session) section that can be pasted into a fresh session, and the answer ends with a `CONTEXT-GUARD` block naming the log path, the goal and what is left.
2. When that turn ends, checks the block and checks that the file exists and was written after you pressed the button. If either check fails, it stops and tells you why. It does not compact.
3. Compacts, telling the summarizer the log's absolute path, the goal and the open items, so the summary keeps a pointer to the log.
4. After compaction, sends the log's `## 恢复会话` section as your next message, ending with "confirm the state, then carry on with the plan; stop for me only when the plan is done or a decision is mine". Work picks up by itself, and the session waits only when there is nothing left to do. The band shows the log path as a clickable link. Turn this off with `/context-guard resume off`.

In the CLI it compacts through the mod API. In Claude Desktop, where that call is not available, it queues `/compact` with the same instructions instead, and the compaction runs when the session is idle.

## The bundled log skill

The button is only a trigger. Whether you can pick the work back up depends on what the log keeps, so context-guard ships with `work-log-share`, a plain Markdown skill with no scripts or external services. It asks for:

- the goal and where things stand,
- decisions and why they were made,
- what was deliberately left undone, so the next session does not "fix" it,
- judgments that were overturned, and what changed them,
- files, commits and how each claim was verified,
- what is left, and a `## 恢复会话` (Resume session) section you can paste into a new session.

You can also use it on its own: ask Claude to "use work-log-share to write a work log" at any point.

## Privacy and safety

- No network calls of its own and no hidden model calls. It only sends messages into your current session (the log prompt when you press the button, and the resume prompt after compaction) and uses Claude Code's own compaction.
- The only files it touches are the log it asked for: it checks that the file exists and reads its `## 恢复会话` section. It writes no files itself.
- `claude plugin validate .` lists every API call the mod makes, so you can check this yourself before installing.
- Settings are stored locally by Claude Code's plugin store.

## Installation

### Prerequisites

- Claude Code with plugin mods support (developed against Claude Code 2.1.296)

### Install from GitHub

```bash
claude plugin marketplace add axtonliu/context-guard
claude plugin install context-guard@axtonliu-mods --scope user
```

New sessions pick it up.

### Install from a local clone

```bash
git clone https://github.com/axtonliu/context-guard.git
claude plugin marketplace add ./context-guard
claude plugin install context-guard@axtonliu-mods --scope user
```

## Usage

```
/context-guard                    Status, threshold, current flow and its last 20 steps
/context-guard threshold <1-99>   Change the threshold (default 75)
/context-guard off | on           Turn reminders off / on (the command always works)
/context-guard intercept on|off   Skip the first automatic compaction of each session, to leave time for a log (default off)
/context-guard resume on|off      Send the log's resume prompt after compaction (default on)
/context-guard reset              Clear a stuck flow
```

Settings persist across sessions.

## Turn off or uninstall

- Pause reminders: `/context-guard off`
- Disable the mod: `claude plugin disable context-guard@axtonliu-mods`
- Uninstall: `claude plugin uninstall context-guard@axtonliu-mods --scope user`, then optionally `claude plugin marketplace remove axtonliu-mods`

## File structure

```
context-guard/
├── .claude-plugin/
│   ├── plugin.json        Plugin manifest
│   ├── icon.png           Plugin icon
│   └── marketplace.json   Single-plugin marketplace, for installing from GitHub
├── skills/
│   └── work-log-share/    Bundled log skill (SKILL.md, README, examples)
├── hooks/
│   ├── hooks.json         Registers the module
│   ├── logic.ts           Pure parts: tiers, report parsing, prompts, commands
│   └── register.tsx       Hooks and the band above the prompt
├── types/
│   └── index.d.ts         State types
└── tests/
    ├── logic.test.ts
    └── flow.test.ts
```

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## Contributing

Contributions are welcome, within a low-maintenance scope:

- Reproducible bug reports (steps, Claude Code version, CLI or Desktop, `/context-guard` output with private paths removed)
- Documentation fixes
- Small PRs (fixes and docs)

Feature requests may not be acted on.

## License

MIT License. See [LICENSE](LICENSE).

---

## Author

**Axton Liu** - AI Educator & Creator

- Website: [axtonliu.ai](https://www.axtonliu.ai)
- YouTube: [@AxtonLiu](https://youtube.com/@AxtonLiu)
- Twitter/X: [@axtonliu](https://x.com/axtonliu)

### Learn More

- [MAPS™ AI Agent Course](https://www.axtonliu.ai/aiagent) - Systematic AI agent skills training
- [AI Elite Weekly Newsletter](https://www.axtonliu.ai/newsletters/ai-2) - Weekly AI insights
- [Free AI Course](https://www.axtonliu.ai/axton-free-course) - Get started with AI

---

© AXTONLIU™ & AI 精英学院™ 版权所有
