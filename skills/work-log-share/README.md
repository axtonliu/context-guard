# Work Log Share

把一次 AI 协作保存成下次能接着用的工作日志：除了“做了什么”，还留下“为什么”“试过什么”“哪些事是故意没做”。

这是一个独立的 Markdown skill，不依赖 Obsidian、Tana、MCP、API key 或额外脚本。适用于具备本地文件读写能力的 AI agent。Experimental / best-effort，欢迎按自己的日志习惯调整。

## 安装

下载并解压后，把整个 `work-log-share` 文件夹放进你所使用宿主的 skill 目录。选择一个宿主即可：

- Codex：`~/.agents/skills/work-log-share/SKILL.md`
- Claude Code：`~/.claude/skills/work-log-share/SKILL.md`

上面显示的是**安装后 SKILL.md 的位置**，不是日志保存目录。若你的团队已有统一的源码与挂载方式，沿用其规范。这里指本机 Codex 或 Claude Code 的文件目录，不是 Cowork 云端安装位置。重新打开会话，确认宿主能找到 `work-log-share`。Codex 可显式输入 `$work-log-share`，Claude Code 可输入 `/work-log-share`。

## 使用

在完成一段实际工作后说：

> 使用 work-log-share，把这次会话写成工作日志，保存到当前项目的 logs 目录。

要换会话继续工作时说：

> 使用 work-log-share，生成交接日志，把恢复会话的提示词也写进文件。下次我要从这里继续。

不需要先填一套表格。Skill 会用当前对话理解任务，保存必要的过程、取舍、证据及未完成事项。可以指定更详细的日志、语言、格式和路径。

## 输入和输出

**输入**：当前会话，以及这次工作明确关联的笔记、文件或验证结果。它不能恢复从未提供、也没有留存的历史上下文。

**输出**：一份普通 `.md` 文件。默认写入工作项目的已有日志目录，没有约定则用 `logs/`。交接模式把恢复提示词放在同一文件末尾；复制到能访问这些引用文件的新会话即可继续；换电脑时也需要带上相关文件。

这个 skill 只负责日志，不要求额外 Git commit、记忆更新、任务状态修改或对外发送；宿主的独立规则仍可能执行其他动作。个人信息可能本来就在工作材料里；日志写入本地不等于已经适合公开分享。

## 从示例开始

[示例会话](examples/session.md)是一段虚构的导出功能排错记录。[日志示例](examples/work-log.md)展示如何保留被推翻的判断和未完成验证。这些是预先编写的虚构示例（不是模型回放测试输出），也不是必须逐字照搬的模板。

需要自行检查效果时，可使用 [三个测试场景](examples/test-cases.md)：看事实和判断是否保存下来，而不是数标题和字数。

## 接到你自己的系统上

这版只负责把一篇日志写准确。作者的私用版本在写完日志之后还会做几件收尾，每件防一种具体的返工；分享版把它们去掉，是因为它们绑死了作者自己的工具，不是因为这些事不该做。有对应返工的再补，没有就别补。

| 去掉的段 | 它防的返工 | 你的等价物 |
|---|---|---|
| 档案回链 | 日志写了没人找得到，几个月后同一个问题重查一遍 | 项目 README 或 wiki 首页加一行链接；或在日志目录维护索引 |
| 任务系统写回 | 日志说做完了、任务板还开着 | Linear、Jira、GitHub Issue、Notion 的更新，作为一个单独的明确动作；不放心自动写就先生成候选 |
| 状态对账 | 新会话冷启动，先花十分钟重新解释背景 | CLAUDE.md 或 AGENTS.md 里一个「当前焦点」块，或一条置顶笔记 |
| 操作性结论进 SOP | 方法埋在日期日志里，日后花同样的成本重查 | 一个 runbook 或团队 wiki 页；判据：这轮有没有「以后照这么做」的结论？ |
| 系统改造写 Changelog | 系统用法变了，没人知道从哪天起变的 | 仓库的 CHANGELOG.md |
| 压缩前自动快照 | 上下文被压掉了，证据比日志先没 | Claude Code 或 Codex 的 PreCompact hook；或压缩前先写一次日志 |
| 宿主专属命令块 | 无 | 换成你宿主的对应命令 |
| 固定 frontmatter | 跨项目回看要一篇篇翻 | 任何你的工具能查询的一致元数据 |

## 关于模型适配

这版把日志的核心目标和证据边界留在主文件，让模型根据任务决定篇幅与章节；不要求每个会话填满空栏目，也不把个人工作流的额外动作作为通用规则。可在 GPT-6 Astra 等支持 skills 的模型上使用；它没有要求模型专属 API，也不承诺换模型后一定更快或更好。

安装路径参考：[Codex skills](https://developers.openai.com/codex/skills#where-to-save-skills)、[Claude Code skills](https://code.claude.com/docs/en/skills#choose-where-skills-load)。
