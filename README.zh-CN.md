# Agent Team Bootstrap

[English](README.md)

**Agent Team Bootstrap** 是面向 Codex 和 Claude Code 的多 Session 协作 Skill，使用客户端实际提供的**原生跨 Session 通信**组织 Leader、Worker 和 Reviewer。

## 功能特性

- **Leader 严格只负责协调**：分配任务与职责、管理依赖和冲突、处理关键回执、汇报结果；不亲自编码、测试、审查、合并、部署，也不轮询或监听。
- **Worker Mesh 点对点协作**：Worker 直接讨论 API、技术问题、联调和 Bug，不经过 Leader 转发。
- **独立技术审查**：Reviewer 与开发 Worker 直接沟通，只向 Leader 提交最终审查结论。
- **原生通信**：使用可调用的 Codex / Claude Code Session 消息工具，不自建消息队列、后台服务或监听程序。
- **可选 herdr 通信**：Owner 明确选择后，运行在 [herdr](https://herdr.dev/) pane 中的成员用 `herdr agent prompt` 互发消息，同一团队可以混合 Codex、Claude Code、Gemini、opencode 等不同 Agent。herdr 团队只走 herdr（不再用原生消息，所有成员都在 herdr pane 里），并用 herdr 做有时限的送达确认、Owner 要求时的实时状态、Owner 通知，以及每个 Worker 一个 worktree 的创建。
- **注册与职责确认**：通过 `JOIN_REQUEST` / `JOIN_ACK` / `ACK_RECEIVED` 建立受控的团队关系。
- **统一消息预算**：Leader、Worker、Reviewer 的所有消息统一使用保守的 **600 UTF-8 字节**上限策略，仍遵循实际工具的更严格限制。
- **适用于不同项目**：不强制绑定 Issue 管理、某种代码仓库或开发框架。

## 安装

准备 Node.js/npm，以及 Codex 或 Claude Code。

同时全局安装到 Codex 和 Claude Code：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -g -y
```

仅安装到当前项目：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -y
```

查看可发现的 Skill：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --list
```

安装或更新后，建议开启新 Session 或重新加载角色指令。项目特有约束可以写在 `AGENTS.md` / `CLAUDE.md` 中，但不需要额外复制通用协作模板。

### 升级运行中的团队

已运行的 Session 保留其加载时的 Skill 内容，磁盘文件更新不会影响它们。

1. 更新安装副本：重新执行上面的安装命令（全局安装带 `-g`；项目安装在项目根目录执行、不带 `-g`）。项目安装需将更新后的 `.agents/skills/` / `.claude/skills/` 提交到默认分支。
2. 告诉 Leader「Skill 已升级」（项目安装附上该提交）。Leader 重新加载 Skill，并向每个在队 Worker 发送 `SKILL_REFRESH`（项目安装附 `REF:<commit>`）。Worker 保留 ID、任务与 Leader 地址重新加载，回复 `SKILL_REFRESH_ACK`。若 Worker 的工作区早于 `REF`，用 `git show` 读取新版 Skill，不合并分支。

Agent 不会因对端消息执行安装命令。

## 使用方法

### 启动 Leader

在独立 Codex Session：

```text
$agent-team-bootstrap leader
Project: my-project
负责协调 Worker 职责、任务、依赖与最终回执。
提供可验证的原生 Session 地址，不直接承担 Worker 工作。
```

Claude Code 则使用 `/agent-team-bootstrap leader`。

### 启动 Worker

另开一个 Session：

```text
$agent-team-bootstrap worker
Project: my-project
Worker ID: backend-01
Created by: human
Responsibilities: 实现订单 API 及单元测试
Leader target: <已确认的 Leader 原生 Session 地址>
请发送 JOIN_REQUEST 完成注册，并通过原生消息汇报关键结果。
```

Claude Code 则使用 `/agent-team-bootstrap worker`。

Worker 收到 `JOIN_ACK` 后确认注册。Leader 也可以在得到 Owner 授权、并且客户端支持创建独立 Session 的情况下启动 Worker。

### Worker 点对点通信

注册成功且确认目标身份后，Worker 可直接向其他授权 Worker 发送技术问题：

```text
P:my-project T:PEER_REQUEST ID:fe3 Q:订单状态有哪些? ACK:1
```

代码审查由开发 Worker 直接向 Reviewer 发送 `REVIEW_REQUEST`；Reviewer 直接返回反馈，最后给 Leader 一份 `REVIEW_VERDICT`。开发 Worker 独立发送 `COMPLETE` 回执。

### 退出团队

Worker 交接未完成工作后发送 `LEAVE_REQUEST`（附交接引用），Leader 回复 `LEAVE_ACK` 并标记为 `LEFT`。Owner 要停用某个 Worker 时，由 Leader 发送 `RELEASE`，Worker 交接后回复 `LEAVE_ACK`。`LEFT` 的 Worker 不再接收任务，回归需重新 `JOIN_REQUEST`。

### 更换 Leader 或替换掉线的 Worker

同一时间每个团队只有一个 Leader，但 Leader 和 Worker 都可以替换，例如你换了设备或某台机器下线：

- **主动交接**：旧 Leader 先给新 Leader 发 `LEADER_HANDOFF`，再给每个 Worker 发 `LEADER_CHANGE`，然后退出。Worker 带着自己的任务、已推送的分支和最后一条回执重新加入新 Leader，新 Leader 据此重建成员表。
- **故障接管**：旧 Leader 失联时，以 `Takeover` 启动的新 Leader 发送 `LEADER_CHANGE FO:1`。只有组队时你写了 `Failover: allowed`、且 Worker 联系不上旧 Leader，Worker 才会接受；否则需要你在每个 Worker 的会话里确认。
- **防止双 Leader**：每届 Leader 有一个 epoch（`E:<UTC yyyymmddhhmm>`）。接管后旧 Leader 恢复上线，会收到 `STALE_LEADER` 并退出。
- **掉线的 Worker**：机器下线后，Leader 把上面的 Worker 标为 `LOST`，从最后推送的提交开新分支重新分配任务，并通知相关成员。跨机器的团队里 Worker 每到一个里程碑都要推送分支。
- **AFK / BACK**：Leader 或 Worker 短暂离开时先发 `AFK`；没打招呼就消失的成员，会在别人下次给它发消息失败时被发现（不做心跳）。Leader 离开期间，Worker 继续干活，暂存回执并通知你一次；Leader 发 `BACK` 后，Worker 汇报状态并补发暂存的回执。Worker 发现同伴 AFK 时先暂存消息、做别的事，只有被卡住时才上报。
- **你自己换设备**不需要任何操作，只要 Agent 跑在常开的主机上，从任何设备连到它们的 herdr server 即可。

## 团队可视化面板（可选，由人工启动）

一个卡通风格、带动效的本地页面，展示团队成员、Session 之间飞来飞去的原生消息，以及每个 Session 正在做什么（执行工具、空闲、阻塞、审查中、完成）。请自己在已安装的 Skill 目录（或本仓库）里运行，Agent 不会启动它，也不依赖它：

```bash
node skills/agent-team-bootstrap/scripts/team-dashboard.mjs --project my-project   # 然后打开 http://127.0.0.1:4317/
```

URL 加上 `?demo=1` 可看脚本化演示。需要 Node.js 20+。可选参数：`--port 4317`、`--since 24h`、`--claude-dir`、`--codex-dir`。

- **只读、仅本机**：只读取 `~/.claude/projects` 和 `~/.codex/sessions` 里的会话记录，只监听 `127.0.0.1`，并拒绝其他 `Host` 头。它不是传输通道、收件箱或监听器。
- **推断而非权威**：消息只取自发出的 `SendMessage` / `send_message_to_thread` 调用（Claude 接收方再加 `<cross-session-message>` 包装）。已关闭的 Session 与空闲无法区分；超过 30 分钟没有活动显示为 STALE。不显示 herdr 通信的消息和其他机器上的会话；更换 Leader 后两个 Leader 都会显示皇冠。
- **已用真实记录核对**：Codex 0.163.0 的 `send_message_to_thread` 使用 `threadId` / `prompt`；Claude 2.1.296 的接收包装出现在 `queued_command` 附件和带固定前缀的 user 消息中。脱敏 fixture 和验证范围见 [scripts/fixtures/team-dashboard](skills/agent-team-bootstrap/scripts/fixtures/team-dashboard/README.md)。旧版 Codex `event_msg.agent_message` 分支只有合成兼容测试，本地未找到真实样本。
- **边界限制**：仅读取未压缩的 `.jsonl`。Codex 明确的完成或中断事件会清除待完成工具；缺少结束事件的中断会话仍可能保持 RUNNING，直到 STALE。文件增量按 64 KiB 分块读取，保留一条未完成行；同一 Session 的多个文件合并消息，并采用最新执行快照。

## 消息限制

**统一预算为每条原生消息 600 UTF-8 字节，适用于所有角色及通信方向**，包括注册、任务派发、P2P、代码审查和最终汇报。这是 Skill 的保守策略，并不意味着 Codex 和 Claude Code 的底层工具拥有相同的硬限制。

当前已检查的 Codex TUI 实现对 `send_message_to_thread` 的 `prompt` 有 **1,000 UTF-8 字节**限制。报错 `prompt exceeded the maximum context budget` 通常是这项发送前校验失败，不代表模型 Context Window 已满。

较长的任务说明、日志和 Diff 应保存在对方可访问的项目资料中，通过原生消息传递简短引用。项目文件不承担消息队列职能。

## 运行环境

| 环境 | 通信能力 |
|---|---|
| Claude Code | 实际可调用的 `ListAgents` / `SendMessage` |
| Codex Desktop | 实际可调用的 Thread 发现及 `send_message_to_thread` |
| Codex CLI | 依当前 Session 暴露的工具而定 |
| Codex 与 Claude Code 互通 | 不直接支持原生跨产品通信 |
| herdr 中的任意 Agent | `herdr agent prompt`（Owner 明确选择，全队统一） |

**herdr 的代价**：消息是打进对方输入框的文字，接收方看到的是一条用户输入，没有原生发送方身份，Claude 的 `crossSessionInbound` 拦截也不生效。成员把带 `FROM:` 的信封当作同级 Peer 消息处理，不当作 Owner 指令；同一 herdr server 内任何进程都能给任何 Agent 发消息。对方正在执行时的行为因 Agent 种类而异，每种 Agent 组合都要先测 `PING` / `PONG`。详见 [transports.md](skills/agent-team-bootstrap/references/transports.md#herdr-opt-in-any-agent-kind)。

发送成功不等于对端已经接收、批准或自动唤醒。建议先完成 `PING` / `PONG` 和注册确认测试。无法使用原生通信时，Skill 会明确提示，而不是建立替代监听程序。

## 进一步阅读

- [Skill 指令](skills/agent-team-bootstrap/SKILL.md)
- [启动和排障](skills/agent-team-bootstrap/references/quickstart.md)
- [通信协议](skills/agent-team-bootstrap/references/protocol.md)
- [传输能力](skills/agent-team-bootstrap/references/transports.md)
- [可选项目模板](templates/)

## 许可证

MIT。
