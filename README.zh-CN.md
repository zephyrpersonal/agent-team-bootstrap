# Agent Team Bootstrap（中文说明）

这是一个为 Codex 与 Claude Code 设计的 **Leader / Worker 多会话协作 Skill**。它不自建文件消息队列，而是要求 Agent 使用各自产品**实际可用的原生跨 Session 通信**。

- **Leader**：严格只协调。识别和登记 Worker 职责、派发任务、处理原生消息回执、协调依赖并汇总进度；**不直接写代码、测试、审查代码、合并或部署**。待审查工作交给独立 Reviewer Worker。
- **Worker**：可以由你手动创建，也可以由 Leader 在实际具备创建独立 Session 能力时派发。Worker 会向指定 Leader 发 `JOIN_REQUEST`，收到 `JOIN_ACK` 后建立正式汇报关系。
- **任务来源无关**：不要求 GitHub Issue 驱动；你、Leader、Worker 或外部平台都可以发起任务。
- **代码隔离**：修改代码的并行任务建议使用独立 Worktree；Git 与 PR 用于代码和证据，不代替消息通信。

## 安装

在多个项目中都使用（安装到当前用户，面向 Codex 与 Claude Code）：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -g -y
```

只安装在当前项目：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --skill agent-team-bootstrap -a codex -a claude-code -y
```

先检查是否能识别 Skill：

```bash
npx skills add zephyrpersonal/agent-team-bootstrap --list
```

`npx skills` 安装完不保证正在运行的旧 Session 自动加载最新规则；建议新开/恢复会话并重新初始化角色。

**Private 仓库说明：** 当前仓库是 Private。在其他电脑使用 `npx skills` 安装前，请先配置有权限访问此仓库的 GitHub 身份认证，例如 `gh auth login` 或 SSH。如果希望任何人都能免授权安装，可以在 GitHub Settings 中改为 Public。

## Leader 的不可越界边界

Leader 不做监听、文件收件箱、轮询、后台守护进程或定时任务。派发任务后结束当前轮次，等待 Worker 通过 Codex / Claude Code 原生跨 Session 消息送来回执。不能自动唤醒时如实报告，不自行搭建机制。没有可用 Worker 或 Reviewer 时向 Owner 报告阻塞，不接管执行。

## Leader 启动示例

Codex：

```text
$agent-team-bootstrap leader
Project: my-project
请作为项目 Leader，检查真实可用的原生跨 Session 工具，
展示你可接收消息的 Thread ID/Session 地址，读取项目协作规范，
主动处理 Worker 的 JOIN_REQUEST 和工作报告。
不能发送原生消息时必须明确报错，不要改用文件消息队列。
```

Claude Code：把首行改为 `/agent-team-bootstrap leader`。

## 手动创建 Worker 示例

Codex：

```text
$agent-team-bootstrap worker
Project: my-project
Worker ID: backend-01
Created by: human
Responsibilities: 负责订单 API 和测试，不修改 Migration
Leader target: <Leader 提供的真实 Thread/Session 地址>
请使用原生跨 Session 工具发送 JOIN_REQUEST，等待 JOIN_ACK。
开发中的阻塞、接口变化、待评审成果与完成报告都要发送给 Leader。
```

Claude Code：把首行改为 `/agent-team-bootstrap worker`。

## Codex 跨 Thread 消息长度

Codex TUI 的 `send_message_to_thread` 在当前源码中限制单条 `prompt` 为 **1,000 UTF-8 字节**（不是 1,000 Tokens）。报错 `prompt exceeded the maximum context budget` 通常是这项发送前校验失败。为了留余量，本 Skill 要求 Codex TUI 每条消息尽量控制在 **600 字节以内**，只发事件、简短指令和已存在交付物的引用，不传全文。长文档是交付物，不是消息收件箱。此限制不等同于 Leader 的上下文窗口用尽。

## Worker Mesh（Worker 点对点通信）

**普通技术消息直接在 Worker 之间传递，不经过 Leader。** 前端找后端确认 API，QA 与开发讨论缺陷，Reviewer 向开发者反馈修改意见，全部通过当前平台实际可用的原生跨 Session 工具点对点进行。必须确认对方的真实 Session ID、所属项目与授权职责，不能向不明 Thread 群发。

Leader 只负责 Control Plane：注册、任务归属、依赖及共享资源冲突、审查者指定、最终状态汇总。没有已确认同行地址时，Worker 可一次性向 Leader 请求 `PEER_ROUTE_REQUEST`（拿地址，不代传内容）。只有影响职责/范围/共享契约/阻塞或最终审查结论才通知 Leader，避免把 Leader 变成消息总线。

审查流程为开发 Worker → Reviewer Worker → 开发 Worker，必要时双方多轮交流；Reviewer 完成后向 Leader 发送一次 `REVIEW_VERDICT`，开发 Worker 自行发送 `COMPLETE`。禁止 Leader 自己审查，也不启动轮询或监听。Codex TUI 每条 P2P 消息遵循保守 600 UTF-8 字节预算。

## 验证与限制

先做 `PING` → `PONG`，再做 `JOIN_REQUEST` → `JOIN_ACK` → `ACK_RECEIVED`，确认收发双方真实互通。发送工具成功不代表 Leader 接受注册或完成了任务。

Codex Desktop 与 Codex CLI 可能暴露不同的跨 Thread 工具；请按本次 Session 中实际可调用能力判定。Codex 和 Claude Code **不能原生跨产品互发消息**。Skill 不提供后台守护进程或持续自动唤醒服务。

仓库中的 `templates/AGENTS.md` 和 `templates/.agents/collaboration.md` 是**可选**项目规则，不会被 `npx skills` 自动合并到你的业务仓库中。

详细英文说明、协议字段、工具限制见 [README.md](README.md) 与 [`skills/agent-team-bootstrap/`](skills/agent-team-bootstrap/) 。
