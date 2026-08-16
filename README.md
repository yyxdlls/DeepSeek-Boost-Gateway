# DeepSeek Boost Gateway

一个面向 DeepSeek V4 编程模型的本地、跨平台 OpenAI-compatible Gateway。当前版本已完成 Chat Completions 数据面、不可变 Anchor 注入、SSE 透明转发、模型隔离、轨迹统计、本地 WebUI、Pro/Flash 独立热配置、后台 Anchor 创建、快速诊断和有界日志。

## 启动 Gateway

需要 Node.js 22 或更高版本。推荐使用仓库根目录的一键脚本。

Windows：双击 `start-windows.cmd`，或在终端运行：

```bat
start-windows.cmd
```

Linux：

```sh
sh ./start-linux.sh
```

关闭 Gateway 时不要结束所有 Node.js 进程。使用配套脚本：

```text
Windows: stop-windows.cmd
Linux:   sh ./stop-linux.sh
```

也可以运行 `npm stop`。启动成功后会创建 `results/gateway.pid.json`；关闭工具会同时校验 PID、管理健康地址和随机实例指纹，三者匹配才会发送终止信号。失效 PID 文件只会被清理，不会用于结束其他进程。

一键脚本会执行以下工作：

1. 检查 Node.js 版本；未安装或低于 22 时显示官方下载地址并停止，不会擅自修改系统 Node.js；
2. 首次启动时从 `.env.example` 创建 `.env`，以后不会覆盖用户配置；
3. 检查 `package.json` 中的运行时依赖，缺失时调用 npm 自动安装；当前版本没有第三方运行时依赖；
4. 检测现有 Gateway，已运行时直接复用，否则启动服务；
5. 启动脚本打开并保留一个 Gateway 终端，明确显示当前 WebUI 地址；关闭该终端会结束它启动的 Gateway。Gateway 就绪后再用默认浏览器打开 WebUI。Linux 无桌面环境时在当前终端前台运行并只输出访问地址。

服务器或其他不希望自动打开浏览器的环境可以先设置 `GATEWAY_NO_OPEN=1`。也可以跳过一键脚本，手动复制 `.env.example` 为 `.env` 并启动：

```text
npm start
```

默认使用 `split` 模式：WebUI 位于独立管理端口，Pro 数据面默认位于：

```text
http://127.0.0.1:8643/v1
```

浏览器管理界面：

```text
http://127.0.0.1:8642/
```

WebUI 不需要安装或启动额外前端服务。管理/WebUI 父进程监管 Pro 与 Flash 两个数据子进程；父进程或常驻终端结束时，两个子进程会自动退出。页面可以查看在线状态、模型与 Anchor 绑定、全部已保存请求汇总、单条及总体 token 缓存命中率、推理/正文长度、轨迹关键字、工具调用、结束状态和用量，也能分别管理 Pro/Flash、从已生成 Artifact 下拉选择 Anchor 并创建模型专属 Anchor。它只读取脱敏诊断数据，不显示提示词、完整思维链或回复原文；新记录最多显示英文开头四词或中文开头四字。

如需旧式单端口兼容部署，可以把 `GATEWAY_INSTANCE_MODE` 改回 `single`；此模式保留只读诊断，但不提供 WebUI 热配置和后台 Anchor 创建。

### Pro / Flash 独立配置

默认的 `GATEWAY_INSTANCE_MODE=split` 会建立一个管理父进程和两个受监管的数据子进程，共三个互相隔离的监听：

| 用途 | 默认地址 | 是否转发模型请求 |
| --- | --- | --- |
| WebUI / 聚合诊断 | `http://127.0.0.1:8642/` | 否 |
| V4 Pro 数据面 | `http://127.0.0.1:8643/v1` | 是，只接受 `deepseek-v4-pro` |
| V4 Flash 数据面 | `http://127.0.0.1:8644/v1` | 是，只接受 `deepseek-v4-flash` |

Pro 与 Flash 分别使用 `GATEWAY_PRO_UPSTREAM_API_KEY` 和 `GATEWAY_FLASH_UPSTREAM_API_KEY`，也能分别设置端口、Host、上游地址、增强模式、Anchor 和日志目录。专用值留空时会回退到共享配置；页面会明确区分“独立 Key”和“继承共享 Key”，两者不必使用同一个 Key 或端口。两者默认都启用 Anchor 模式。Flash 初始绑定一份明确标记为“Pro 复制基线”的临时 Artifact，方便先联调；它不冒充 Flash 灰测结果，正式使用时应在 WebUI 中生成并切换到 Flash 原生 Anchor。

最小拆分配置示例：

```dotenv
GATEWAY_INSTANCE_MODE=split
GATEWAY_WEB_UI_PORT=8642

GATEWAY_PRO_ENABLED=true
GATEWAY_PRO_PORT=8643
GATEWAY_PRO_UPSTREAM_API_KEY=your-pro-key

GATEWAY_FLASH_ENABLED=true
GATEWAY_FLASH_PORT=8644
GATEWAY_FLASH_UPSTREAM_API_KEY=your-flash-key
GATEWAY_FLASH_ANCHOR_PATH=anchors/dsh-minimal-open-workstream-two-tool-v2-flash-copy.json
```

`split` 现在同时表示进程与端口隔离：WebUI/管理父进程、Pro 子进程、Flash 子进程分开运行，模型、Key、Anchor 和流量不会混用。父进程通过本机 IPC 聚合统计并管理子进程生命周期；数据端口不会提供页面或公开诊断接口。默认日志也会拆到 `results/gateway/pro/` 和 `results/gateway/flash/`，避免并发写入同一个文件。

WebUI 保存的覆盖项写入本机 `gateway.config.json`（已加入 `.gitignore`，权限设为仅当前用户），保存后只重启对应数据监听并立即生效；管理页面不会中断。Key 字段留空会保留现有值，只有勾选“清除现有 Key”才会删除。管理 API 和页面只返回 `apiKeyConfigured`、来源状态和前 7/后 4 位脱敏预览，不回传 Key 明文。

如果设置了 `GATEWAY_MANAGEMENT_TOKEN`，WebUI 会提示输入管理令牌；令牌只保存在当前标签页的 `sessionStorage`，不写入 URL、仓库或磁盘。默认 loopback 配置无需令牌。

把外部 Harness 的 Base URL 改为该地址。Model 仍按原 Provider 配置；API Key 统一由 Gateway 控制。密钥规则是：

1. 单实例的 `GATEWAY_UPSTREAM_API_KEY`，或拆分实例各自的 `GATEWAY_PRO_UPSTREAM_API_KEY` / `GATEWAY_FLASH_UPSTREAM_API_KEY`，是唯一允许发送给对应上游的凭据；
2. Harness 传入的 `Authorization` 和 `x-api-key` 一律删除，不参与选择，也不会转发；
3. Gateway 没有配置 Key 时，数据面在本地返回 `503 gateway_upstream_api_key_not_configured`，不会请求上游；
4. 凭据头不会写入日志。

默认服务模式为 `anchor`。它在 Chat Completions 请求前追加冻结的开放式双工具 Anchor 历史：一项长期工程问题以 `bash → str_replace_editor` 开始，轨迹停在第二个工具结果，没有总结或结束答复；随后用“我们继续工作”衔接原 Harness system 与会话历史。Gateway 原样保留 model 和当前 tools，历史中的 bootstrap 工具 schema 不会加入当前工具目录。普通 JSON 和 SSE 均边接收边转发。

Anchor 按模型严格隔离。仓库内置 Pro Artifact，并附带一份绑定为 Flash、同时记录 Pro 来源的复制基线；Gateway 不会把 Pro Artifact 文件直接误绑到 Flash。WebUI 只会在对应模型的下拉框中列出校验通过的 Artifact。可用两个端口分别启动两个实例，也可以在同一实例的 `GATEWAY_MODELS` 中配置两个模型。

设置 `GATEWAY_ENHANCEMENT_MODE=bypass` 可全局旁路；单个请求也可用 `x-deepseek-boost-mode: bypass` 或 `anchor` 临时覆盖，控制头不会转发上游。Anchor 目前只变换 `/chat/completions`；其他协议路径保持透明转发，并记录为 `bypass-unsupported-path`。

Harness 可以继续发送其固定格式要求的 Key，但 Gateway 会在本地丢弃它，只用 `GATEWAY_UPSTREAM_API_KEY` 构造上游 `Authorization: Bearer ...`。凭据头及 URL 中疑似密钥的查询参数不会写入日志。

默认 `metadata` 日志写入 `results/gateway/traffic.jsonl`，保存注入前后消息数、Anchor ID、reasoning/正文长度、轨迹短语、历史与当前工具调用、结束原因、客户端断流、传输错误和用量，不保存原始提示或回复。Gateway 重启时会从当前及轮转日志恢复保存上限内的最新脱敏诊断，因此 WebUI 总体统计不会因正常重启归零。`full` 模式会额外保存完整请求和响应，可能含用户提示、代码与工具输出，只应用于本机调试；恢复到页面前仍会剥离原始 body。日志默认每个 64 MiB 轮转，保留 5 份。

配置模板见 [`.env.example`](.env.example)。健康检查地址：

```text
http://127.0.0.1:8642/__gateway/health
```

## 快速检查回复轨迹

Gateway 在转发 SSE 时增量重建统计，因此短语即使拆在不同网络 chunk 或不同 delta 中也不会漏算。统计明确分为：

- `anchor_history`：注入的冻结历史；
- `request_history`：Harness 原会话中的历史回复；
- `current_response`：本次上游刚生成的回复。

推荐直接打开本地 WebUI。也可以通过 CLI 查看最近 10 次完成或中断的请求：

```text
npm run gateway:inspect
```

按 Gateway 返回的 `x-gateway-request-id` 查看一次请求：

```text
npm run gateway:inspect -- --id <request-id>
```

机器可读接口为 `GET /__gateway/diagnostics?limit=10` 和 `GET /__gateway/diagnostics/<request-id>`；只返回统计和最多四词/四字的开头片段，不返回完整原文。WebUI 会请求当前保存上限内的全部记录；总缓存命中率按 token 加权，即总命中 tokens 除以总命中与未命中 tokens 之和。`偏 Minimal`、`偏 Standard` 和`无明显倾向`只是短语统计分数：未达到正负阈值时显示“无明显倾向”，不是质量或能力结论。

页面的“清理请求数据”会删除 Pro/Flash 的内存诊断以及当前和轮转的 `traffic`/`activity` 日志。操作先弹出风险确认，再要求准确输入“清空全部请求”；日志即使不手动清理也受单文件大小和保留份数限制，不会无限增长。

`complete=false` 会进一步区分客户端主动断流、上游传输错误、没有 finish reason 或统计超过独立观测上限。原始 body 的捕获上限不会影响 SSE 轨迹统计。

## 生成 Flash 专属 Anchor

推荐直接在 WebUI 的“Anchor 管理”中选择模型并填写锚定提示词：页面会显示候选数、每候选最大轮数和最多上游调用次数；用户提示词会直接进入候选生成请求。任务在后台运行，使用所选配置自己的 Gateway Key 与上游地址，成功后以不可覆盖方式保存新的冻结 Artifact、绑定对应模型并热应用。内置 Pro/Flash 默认 Artifact 均标记为只读；当前 Flash 默认内容暂时来源于 Pro 基线，后续可由项目版本替换，但 WebUI 用户不能修改原文件。

命令行方式仍然保留。先做不产生费用的请求预览：

```powershell
.\scripts\run-anchor-candidate.ps1 -DryRun -OpenWorkstream -Model deepseek-v4-flash -ArtifactId dsh-minimal-open-workstream-two-tool-v2-flash
```

确认后移除 `-DryRun`。脚本会隐藏 API Key 输入，并以不可覆盖方式生成 Artifact。然后设置：

```text
GATEWAY_MODELS=deepseek-v4-flash
GATEWAY_FLASH_ANCHOR_PATH=anchors/dsh-minimal-open-workstream-two-tool-v2-flash.json
```

若要同时服务 Pro 与 Flash，把 `GATEWAY_MODELS` 设为逗号分隔的两个模型，并同时配置两条 Anchor 路径。

## 最新结果

2026-08-16 首轮官方端点实验已经完成：DSH Minimal 臂 3/3 稳定为 minimal-like、`Let me=0`，基础复现通过；Standard 对照为 1/3 standard-like、2/3 minimal-like，严格因果隔离暂未通过。详见 [`docs/experiment-2026-08-16.md`](docs/experiment-2026-08-16.md)。

当前默认档已升级为 DeepSeek V4 的官方全能力值，第二轮可比复测已经完成：两臂均为 3/3 minimal-like、`Let me=0`。全能力配置和目标轨迹稳定性通过，但工具 schema 不再有区分度。详见 [`docs/experiment-full-capability-2026-08-16.md`](docs/experiment-full-capability-2026-08-16.md)。

因此下一步不再把“首轮出现任意工具调用”当成 Anchor。新的 Anchor Builder 强制模型在不同 assistant subturn 中依次调用 `bash` 和 `str_replace_editor(view)`，并保存 reasoning、两次 tool call、两次固定 tool result 和最终答复。是否比单工具锚点更强仍是假设，需要后续 A/B 评测。

2026-08-16 官方生成结果：3 个候选中 2 个合格，候选 3 以恰好两次调用完成 `bash → str_replace_editor`，全轨迹 `Let me=0`，已冻结为 [`anchors/dsh-minimal-two-tool-v1.json`](anchors/dsh-minimal-two-tool-v1.json)。详见 [`docs/anchor-candidate-2026-08-16.md`](docs/anchor-candidate-2026-08-16.md)。

| 能力 | V4 Pro | V4 Flash |
| --- | ---: | ---: |
| 当前服务版本 | `DeepSeek-V4-Pro-0813` | `DeepSeek-V4-Flash-0731` |
| 上下文窗口 | 1,000,000 tokens | 1,000,000 tokens |
| 最大单次输出 | 384,000 tokens | 384,000 tokens |
| 并发上限 | 500 | 2,500 |
| Thinking effort | low / high / max | low / high / max |

上下文窗口是输入、历史和本次输出共享的模型容量，不是 API 的 `max_tokens` 值。本实验实际发送 `max_tokens=384000`；不会为了验证元数据而构造一个昂贵的 1M-token 空输入。

## 当前实验

实验固定以下条件不变：

- 模型：`deepseek-v4-pro`
- system（逐字固定）：`You are a helpful software engineer assistant.`
- 同一个仓库检查任务
- thinking：enabled
- reasoning effort：max
- `max_tokens`：384000（官方最大单次输出）

只切换工具结构，并交错运行两臂：

1. `dsh-standard-control`：当前 Windows DSH Standard-family 的 `pwsh + read`；
2. `dsh-minimal`：DSH Minimal 的 `persistent bash + str_replace_editor` 精确 schema。

默认每臂 3 次，共 6 个请求。只分析首次工具调用前的 `reasoning_content`；不会执行模型生成的工具命令。严格通过条件是：Minimal 臂 3/3 为 `minimal-like` 且没有 `Let me`，对照臂 3/3 为 `standard-like`，两臂都实际产生工具调用。

`We need` / `Let me` 只是本阶段的轨迹指纹，不是最终产品质量指标。

## 本地验证（不发送 API 请求）

需要 Node.js 22 或更高版本：

```text
npm test
npm run probe:dry-run
npm run anchor:dry-run
npm run anchor:inspect
```

Windows 也可以运行：

```powershell
.\scripts\run-minimal-probe.ps1 -DryRun
```

Dry run 会打印两臂的完整请求与 SHA-256 指纹，并明确显示 `paidRequestsSent: 0`。

## 构建双工具 Anchor 候选

Windows PowerShell 会隐藏 API Key 输入，并只在候选严格通过时创建不可覆盖的 Artifact：

```powershell
.\scripts\run-anchor-candidate.ps1
```

候选必须恰好按以下顺序完成：

```text
bash → 固定仓库列表 → str_replace_editor(view README) → 固定 README → 最终答复
```

模型生成的命令绝不会在宿主机执行，两个工具结果都来自固定的内存仓库。并行乱序、重复工具、shell 偷读 README 或写操作会使候选的协议结构检查失败。`We need`、`Let me`、轨迹分类和各段长度只作为统计展示，不参与候选合格与否；Anchor 是否值得保存和使用由用户判断。默认生成 3 个候选，每个最多 6 个 assistant subturn；可用 `ANCHOR_RUNS`、`ANCHOR_MAX_SUBTURNS`、`ANCHOR_TIMEOUT_MS` 和 `ANCHOR_MAX_TOKENS` 调整。

通过后保存两类本地产物：完整候选响应放在忽略版本控制的 `results/`，选中项冻结到 `anchors/dsh-minimal-two-tool-v1.json`。冻结文件用 create-only 语义写入，不会被后续运行覆盖。

`npm run anchor:inspect` 会只读显示 Artifact 文件大小、紧凑 JSON 大小、可回放历史与 bootstrap tool schema 大小、reasoning/工具参数/工具结果字符数、逐 subturn 长度以及生成时 Provider 用量。字符和 UTF-8 字节数是精确值；生成时累计 token 用量不等于将 Anchor 注入新请求的长度，所以在没有使用目标 Provider tokenizer 实测前不会伪报精确 replay tokens。

## 运行官方 API 探针

Windows PowerShell 会隐藏 API Key 输入：

```powershell
.\scripts\run-minimal-probe.ps1
```

也可以由外部密钥管理器设置 `DEEPSEEK_API_KEY` 后运行：

```text
npm run probe:minimal
```

可选环境变量：

- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`：默认 `deepseek-v4-pro`
- `PROBE_RUNS`：默认每臂 `3`
- `PROBE_TIMEOUT_MS`：默认 `300000`
- `PROBE_MAX_TOKENS`：默认 `384000`；设为 `256000` 可复现首轮 DSH 基准条件

完整响应保存在本地 `results/`，其中可能包含模型 reasoning 和工具参数，请不要公开上传。API Key 不写入请求结果或仓库。

## 协议来源

详细的版本与投影规则见 [`docs/protocol-sources.md`](docs/protocol-sources.md)。

- DSH Minimal 工具名与描述来自 `@deepseek-ai/dsh-tool-bash-persistent@0.0.1-rc.1` 和 `@deepseek-ai/dsh-tool-str-replace-editor@0.0.1-rc.1`；
- API JSON Schema 由 DSH rc.1 当前的 `defineTool` 参数投影规则还原（不混用旧版带 `title` 的轨迹 schema）；
- Windows 对照来自 `@deepseek-ai/dsh-tool-pwsh@0.0.1-rc.1` 与 `@deepseek-ai/dsh-tool-fs@0.0.1-rc.1`；
- 固定任务取自公开 `modeltest` trigger probe；
- 首轮 256000 是 DSH adapter 的历史复现条件，不是模型上限；当前全能力档使用官方 384000 最大输出。

## Anchor 生成后的验证

双工具候选通过结构门槛后，随后验证：

1. 无 Anchor 与完整结构化 Anchor；
2. 仅 Environment Switch、纯文本轨迹和无关轨迹；
3. 当前 tools 中保留或移除 bootstrap tools；
4. 原生 Harness tools 与固定桥接 tools。

届时主指标会换成安全任务成功率、工具调用合法性、成本和延迟，而不是措辞风格。
