# Architecture decisions

## 产品边界

目标产品是一个本地 Web Gateway：数据面向 Harness 暴露 OpenAI-compatible API，管理面负责 Provider、Execution Profile、Anchor Artifact、实验和诊断。

Phase 0 的协议实验已经完成。当前数据面实现固定结构化 Anchor replay、透明代理和模型隔离；管理面提供 JSON/CLI 诊断、Gateway 内置 WebUI、Pro/Flash 独立持久化配置、子进程热切换、跨重启诊断恢复和后台 Anchor 创建。动态 promotion 仍属于后续产品层，不参与当前已验证机制。

第一道门槛是两臂协议实验：固定模型、system、任务、thinking 和 256000 输出上限，只比较当前 Windows DSH Standard-family 的 `pwsh + read` 对照与真实 DSH Minimal 的 `persistent bash + str_replace_editor` schema。两臂交错运行，避免把低输出预算或短时后端漂移误判成工具协议效果。该实验只观察首次工具调用前的 reasoning，不执行模型生成的命令。

256000 是首轮 DSH adapter 复现值，不是 DeepSeek V4 的容量上限。全能力复测使用独立的模型能力档：context window 1,000,000、max output 384,000，并把能力元数据与实际请求字段分开保存。为保持 A/B 可比性，第二轮不同时切换到 Responses API，也不构造接近 1M 的合成输入。

## Anchor Artifact

Anchor 是不可变、可哈希、可评测的结构化产物，而不是一段普通提示词。它至少应保存：

- 固定前置 system；
- bootstrap tool schemas；
- bootstrap task；
- 完整 `reasoning_content`、`tool_calls`、tool results 与最终回复；
- thinking、reasoning effort、token 限制；
- Provider、模型、协议、响应 fingerprint 等生成来源；
- Environment Switch；
- compiler/schema 版本和内容 hash；
- held-out 评测结果。

内置 Artifact 只读并版本化。用户可以查看、测试或复制为自定义 Artifact，但不能修改或删除原件。

首个候选由确定性的双工具状态机生成：模型必须先单独调用 `bash`，收到固定仓库列表后，才可在下一 assistant subturn 用 `str_replace_editor(view)` 读取固定 README。状态机不执行模型生成的命令；它拒绝同轮并行调用、重复调用、写操作和 shell 读取 README。冻结门槛还要求首轮为 minimal-like、所有 reasoning 不含 `Let me`、存在最终答复，并且总工具调用严格等于两次。

这个门槛只证明 Artifact 的协议形状和生成过程可复现。双工具轨迹是否比单工具轨迹形成更强的行为锚点，必须用后续完整工具集上的 held-out A/B 测试判断。

每个 Artifact 还必须提供长度画像：格式化/紧凑 JSON 字节数、历史 messages 与 bootstrap schemas 的独立大小、reasoning/visible/tool arguments/tool results 字符数、逐 subturn 长度，以及 Provider 报告的生成用量。生成多轮候选时累计的 `prompt_tokens` 不是 Anchor replay 长度；精确 replay tokens 必须由目标 Provider tokenizer 或一次显式计量请求产生，未实测时保持 `null`，不能用字符启发式冒充精确值。

“更长的 Anchor 可能更稳”作为待验证假设，而不是产品规则。后续实验应按可回放 token 长度分桶，同时比较轨迹保持率、任务成功率、延迟和每千 token 的边际增益，防止更长的历史带来提示稀释、旧环境黏连或无效成本。

## 运行观测

运行时统计严格区分三个作用域：冻结的 `anchor_history`、Harness 传入的 `request_history` 和本轮新生成的 `current_response`。历史中的工具调用不能记作本轮调用，工具 result 中出现的短语也不能记作 assistant reasoning。

JSON 与 SSE 进入同一个响应观测器。SSE 在转发过程中按 choice 重建 reasoning、正文和 tool-call fragments，因此跨 delta 的短语仍只计一次；统计不依赖原始 body 捕获上限。非流式 JSON 使用独立的 64 MiB 默认观测上限，超过时显式标记 `observationTruncated`，不伪装成完整统计。

词频 profile 以 `modeltest/evaluator/trajectory_evidence/analyze_trajectory_exports.py` 的公开字段为基线：reasoning blocks、长度、开头 marker、`we`、`let me`、`let's`、`i`。本项目只额外记录受控实验和用户灰测已经出现的精确首行/短语变体。所有词频均为 `diagnosticOnly`；匹配不能证明能力、人格或 Anchor 有效性。

每次响应还记录 finish reason、usage、工具调用序列、客户端断流和上游传输错误。只读诊断面默认保留内存中的最近 100 次统计，不返回原始提示或回复；JSONL metadata 日志有大小与份数上限。

本地 WebUI 由 Gateway 管理父进程直接提供无构建步骤的静态资源。兼容 `single` 模式下它与数据面共用监听；`split` 模式下管理/WebUI 留在父进程，Pro 与 Flash 数据面分别运行在受 IPC 监管的子进程和独立端口。父进程结束或 IPC 断开时，子进程主动退出。数据端口不提供页面或公开诊断路径。管理令牌只进入自定义请求头并保存在标签页 sessionStorage，既不进入 URL 也不由 Gateway 返回。所有 `/__gateway/` 路径均在本地终止，不能回落到 Provider。

## 运行时切换

`dsh-anchored-standard` 的最新公开实现表明，“结合模式”不是混合两段 persona，而是客户端维护的分阶段工具面。它仍保持 Minimal system；结合的是 Minimal 选择出的轨迹与后续 Standard 能力。

Gateway 的待验证运行时采用以下状态机：

```text
BOOTSTRAP
  Minimal system + bash + str_replace_editor
  自动注入的 workspace/skills 摘要暂缓
      ↓ durable tool call 或 assistant message
PROMOTED / RESIDENT
  Anchor history + Environment Switch
  bootstrap pair + discovery tools + 已解锁工具
  恢复当前 Harness instructions/conversation
      ↓ dev_tool_search 显式解锁
EXPANDED
  只增加当前任务真正需要的 Standard tools
      ↓ compaction
CONTROLLED EPOCH
  重新缩小工具面，等待新的 promotion signal
```

历史中的工具调用与当前可执行工具仍必须明确区分；Environment Switch 负责说明环境变化。Gateway 不应默认在 promotion 后一次性暴露完整目录：外部项目的早期 98/99 双跑确实使用过 25 工具，但其最新版报告一次性倾倒会出现 post-promotion regression，已改成 resident catalog 与按需解锁。我们的完整 Anchor replay 是否能抵抗全目录扰动仍需 A/B，因此“直接全量”和“resident + discovery”都保留为实验臂，后者作为产品默认候选。

## 安全边界

- API Key 不写入仓库、普通配置导出或日志；
- Anchor Builder 第一版只使用固定内存文件系统，不执行宿主机 shell；
- 默认日志只保留元数据；
- 每个数据实例只使用自己持有的 Gateway Key（single、Pro、Flash 可分别配置），始终删除 Harness 的 `Authorization` 与 `x-api-key`；管理端点在非 loopback 监听时强制使用独立的 `GATEWAY_MANAGEMENT_TOKEN`；
- 仅监听 loopback 仍需配合严格 Host、Origin 和 Fetch Metadata 校验。
