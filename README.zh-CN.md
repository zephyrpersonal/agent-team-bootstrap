# Agent Team Bootstrap

[English](README.md)

**Agent Team Bootstrap** 是面向 Codex 和 Claude Code 的多 Session 协作 Skill，使用客户端实际提供的**原生跨 Session 通信**组织 Leader、Worker 和 Reviewer。

## 功能特性

- **Leader 严格只负责协调**：把你的目标澄清成任务书，先侦察再拆分任务包，多任务包的计划先给你确认，派发后让 Worker 朝目标收束，最后用一份报告收尾；不亲自编码、测试、审查、合并、部署，也不轮询或监听，唯一会写的文件是团队账本。
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

### 任务、账本与收束

- **澄清**：Leader 把每个目标复述成一个任务（`missions/<id>.md`）（目标、不做什么、验收标准），一次最多问三个问题。需要了解代码库时，第一个任务包是只读的**侦察**，Leader 根据侦察报告做规划。
- **规划与确认**：每个任务包有负责人、依赖、预算（`DUE`、`ROUNDS`）和检查点。有两个及以上任务包、或涉及共用接口的计划，先等你确认；单个任务包的目标直接派发。
- **团队账本**：任务书、计划、任务包说明、成员表和决策记录放在 `team/<project>` 分支（永不合并）。派活时带固定版本的引用，如 `REF:team/my-project@3f9c2e1:wp/17.md`，所以任务说明不受消息长度限制。只有 Leader 写账本，也没人轮询它。Leader 不需要项目代码，只需要用 `Repo:` 克隆出一个只含账本的目录，或使用单独的 `Ledger:` 仓库；两者都没有时报告 `LEDGER_UNAVAILABLE`，不用账本运行。
- **收束**：Worker 在 `ASSIGN_ACK U:` 里复述任务，到里程碑发 `CHECKPOINT`，超预算或超范围时发 `OVER_BUDGET` / `SCOPE_CHANGE_REQUEST`，而不是自己扩展；Leader 回 `CONTINUE`、`REDIRECT` 或 `STOP`。
- **调度**：每个需求都按优先级（`P0`–`P2`）、是否独立于正在进行的工作、规模来分类，没有单独的"hotfix"模式。就绪的任务包按优先级找人：空闲的 Worker → 新开 Worker（`owner.md` 授权、且不超过 `Max Workers`）→ 暂停一个优先级严格更低的任务包 → 排队。能向忙碌的 Worker 提问多少（`MODE:consult`）取决于对方当前的负载和优先级；任务合并后，改动有重叠的任务包先 rebase。
- **收尾**：一份最终报告（完成了什么、没完成什么、风险、后续事项、代你做的决定），你确认后给所有 Worker 发 `RELEASE`。
- **你的画像**：全局 `~/.agents/owner-profile.md`（本地，不提交）加上账本里的项目级 `owner.md`，其中明确列出授权范围。Leader 依据画像做的决定标为 `BY:profile`，删除、部署、权限、合并这几类永远不能代你决定。详见 [leader.md](skills/agent-team-bootstrap/references/leader.md) 和 [ledger.md](skills/agent-team-bootstrap/references/ledger.md)。

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

## 团队监控工作台（可选，由人工启动）

本地团队监控工作台采用全宽轻量顶栏、小统计和首屏白卡通信协作图，卡片头部使用本项目文字标识：Claude Code 为 `CC`、Codex CLI 为 `CX`、未知客户端为 `>_`，并非官方 logo。成员列表分开显示角色、客户端、执行活动和协议状态，并突出当前处于 BLOCKED（阻塞）或 STALE（长时间无活动）的待关注成员。成员详情保留工具活动和输出；费用和模型没有数据时不显示。请自己在已安装的 Skill 目录（或本仓库）里运行，Agent 不会启动它，也不依赖它：

```bash
node skills/agent-team-bootstrap/scripts/team-dashboard.mjs   # 然后打开 http://127.0.0.1:4317/
```

通过团队下拉框切换从已发送、已接收协议消息中发现的项目。未指定团队时，默认选择最近有协议活动的团队；未发现任何团队则显示空状态。URL 的 `?project=my-project` 可指定团队，切换团队也会更新 URL。可选的 `--project my-project` 只设置服务默认团队，不是过滤或锁定，仍可选择其他团队；显式选择没有活动的团队时显示空视图。

URL 加上 `?demo=1` 可看脚本化演示；演示入口也支持 `?demo=1&at=N&open=L`。需要 Node.js 20+。可选参数：`--port 4317`、`--since 24h`（也接受 `90m`、`7d` 等）、`--claude-dir`、`--codex-dir`，以及互斥的 `--ledger-repo DIR` 或 `--ledger-dir DIR`。`--since` 按事件时间戳过滤窗口内的消息和团队发现，文件修改时间仅用于优化扫描。已扫描文件中的更早事件仍用于建立协议历史，因此晚到消息不会撤销旧的离队状态。`--ledger-repo` 指定本地 Git 仓库，默认当前工作目录，并按当前所选团队读取分支。选择团队不会自动发现或绑定实际项目仓库；实际仓库不在当前目录时需指定 `--ledger-repo`。`--ledger-dir` 指定包含 `plan.md` 和 `roster.md` 的目录，必须同时提供 `--project`，将此快照绑定到单个团队；选择其他团队时，会话和消息仍可用，但该目录账本返回 `unavailable`，不会复用绑定团队的任务。

- **账本快照与任务关联**：右侧面板仅读取 `plan.md` 和 `roster.md`。Git 模式优先读取本地 `team/<project>` 分支，再尝试本地保存的 `origin/team/<project>` 跟踪引用，展示引用和 commit，不会自动 fetch。目录模式展示工作区快照，不绑定固定 commit。API 的 `ledger.status` 为 `ok`、`unavailable` 或 `error`，并包含来源、引用/commit、任务和诊断；本地缺少分支时返回 `unavailable`，会话和消息仍正常返回。选择任务可高亮关联的 owner/reviewer，并打开成员详情；成员详情列出关联任务，同时按该成员筛选任务面板。任务还支持状态和关键词筛选。关联必须精确匹配 roster 的 id/address、客户端和完整 session ID，不按显示名或短 ID 猜测。任务状态与观测到的执行活动分别记录。没有 issue tracker adapter。

- **通信协作图**：全员主图使用 D3 动态力导向布局及碰撞避让；可拖动成员卡片调整位置、拖动背景平移，并用滚轮或触控手势缩放。“适配全员”将所有成员适配到当前视口，“重新布局”重置成员位置。手机使用精简身份卡，活动和输出可在成员详情查看。D3 7.9.0 以 ISC 许可证随项目本地提供，无需 CDN 或外部脚本请求。完整显示当前消息窗口内的所有有效通信 pair，双向及重复消息合并为一条无向连线；孤立成员也保留显示，未知端点与自发自收消息不会生成连线。连线表示通信联系，不代表上下级或任务依赖。颜色按最近消息类型区分协调 / 分配、成员协作、审查和其他；端点标记及虚线（阻塞）、点线（完成）反映最近消息内容，不代表送达状态。聚焦或悬停连线可查最近类型、状态和时间，成员详情可查通信对象及最近相关消息。卡头文字标识随活动和状态呈现动画反馈；点击卡片可打开成员详情。所有有效 pair 的双向新消息均可沿线播放信封动画，每批最多 4 条，抵达后触发接收方卡片反馈；首次加载和已见消息不重播。动画开关与 `prefers-reduced-motion` 控制动态效果；暂停刷新、页面转入后台或连接失败时也会暂停动画。
- **消息与刷新**：消息支持按类型、成员和关键词筛选。页面每 3 秒自动刷新，可暂停、继续或立即刷新；连接失败时保留已加载的旧数据。接口最多返回 300 条消息，消息表格最多显示 100 条。
- **只读、仅本机**：读取 `~/.claude/projects` 和 `~/.codex/sessions` 里的会话记录、上述本地账本快照，以及 CLI 可用时缓存的只读 `herdr agent list` 快照，只监听 `127.0.0.1`，并拒绝其他 `Host` 头。它不是传输通道、收件箱或监听器。
- **消息与执行来源**：消息来自发出的 `SendMessage` / `send_message_to_thread` 调用、Claude 接收方的 `<cross-session-message>` 包装，以及 Claude Bash/parallel Bash 或 Codex `exec_command` 会话记录中的字面量 `herdr agent prompt` 命令。herdr 尝试标注 pending/accepted/failed/unknown 送达状态；只有匹配的 accepted 结果才推进协议状态或发现团队。accepted 仅证明已提交，不是接收方 ACK。registry 仅按客户端和完整 session ID 精确匹配后覆盖执行活动，提供显示名、执行来源和观测时间，不会创建团队成员或把协议任务标成 COMPLETE；`done` 映射为执行 IDLE。herdr 不可用、身份或状态不明确时退回会话推断，可能显示 UNKNOWN。角色仍属推断，推断为 Leader 不代表该成员是唯一现任 Leader。
- **已用真实记录核对**：Codex 0.163.0 的 `send_message_to_thread` 使用 `threadId` / `prompt`；Claude 2.1.296 的接收包装出现在 `queued_command` 附件和带固定前缀的 user 消息中。脱敏 fixture 和验证范围见 [scripts/fixtures/team-dashboard](skills/agent-team-bootstrap/scripts/fixtures/team-dashboard/README.md)。旧版 Codex `event_msg.agent_message` 分支只有合成兼容测试，本地未找到真实样本。
- **边界限制**：仅读取本机未压缩的 `.jsonl`，不读取远端会话或任意 shell 脚本。herdr 命令识别仅支持受限的字面量 shell 形式，不执行会话记录中的命令。registry 快照缓存 5 秒，仅支持有明确 session ID 的 Claude/Codex 会话，其他 Agent 类型或缺失 ID 的成员无法关联。Claude 没有待完成工具或明确回合证据时为 UNKNOWN；Codex 只有工具结果也不能证明 IDLE。没有匹配的 registry 观测时，会话超过 30 分钟没有活动显示为 STALE。Codex 明确的完成或中断事件会清除待完成工具；缺少结束事件的中断会话仍可能保持 RUNNING，直到 STALE。文件增量按 64 KiB 分块读取，保留一条未完成行；同一 Session 的多个文件合并消息，并采用最新执行快照。

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
- [Leader 规约](skills/agent-team-bootstrap/references/leader.md) 与 [团队账本](skills/agent-team-bootstrap/references/ledger.md)
- [通信协议](skills/agent-team-bootstrap/references/protocol.md)
- [传输能力](skills/agent-team-bootstrap/references/transports.md)
- [可选项目模板](templates/)

## 许可证

MIT。
