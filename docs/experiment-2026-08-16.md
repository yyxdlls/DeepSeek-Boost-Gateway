# DSH Minimal trajectory probe — 2026-08-16

## 结论

本轮得到两个不同层级的结论：

- **基础复现：PASS。** DSH Minimal 臂 3/3 为 minimal-like，全部以 `We need` 开始，`Let me` 总数为 0，且全部正常产生工具调用。
- **严格因果隔离：INCONCLUSIVE。** Windows DSH Standard 对照臂只有 1/3 standard-like，另外 2/3 也成为 minimal-like，因此本轮不能声称“仅工具 schema 就稳定导致轨迹切换”。

这足以说明当前官方端点能够在模拟 DSH Minimal 首请求条件下稳定生成候选轨迹，但还不足以冻结最终 Anchor 或宣称已完成因果验证。

## 冻结条件

| 字段 | 值 |
| --- | --- |
| 端点 | `https://api.deepseek.com/chat/completions` |
| 模型 | `deepseek-v4-pro` |
| system | `You are a helpful software engineer assistant.` |
| thinking | enabled |
| reasoning effort | max |
| max tokens | 256000 |
| 每臂次数 | 3 |
| 运行顺序 | Standard → Minimal，交错三轮 |
| Standard 工具 | `pwsh + read` |
| Minimal 工具 | `bash + str_replace_editor` |
| 模型 system fingerprint | `a307abda487cd1b463329ccb945ce396`（6/6 相同） |

请求 SHA-256：

- Standard：`44bd06cd8a05394b2c0117a1ca3544047a3ba5e5d12c86ae07d17f8416e5c969`
- Minimal：`5ffafa826a1932afc9af2921c115e1849ea303a113fc301426124e4479f7d47b`

## 结果

| 序号 | 臂 | 分类 | 首行特征 | Let me | 工具调用 |
| ---: | --- | --- | --- | ---: | --- |
| 1 | Standard | standard-like | `The user wants me...` | 2 | `pwsh`, `pwsh` |
| 2 | Minimal | minimal-like | `We need inspect repo...` | 0 | `bash`, `bash` |
| 3 | Standard | minimal-like | `We need inspect repo...` | 0 | `pwsh`, `pwsh` |
| 4 | Minimal | minimal-like | `We need inspect repo...` | 0 | `bash` |
| 5 | Standard | minimal-like | `We need inspect repo...` | 0 | `pwsh`, `pwsh` |
| 6 | Minimal | minimal-like | `We need inspect repo...` | 0 | `bash` |

所有回复都以 `finish_reason=tool_calls` 结束；实验没有执行模型生成的命令。

## 用量

| 指标 | Standard | Minimal | 合计 |
| --- | ---: | ---: | ---: |
| prompt tokens | 2,973 | 3,567 | 6,540 |
| completion tokens | 693 | 314 | 1,007 |
| reasoning tokens | 162 | 77 | 239 |
| total tokens | 3,666 | 3,881 | 7,547 |

## 缓存观察

两臂的第 1 次请求均无 prompt cache 命中。第 2、3 次均命中各自的相同请求前缀：

- Standard 第 1 次为 standard-like，后两次为 minimal-like；
- Minimal 三次始终为 minimal-like。

缓存命中与 Standard 的结果变化相关，但样本量只有 3，且缓存不应被未经验证地当作行为原因。请求指纹和模型 fingerprint 均未漂移。

## 下一道门槛

在生成或冻结 Anchor 前，先完成一个预注册的确认实验：

1. 补齐实际 Windows DSH Standard 首请求中由 sandbox/approval 组合动态加入的字段与完整描述；
2. 固定分类规则和样本数后再运行，避免看到结果后修改判定；
3. 随机化两臂先后顺序，并分别报告缓存命中与未命中样本；
4. Minimal 仍要求全部 minimal-like、`Let me=0`、全部产生工具调用；
5. 只有 Standard 同时稳定为 standard-like，才把结论升级为严格工具-schema 轨迹切换。

原始响应保存在本地 `results/dsh-minimal-trajectory-2026-08-16T08-59-06.625Z.json`，该目录默认不进入 Git。
