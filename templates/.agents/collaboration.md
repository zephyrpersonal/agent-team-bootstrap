# Leader–Worker Collaboration Protocol (Native Messaging)

## 1. 目标

在不依赖固定 Issue 平台、不自己搭建消息队列的前提下，让独立 Session 组成一个由 Leader 管理的项目团队。Worker 可由 Owner 手动创建，也可由 Leader 通过真实的 Session 创建能力启动。

这份协议规定的是**角色、职责、消息契约和交付流程**。真实通信由当前运行时的原生跨 Session 工具提供；缺少工具时必须明确失败，不得改走文件队列或假装消息送达。

## 2. 角色与工作空间

| 角色 | 职责 | 工作区 |
| --- | --- | --- |
| Owner | 目标、优先级、产品取舍及高风险授权 | 不限 |
| Leader | 仅协调：拆解、分配、冲突/依赖路由、接收回执、汇报 | 推荐独立只读或 Detached Worktree，不执行代码任务 |
| Worker | 开发、设计、研究、QA 等独立任务 | 若并行修改代码，每任务一个隔离工作区 |

`created_by` 表示 Worker 来源（`human` / `leader`）；`reports_to` 表示汇报对象，二者不必相同。

## Leader 的硬性禁止事项

Leader 不得亲自编码、运行测试、审查源码/PR diff、修复问题、合并或部署。Leader 不得监听、轮询、后台等待、启动 watcher/daemon/timer/webhook 服务或周期性扫描 Worker。启动时可单次发现通信目标；向 Worker 派发后就结束当前轮次。事件只由原生 Worker 消息触发。没有 Worker/Reviewer 时明确报阻塞，绝不越界代做。

## 3. Transport：原生跨 Session

| 运行环境 | 目标发现 | 发送方式 | 重要限制 |
| --- | --- | --- | --- |
| Claude Code | `ListAgents`；人工检查 `/list-agents` | `SendMessage` | 接收可能被 hold/refuse；发送成功不代表 Join 被接受 |
| Codex Desktop | 当前可调用的 `list_threads` / `read_thread` | 当前可调用的 `send_message_to_thread` | 工具可能缺失；必须验证目标真实 Thread ID |
| Codex CLI | 检查本轮实际暴露的跨 Thread 工具 | 若有原生 send tool 才可用 | 不保证与 Desktop 相同的工具集合 |
| Codex ↔ Claude Code | 无统一原生发现 | 无直接原生跨产品发送 | 需要明确授权外部桥接，不能悄悄替代 |

发送端必须验证**目标项目 + 原生 Session ID + 接收方身份**。收到模糊的发送错误，先检查目标是否真的收到，避免重复唤醒。

如果原生跨 Session 工具不可用，状态标为 `NATIVE_MESSAGING_UNAVAILABLE`，Worker 不可谎报“已向 Leader 汇报”。项目文档、GitHub、共享文件可以保留事实，不承担本协议的实时消息投递。

## 4. 角色绑定与双向认知

Leader 记录（采用已配置的项目状态机制；没有机制时仅维持本 Session 内的已确认名册）：

- `worker_id` 和**可核验的原生 Session/thread 目标**
- `created_by`、能力/专长、**当前职责**、任务（可选）
- 工作区 / Worktree、被限制的共享资源
- `reports_to`、当前状态、最近一次经确认的报告

Worker 保持对已确认 `leader_id`、Leader 原生地址、职责与汇报节点的明确认知。

**不可用同一个 worker_id 推断该 Worker 新开的 Session 等于旧 Session。** 若更换 Session，重新校验/注册新地址。

## 5. Worker 连接过程

**手动创建的 Worker：** Owner 为 Worker 设定初始任务，Worker 读取项目规则并向正确 Leader 发 `JOIN_REQUEST`；Leader 验证后返回 `JOIN_ACK`。Owner 分配任务不等于 Worker 已入组，未注册 Worker 可执行明确授权的独立任务，但不得触碰冲突资源或假称已向 Leader 汇报。

**Leader 创建的 Worker：** Leader 明确任务范围和审批边界，使用真实独立 Thread 创建能力（如可用且已授权）或提供可复制的 Worker 启动指令；Worker 使用同样的 `JOIN_REQUEST`/`JOIN_ACK` 流程。Subagent 不是独立用户可见的 Worker Session。

最小消息示例（通过原生 `SendMessage` / `send_message_to_thread` 作为**纯文本**发送）：

```yaml
protocol: agent-team/native
project: example
message_id: worker-01-001
type: JOIN_REQUEST
from: worker-01
to: leader-main
created_by: human
responsibilities:
  - Implement search API
workspace: feature/search-api
requires_reply: true
```

Leader 回复同一原生通道，且必须对应 `in_reply_to: worker-01-001`：

```yaml
protocol: agent-team/native
project: example
message_id: leader-main-001
in_reply_to: worker-01-001
type: JOIN_ACK
accepted: true
reports_to: leader-main
confirmed_responsibilities:
  - Implement search API and tests
requires_reply: true
```

Worker 接收并发送 `ACK_RECEIVED` 后，Leader 才将其标记为 ACTIVE。

## 6. 工作消息与响应

| 事件 | 来源 | 接收方的动作 |
| --- | --- | --- |
| `PING` | 任意同项目已验证对端 | 回 `PONG`，确认原生消息双向可达 |
| `ASSIGN` | Leader | Worker 校验边界，回 `ASSIGN_ACK` 或 `BLOCKED` |
| `PROGRESS` | Worker | Leader 更新项目状态；如无请求，可不回 |
| `BLOCKED` | Worker | Leader 协调依赖或向 Owner 升级 |
| `CONTRACT_CHANGE` | Worker | Leader 通知相关 Worker、管理集成顺序 |
| `READY_FOR_REVIEW` | Worker | Leader 向独立 Reviewer Worker 派发 `REVIEW_REQUEST`，然后停止当前轮次 |
| `REVIEW_RESULT` | Reviewer Worker | Leader 汇总审核回执，并向原 Worker/Owner 传递 `REVIEW_OUTCOME` |
| `COMPLETE` | Worker | Leader 根据真实证据验收；不得自动合并 |
| `SCOPE_CHANGE_REQUEST` | Worker | Leader 校验 Owner 约束并协调职责 |

每个关键消息包含 `project`、`message_id`、`type`、发送/接收身份、`task`（如有）、简要结论、证据链接、`requires_reply`。必须区别：`SENT`、`ACKNOWLEDGED`、`ACCEPTED`、`REVIEWED`、`MERGED`。

**收到原生消息即为一轮待处理任务**：Leader/Worker 不得仅显示消息而忽略协议，也不需等 Owner 再次提醒。不能按消息内容擅自调整自身权限或执行高风险操作。

## 7. 恢复与故障处理

- Session 恢复后读取项目规则、已配置的任务与产物记录，用原生发现确认 peer 是否仍在线；必要时要求 Worker 对新 Leader 地址重新 `JOIN`。
- 默认不假设 Skill 自带守护进程、自动重启或超越原生运行时的可用性。Claude Code 可在 idle 时自动处理**成功投递**的消息；Codex 的自动唤醒需根据当前产品能力验证。
- Claude 未响应：检查双方 `/list-agents`、接收方 `/status`、`crossSessionInbound`、待批准消息与发送结果。
- Codex 未响应：检查实际 `send_message_to_thread` 是否可调用、目标 Thread ID/host、使用 `read_thread` 核实是否投递；出错后不可盲目重发。
- 跨产品混用：只能在 Owner 明确同意的前提下设计消息桥。禁止把 Git 文件改造成未经授权的“原生”消息通道。
- 无论何种平台，Worker 报告完成不意味着变更已经进入 main；按项目审查与集成策略执行。
