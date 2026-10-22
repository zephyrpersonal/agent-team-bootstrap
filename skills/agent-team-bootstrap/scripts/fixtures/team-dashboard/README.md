# Transcript fixtures

These fixtures were extracted from local transcripts on 2026-10-17. They are
structural samples, not generated from the parser. Text, project/member/session
identifiers, paths, socket addresses, tool inputs and outputs are replaced with
test values. Unrelated metadata, instructions and duplicated rendered content
are omitted. Each entry records its original line number and SHA-256 before
sanitization so the local source can be checked without publishing private logs.
Tests rebase timestamps and assemble short scenarios from these independent rows.

Model/effort metadata compatibility uses explicitly handwritten test rows:
Claude assistant `message.model` / `message.output_config.effort`, and Codex
`turn_context.payload.model` / `effort` / `reasoning_effort`. The extracted
fixtures below do not retain those fields, so these paths are not claimed as
verified against a real transcript sample. Missing metadata is shown as unknown;
thinking text, token counts, provider names and global defaults are not evidence.

- `codex.json`: Codex 0.163.0, source `vscode`, rollout dated 2026-10-16.
  Includes `session_meta`, user/assistant `response_item.message`,
  `function_call`, array-valued `function_call_output`, `task_started`,
  `task_complete`, and `custom_tool_call` / `custom_tool_call_output`.
  All 991 complete local `send_message_to_thread` calls used `threadId` and
  `prompt`; one additional call had an empty argument object. The actual call has
  `name: "send_message_to_thread"` and `namespace: "mcp__codex_tui"`.
  `turn_aborted` is a separate sample dated 2026-10-06.
- `claude.json`: Claude Code 2.1.296, transcript dated 2026-10-12.
  The receive wrapper is in `attachment.prompt` for `queued_command`, or in
  `user.message.content` after `Another Claude session sent a message:`.
  It includes `from`, `from-name` and `from-mode` attributes. The accompanying
  `queue-operation.enqueue` sample is deliberately ignored by the parser:
  queue bookkeeping is not another delivered message.

The original local source basenames are
`rollout-2026-10-16T20-54-19-01a144c7-11e2-7261-8994-d34e881c35ec.jsonl`,
`rollout-2026-10-04T20-14-00-01a106d5-d862-70e3-8339-e7792d3e1294.jsonl`
(interruption only), and `b90bc243-dec7-42f2-8514-138a91ebfa64.jsonl` (Claude).
No test depends on those files or the user's home directory.

No real `event_msg.agent_message` was found in 48 local JSONL files or 919
compressed rollout archives. Its existing text-only compatibility branch has
an explicitly handwritten test; it is not claimed as verified. Compressed archives
were inspected offline for this validation and are not read by the dashboard.

Regression tests also cover ignored documentation envelopes, exact thread ID
routing, interruption with unmatched tools, UTF-8/chunk boundaries, partial
lines, split sessions, stale status and the loopback Host guard.

Historical browser acceptance for the previous office UI on 2026-10-17 used Ego Lite (Chromium) and an isolated
fixture server with no transcript reader. The real `?demo=1` page ran through
33 steps with no script errors. All seven requested states, envelope flights,
light/dark themes, eight members, and 320/375 px widths were inspected.
Reduced motion was checked both on load and while toggling the preference:
no active animations or flying envelopes, with static sleep/completion marks.
At that time, automated checks also parsed the inline script and exercised office layout bounds.

团队监控工作台于 2026-10-18 使用 Ego Lite（Chromium）验收：检查真实项目的
7 个会话及演示固定步骤，检查桌面深浅主题、390px 与 320px 手机布局，页面未发生
整体横向溢出，消息表格可局部横向滚动。验证状态概览筛选、成员消息联动、关键词
筛选与清除、详情打开 / Escape 关闭及焦点恢复、模态内键盘焦点约束。真实数据
自动刷新后，搜索输入节点、内容、光标选区及成员按钮节点均保持；暂停时仍可手动
刷新。通过在页面内临时替换 fetch 模拟请求失败，确认保留旧成员及显示过期提示，
恢复 fetch 后提示自动消失；这不等同于物理网络断开测试。20 项自动化检查通过，
覆盖解析、聚合、本机访问保护、筛选、状态计数、头像确定性、转义与轮询规则。
未穷举全部协议类型、所有浏览器及真实中文输入法的组合输入行为。

同日补回动态团队现场后，使用 Ego Lite 验证 7 个真实会话首次加载不播放历史信封，
循环演示能实际创建飞行信封与类型气泡；角色呼吸、眨眼、敲键盘等 CSS 动画处于
运行状态。检查动画开关、暂停刷新会停止动作并清除飞行信封；动态切换系统减少
动态效果后，场景动画数量为 0 且开关说明更新。检查 390px 浅色与桌面深色场景、
角色点击 / Escape 详情操作，及真实轮询后角色节点、搜索内容和输入焦点保持。
23 项自动化检查通过，新增覆盖首次不回放、消息去重键和每批最多 4 条规则。
未在其他浏览器验证动画，也未使用真实网络中断再次验收动画暂停。

2026-10-20 按成员卡片参考图改版后，使用 Ego Lite 检查桌面浅色卡片与细蓝直角
通信线、手机深色及 390px 浅色布局；手机首次将起点卡片居中，协作图局部横向滚动，
页面宽度仍为 390px。循环 demo 实际观察到沿 SVG 路径飞行的信封和运行中的角色
动画；关闭动画后信封清除，减少动态效果时动画数量为 0。卡片能打开详情并用
Escape 关闭。真实项目检查 8 张成员卡、100 条显示消息；轮询后卡片节点、搜索
节点、关键词和焦点保持。30 项自动化检查通过，新增覆盖森林边界、布局稳定性及
卡片 / 直角线几何。未验证其他浏览器，也未声称通信展示树是权威任务层级。

同日后续将固定网格公共通道替换为本地 D3 7.9.0 force 布局。真实8人成员、20对
联系在1280×800与1440×900桌面、390×844手机视口均默认可见，曲线不再共用
旧版直角通道。实际拖动后节点移动、线路更新且不误开详情；点击仍打开详情。
适配全员、重新布局有效，悬停协调成员时7条关联高亮、13条无关联系淡化。
轮询保留卡片节点、位置、搜索与焦点。演示观察到沿Q曲线路径飞行的消息信封，
暂停后信封清除，减少动态效果时角色动画为0。33项自动化检查通过，包含真实
vendored D3碰撞布局、本地资源路由与CSP。手机全员概览文字较小，需要缩放或
点击看详情；未验收真实手机触控或承诺所有拓扑的曲线绝不穿过其他卡片。

任务账本与 CLI 文字标识版：50项联合自动化检查通过，包含同commit账本读取、
Git无写入、Markdown格式诊断、目录边界、完整session关联、同名冲突及API集成。
Ego Lite验收1440px桌面右侧任务栏，WP-17选择高亮Owner backend-01及Reviewer
qa-01，成员详情可反查任务并筛选账本；任务状态和Owner执行活动分别显示。轮询后
任务节点及选择保持；390px手机页面无横向溢出、画布成员默认可见、账本位于下方。
真实CLUBHOUSE页面8个成员正常，当前仓库无账本分支时显示未接入且不影响画布。
CC/CX为本项目的终端文字标识而非官方logo。未连接真实外部账本或issue tracker。

2026-10-22 Team选择器验收：无--project启动，从协议记录发现4个精确project ID，
默认最近有通信的团队；切换后URL、成员、消息与账本来源更新，清除旧搜索和高亮，
刷新保持选择。检查快速切换、暂停中切换、人工延迟旧请求、390px页面无横向溢出，
demo固定展示模拟团队，不混真实选项。工具/输出仍属于session级观测，非team独立
执行日志；未测试实际多设备或真实手机触控。

herdr现实偏差修复：`herdr.json`为合成脱敏结构，字段依据2026-10-22公开CLI
只读registry及两个精确会话的发送/结果核验，不保留原业务正文。支持顶层单引号
literal `agent prompt`，包括字节统计前缀和分号后缀；命令仅静态解析，绝不执行。
工具接受不是协议ACK；失败/未知不推进成员阶段。95项自动测试通过，覆盖结果
门控、完整session快照匹配、不可用/过期来源、消息时间窗口和LEFT历史基线。
浏览器实查golfcms出现project-leader、campaign-team-refresh、campaign-flow-review，
18条herdr调用包含最近注册/任务/检查点/完成与新指派，执行来源和观测时间可见；
clubhouse不再带入窗外旧Codex。账本仍需显式指向正确仓库，未自动读取其他项目；
仅本地herdr，不支持`--machine`远端发送解析，复杂动态shell命令仍不采集。
