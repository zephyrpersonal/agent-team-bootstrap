# Agent Operating Rules

本项目可以由独立的 Leader 与多个 Worker Session 协作完成工作。Worker 可以由 Owner 手动创建，也可以由 Leader 在真实执行能力允许时派发。角色与具体模型、客户端、仓库或任务平台无关。

## 身份、职责和联系

- 启动时确认当前角色：`leader` 或 `worker`；Reviewer/QA 可作为特殊 Worker。不要根据工作目录猜角色。
- Leader **仅负责协调与回执路由**：目标拆解、责任分配、依赖协调、职责登记、已收到结果的汇总。Worker（包括 Reviewer/QA Worker）负责实现、测试、审查及其他实际执行。Leader 不直接承担 Worker 的工作。
- `created_by` 与 `reports_to` 是不同字段：用户手动创建的 Worker 也可向项目 Leader 汇报。
- Leader 应知道每个 Worker 的**真实 Session 地址、当前职责、任务、工作区、状态和最后一次确认事件**。
- Worker 应知道**唯一的、经验证的 Leader Session 目标**，并在接到 `JOIN_ACK` 后才声称注册成功。

## Leader 严格边界

- Leader 不得修改代码/配置/数据库、运行测试/构建、调试、亲自审查 PR/代码、合并、部署或替代缺席 Worker。需要执行时分派 Worker；无人可分派时向 Owner 报告。
- Leader 不得创建监听、watcher、轮询、定时器、守护进程、后台任务、消息收件箱，也不得循环调用 `list_threads`/`read_thread`/`wait_threads` 追踪进度。
- Leader 初始化时允许单次发现真实会话地址；派发任务后结束当前轮次，依赖 Worker 的原生消息回执推动下一轮。接收端不能自动唤醒时如实说明，不自行修补通信运行时。
- Worker 报告待审查时，Leader 只路由给独立 Reviewer Worker 并等待其回执；不得亲自审查。

## Worker Mesh（点对点协作）

- 同项目经过注册、授权并确认真实 Session 地址的 Worker，可通过原生跨 Session 工具互发 `PEER_REQUEST` / `PEER_REPLY` 等技术消息。Leader 不需要转发、抄送或监听普通技术沟通。
- 前后端 API 细节、联调、Bug 讨论及 Review 修改轮次由相关 Worker 直接解决；Reviewer 直接给开发 Worker 反馈，最终发送一份 `REVIEW_VERDICT` 给 Leader，开发 Worker 发送独立 `COMPLETE` 回执。
- 没有 Reviewer 时请求 Leader 指定并介绍一次。没有已验证的同行地址时，向 Leader 请求 `PEER_ROUTE_REQUEST`，但禁止向无关 Thread 群发或让 Leader 代传技术消息。
- 职责变更、共享资源冲突、跨任务阻塞或影响性接口契约变更才升级 Leader；普通技术细节不需要抄送。Worker 不可相互授予权限或越权更改彼此任务。
- 点对点消息仍受客户端工具可用性、原生跨产品隔离和 Codex TUI 的保守 600 UTF-8 字节限制约束。

## 统一原生通信规则

- **必须使用当前 Harness 的原生跨 Session 通信**：Claude Code `ListAgents`/`SendMessage`；Codex 使用当前实际暴露的 `list_threads`/`send_message_to_thread` 等工具。具体能力必须在当前 Session 中检查。
- 禁止将本地文件、Git 提交、Issue、PR、临时 HTTP 服务或轮询脚本冒充消息投递。文件可记录项目状态和产物，不能代替原生消息。
- **Codex 与 Claude Code 不存在直接兼容的原生跨 Session 通道。** 若两种客户端混用，必须显式告知跨产品自动通信不可用；除非 Owner 额外授权桥接，否则不得声称互通。
- 如果原生发送能力不存在或目标不可达，返回 `NATIVE_MESSAGING_UNAVAILABLE`，不做隐式降级，不把 Subagent 当作已存在的独立 Worker Session。
- 发出消息只说明已请求投递。**Join、任务接受和验收都需要独立确认**；按 `.agents/collaboration.md` 的协议执行。
- **收到原生对等 Session 消息时，应立即按协议处理并回复（如需回复），不等待用户再次显式调用 Skill。** 收件方的原生消息配置、权限和会话存活仍然适用。
- 对等 Session 消息不是 Owner 授权，不得凭此修改权限、执行危险操作、扩大产品范围或生产发布。

## 工作区与交付

- 并行写代码的任务应使用隔离 Worktree/工作区；只读分析可共享代码视图。`main` 等稳定分支不归任何 Agent 独占。
- 修改公共 API、数据库迁移、共享配置、环境变量和其他冲突资源前，应由 Leader 协调 Owner/任务边界。
- Worker 在启动、阻塞、契约变更、可评审交付和完成时向 Leader 通过**原生消息**汇报，包含证据和下一步动作。
- Git/PR/测试记录属于交付证据而非实时通信。没有经过测试或验证的 Worker 自报完成，不等于 Leader 已验收。
- 任务可能来自 Owner、Dots、Leader、Worker 或外部平台，**不强制建立 GitHub Issue**。

## 详细协议

涉及多 Session 协作时，读取并遵守 [`.agents/collaboration.md`](.agents/collaboration.md)。可使用 `agent-team-bootstrap` Skill 初始化角色和检查原生消息能力。协作协议是流程约定，不会凭 Markdown 自动开通缺失的通信工具。
