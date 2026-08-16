# DeepSeek V4 full-capability trajectory probe — 2026-08-16

## 能力档

本轮把默认模型档从 DSH 历史复现值升级为当前 DeepSeek V4 官方全能力值：

| 字段 | 值 |
| --- | --- |
| 模型 | `deepseek-v4-pro` |
| 当前服务版本 | `DeepSeek-V4-Pro-0813` |
| 上下文窗口 | 1,000,000 tokens |
| 最大单次输出 | 384,000 tokens |
| Thinking | enabled |
| Reasoning effort | max |
| 当前 Pro 并发上限 | 500 |

官方 API 将上下文窗口写作 1M、最大输出写作 384K；DeepSeek 官方集成配置给出的精确整数分别是 1,000,000 和 384,000。上下文容量不是 Chat Completions 的请求参数，因此实际请求发送 `max_tokens=384000`，并把 1,000,000 作为模型能力元数据保存。

本轮不发送接近 1M tokens 的合成输入。那会测试容量边界并产生额外费用，却不能回答工具协议是否改变 reasoning 轨迹。

## 控制方法

与首轮 256000 实验保持一致：

- 相同模型、system、英文任务、thinking 和 effort；
- 相同 Standard `pwsh + read` 与 Minimal `bash + str_replace_editor` schema；
- 相同 Standard → Minimal 交错顺序，每臂 3 次；
- 唯一有意改变的请求字段为 `max_tokens: 256000 → 384000`；
- 仍只观察首次工具调用前的 reasoning，不执行工具命令。

## 结果

| 臂 | minimal-like | standard-like | Let me | 工具调用 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| DSH Minimal | 3/3 | 0/3 | 0 | 3/3 | 稳定 minimal-like |
| DSH Standard control | 3/3 | 0/3 | 0 | 3/3 | 稳定 minimal-like |

结论分两层：

- **全能力档可用：PASS。** 官方端点接受 `max_tokens=384000`，模型能力元数据与响应被正常保存。
- **目标思维链稳定性：PASS。** 六次 reasoning 全部以 `We need` 风格开始，`Let me=0`。
- **工具 schema 区分度：FAIL / no separation。** 两臂都是 3/3 minimal-like，不能把结果归因于 Minimal 工具 schema。

Standard 第 3 次在 tool call 同一条 assistant message 中带有一句可见内容 `I'll start...`，但首次工具调用前的 reasoning 仍为 minimal-like；报告保留该差异，不把两臂描述为输出完全相同。

## 指纹与用量

- Standard 请求 SHA-256：`6028cb3370be4cda85d3c998318a0bd3ad6349c4c5d8cfa25b81d818772c58a3`
- Minimal 请求 SHA-256：`8393a48344b2f3ece475b243d9a2ad9048c1a0a388440e822d27c15384b49f8f`
- system fingerprint：`a307abda487cd1b463329ccb945ce396`（6/6 相同）

| 指标 | Standard | Minimal | 合计 |
| --- | ---: | ---: | ---: |
| prompt tokens | 2,973 | 3,567 | 6,540 |
| completion tokens | 713 | 514 | 1,227 |
| reasoning tokens | 168 | 132 | 300 |
| total tokens | 3,686 | 4,081 | 7,767 |

## 缓存边界

六次请求全部命中各自已有的 prompt cache 前缀。结合首轮结果，只能确认：

- Minimal 在未命中和命中缓存时都保持 3/3 minimal-like；
- Standard 首轮唯一未命中样本是 standard-like，之后 5 个缓存命中样本全部 minimal-like；
- 当前数据不能区分随机采样、缓存路径或其他服务端状态对 Standard 的影响。

因此 384000 结果证明“全能力配置可以运行且目标轨迹出现”，不证明“384000 导致轨迹改变”，也不证明“Minimal schema 是唯一原因”。

原始响应：`results/dsh-minimal-trajectory-2026-08-16T09-05-58.566Z.json`。
