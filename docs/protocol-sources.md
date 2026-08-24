# Phase 0 protocol sources

本实验冻结的是 API 可见协议，不是工具实现。首请求在第一个 tool call 处结束，不执行模型生成的命令。

## 固定请求条件

- system 与英文任务来自 [`modeltest/evaluator/trigger_probe`](https://github.com/xiaobright/modeltest/blob/main/evaluator/trigger_probe/src/scaffolds.mjs)。
- 模型参数按 DeepSeek 官方 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) 使用 `thinking.enabled` 和 `reasoning_effort=max`。
- 首轮 `max_tokens=256000` 与 2026-08-15 的 [DSH 受控复现实验 #11](https://github.com/xiaobright/dsh-anchored-standard/issues/11) 对齐；1024 会独立改变轨迹，不能用于本实验。
- 全能力复测按 DeepSeek 官方 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 使用 1,000,000-token context 和 384,000-token max output。context 只作为能力元数据；Chat Completions 请求发送 `max_tokens=384000`。
- 2026-08-13 GA 更新后的服务版本为 `DeepSeek-V4-Pro-0813`，thinking effort 为 low / high / max；详见官方 [Change Log](https://api-docs.deepseek.com/updates/)。

## DSH Minimal 臂

- 工具对：`bash + str_replace_editor`。
- Bash 描述逐字取自 [`preset/agent.cordis.yml`](https://github.com/xiaobright/dsh-anchored-standard/blob/main/preset/agent.cordis.yml) 中对官方 Minimal 配置的覆盖，而不是 persistent-bash 包的短默认描述。
- 参数声明来自以下 npm 包：
  - `@deepseek-ai/dsh-tool-bash-persistent@0.0.1-rc.1`
  - `@deepseek-ai/dsh-tool-str-replace-editor@0.0.1-rc.1`

## Windows Standard 对照臂

- 工具对：`pwsh + read`；这是复现实验 #11 在 Windows 上 8/8 呈现 standard-like 的对照面。
- 参数声明来自：
  - `@deepseek-ai/dsh-tool-pwsh@0.0.1-rc.1`
  - `@deepseek-ai/dsh-tool-fs@0.0.1-rc.1`

## JSON Schema 投影

当前 rc.1 工具都通过 `@deepseek-ai/dsh-tools@0.0.1-rc.1` 的 `defineTool` 注册。其 `parameterSchemaSpecToJsonSchema` 输出根对象的 `type`、`properties` 和非空 `required`，不会自动加入旧版轨迹中的 `title` 或 `additionalProperties: false`。因此本实验按当前 rc.1 投影，不混用 DeepSeek-V3.1 展示页上的旧 schema 形状。

所有实际请求和工具 schema 都会在结果文件中保存 SHA-256 指纹，便于后续确认 Anchor 与该实验使用的是同一协议。

## 运行时机制参考优先级

Gateway 的运行时设计优先参考以下可复算来源，而不是社区转述：

1. DeepSeek Harness 官方 preset 与工具实现：确定真实 system、schema 和消息注入面；
2. [`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)：确定两阶段 bootstrap、持久化 promotion、resident catalog、按需工具解锁和 compaction epoch 的实现思路；
3. [`modeltest` 轨迹证据](https://github.com/xiaobright/modeltest/tree/main/evaluator/trajectory_evidence)：确定词频、消息长度、工具调用和得分之间的已观测关系；
4. DeepSeek 官方 Thinking Mode：确定工具循环中 `reasoning_content` 的回放要求。

引用外部实现时固定仓库、提交和实验日期。`dsh-anchored-standard` 仍在快速迭代：早期 98/99 运行在 promotion 后一次性恢复 25 工具，当前版本因观测到 post-promotion regression，已经改为 Minimal pair + discovery tools + 按需解锁。Gateway 应保留这个版本差异，不能把旧报告和新实现混成同一个协议。

Gateway 的 `deepseek-cot-markers-v3` 直接对齐上述 `modeltest` 分析脚本公开的 `blocks`、`chars`、`p50_chars`、`p90_chars`、开头 marker、`we`、`let_me`、`lets` 和 `i` 统计思路，但只保留四组思维链关键字（英文在前中文在后）：`I'm …ing`/`我正在`（灰度测试特征）、`we need`/`我们需要`、`let's`/`让我们`（正式版强思维链 Minimal）、`let me`/`让我`（负向前瞻排除`让我们`，正式版弱思维链）。判定优先级：命中一条 `I'm …ing` → 灰度测试思维链；`let me` 累计 ≥3 → let me 思维链；`we need`/`let's` 系 ≥1 且 ≥ 2×`let me` → Minimal 思维链；否则无倾向。任何词频都不进入 Anchor 合格判定。

`we need` / `let's` 系（collective）与 `let me` 只观察模型自然输出；Builder 不追加关键字 steering，也不按词频判定合格/不合格。用户根据关键字、两个工具调用状态与完整对话自行挑选。另一条产品纪律：把 Pro 思维链直接复制出来的「Flash baseline」不是 Flash 原生的生成结果，已从内置 Anchors 目录移除；Anchor catalog 与加载器都会排除或拒绝带 `copiedBaseline` 标记的 Artifact。Flash/Vision 没有可信的内置模型原生 Anchor，默认 `bypass`，必须先用目标模型生成属于它的 Anchor 并绑定后才能切到 `anchor` 模式。

部署拓扑是独立配置：`split` 为每模型独立数据端口，`single` 为一个按 `request.model` 分发的多模型路由口，`all` 同时开放 split 与额外的多模型路由口。路由口不是合并逻辑面，各模型使用自己的上游、Key 与增强模式。拓扑切换只在重启时生效；不能把进程监听迁移伪装成 Profile 热更新。

当前微锚点实现只作用于 OpenAI-compatible [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion) 消息数组（Responses / Anthropic 适配未实现）；系统与头部实现细节见 [micro-anchor.md](micro-anchor.md)。
