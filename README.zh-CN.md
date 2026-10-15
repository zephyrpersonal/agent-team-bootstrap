# Agent Team Bootstrap（中文说明）

这是一个为 Codex 与 Claude Code 设计的 **Leader / Worker 多会话协作 Skill**。它不自建文件消息队列，而是要求 Agent 使用各自产品**实际可用的原生跨 Session 通信**。

- **Leader**：识别和登记 Worker 职责、协调任务、接收报告、审查交付。
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

## 验证与限制

先做 `PING` → `PONG`，再做 `JOIN_REQUEST` → `JOIN_ACK` → `ACK_RECEIVED`，确认收发双方真实互通。发送工具成功不代表 Leader 接受注册或完成了任务。

Codex Desktop 与 Codex CLI 可能暴露不同的跨 Thread 工具；请按本次 Session 中实际可调用能力判定。Codex 和 Claude Code **不能原生跨产品互发消息**。Skill 不提供后台守护进程或持续自动唤醒服务。

仓库中的 `templates/AGENTS.md` 和 `templates/.agents/collaboration.md` 是**可选**项目规则，不会被 `npx skills` 自动合并到你的业务仓库中。

详细英文说明、协议字段、工具限制见 [README.md](README.md) 与 [`skills/agent-team-bootstrap/`](skills/agent-team-bootstrap/) 。
