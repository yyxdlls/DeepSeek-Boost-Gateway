# 双工具 Anchor 候选生成结果（2026-08-16）

## 结论

已在 DeepSeek 官方 Chat Completions 端点生成并冻结首个完整双工具
Anchor Artifact。3 个候选中 2 个严格合格，最终选择总 token 更少的候选 3。

选中轨迹不是“请求里列出了两个工具”，而是模型确实完成了以下多轮协议：

```text
assistant reasoning → bash tool call
synthetic bash result
assistant reasoning → str_replace_editor(view) tool call
synthetic editor result
assistant reasoning → final answer
```

总工具调用恰好 2 次，分别为 `bash` 和 `str_replace_editor`，后一调用发生在前一
tool result 之后。全轨迹 `Let me=0`，所有安全和结构检查均通过。

## 固定配置

| 项目 | 值 |
| --- | --- |
| API 模型 | `deepseek-v4-pro` |
| 服务版本元数据 | `DeepSeek-V4-Pro-0813` |
| 上下文能力元数据 | 1,000,000 tokens |
| 请求 `max_tokens` | 384,000 |
| thinking | enabled |
| reasoning effort | max |
| system | `You are a helpful software engineer assistant.` |
| bootstrap tools | `bash`, `str_replace_editor` |
| 实际宿主机工具执行 | 否 |

## 候选结果

| 候选 | 合格 | 工具调用数 | 接受的工具序列 | `Let me` | 总 tokens | reasoning tokens |
| ---: | :---: | ---: | --- | ---: | ---: | ---: |
| 1 | 否 | 4 | bash → str_replace_editor | 0 | 16,826 | 2,303 |
| 2 | 是 | 2 | bash → str_replace_editor | 0 | 5,268 | 349 |
| 3 | 是（选中） | 2 | bash → str_replace_editor | 0 | 4,993 | 235 |

候选 1 的首个命令含 `2>/dev/null`，被保守的只读守卫视为重定向写入而拒绝；
模型随后重试，导致总调用数为 4，因此即使后来成功完成两种工具也不能入选。
候选 2、3 均一次按序成功。选择器先比较工具调用数，再比较总 tokens，所以选择
候选 3。

## 选中轨迹

1. subturn 1：首行以 `We need` 开始，只调用一次 `bash`；参数用于显示工作目录、
   顶层内容并定位 README。
2. 状态机返回固定的 `/repo` 列表；没有执行模型生成的 shell 命令。
3. subturn 2：只调用一次 `str_replace_editor`，参数为 `command=view`、
   `path=/repo/README.md`。
4. 状态机返回固定的行号化 README；没有读取或修改宿主机文件。
5. subturn 3：返回一句最终总结，不再调用工具。

选中候选用量：prompt 4,534、completion 459、reasoning 235、总计 4,993 tokens；
其中 cache hit 4,224、cache miss 310。

## 长度画像

| 指标 | 精确值 |
| --- | ---: |
| 格式化 Artifact | 15,894 chars / 15,898 UTF-8 bytes |
| 紧凑 Artifact JSON | 12,584 chars / 12,588 bytes |
| 可回放 history messages JSON | 2,839 chars / 2,841 bytes |
| bootstrap tool schemas JSON | 3,294 chars / 3,294 bytes |
| history + bootstrap schemas canonical bundle | 6,164 chars / 6,166 bytes |
| reasoning 正文 | 981 chars |
| 最终可见答复 | 135 chars |
| tool arguments | 197 chars |
| tool results | 189 chars |

三个 assistant subturn 的 reasoning 分别为 522、366、93 chars。上述字符和字节数由
`npm run anchor:inspect` 精确计算。4,993 tokens 是生成候选时三个请求的累计 Provider
用量，不是把 Anchor 注入新请求时的 replay 长度；精确 replay tokens 尚未通过目标
Provider tokenizer 或计量请求测得，因此保持为 `null`。

## Artifact 与完整性

- Artifact：`anchors/dsh-minimal-two-tool-v1.json`
- 原始候选：`results/anchor-candidates-2026-08-16T09-23-21.908Z.json`
- Artifact SHA-256 内容指纹：
  `81ad9c24a57b7583b30aa24553c14e92fca69683ea0c9e814ee1dc59dbc5a601`
- 独立重算指纹与文件内指纹一致。
- API Key 未写入 Artifact、原始结果或仓库文件。

Artifact 使用 create-only 写入；同一 ID 的后续构建会拒绝覆盖。

## 解释边界与下一步

本结果证明了一个结构化的双工具轨迹已经生成，并完整保留 system、reasoning、
tool calls、tool results 和最终回复。它也比此前只实际调用 shell 的单轮探针提供了
更完整的工具交互轨迹。

但“两个工具比一个工具锚得更牢”仍未由本实验直接证明。下一步应固定模型、system、
任务和完整当前工具集，比较无 Anchor、shell-only Anchor 与这个 two-tool Anchor 在
held-out 仓库任务上的工具选择、任务成功率、成本和轨迹漂移。只有这一 A/B 才能回答
双工具是否产生了可测的额外增益。
