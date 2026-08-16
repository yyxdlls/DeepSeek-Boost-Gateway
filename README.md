# DeepSeek Boost Gateway

DeepSeek Boost Gateway 是一个本地、跨平台的 OpenAI-compatible Gateway，用来把带有 **DeepSeek Harness Minimal 风格推理轨迹**的 DeepSeek V4 接入其他 Coding Harness。

外部 Harness 不需要安装 DeepSeek Harness，也不需要放弃原有工具和工作流。它只需把 OpenAI-compatible Base URL 指向本机 Gateway；Gateway 会在请求进入 DeepSeek V4 前注入模型专属的结构化 Anchor，再将回复以普通 JSON 或 SSE 原样流式返回。

## 当前状态

项目侧已经完成以下组合的实际接入测试：

| 外部 Harness | 模型 | 上游 Provider | 结果 |
| --- | --- | --- | --- |
| GitHub Copilot VS Code 插件 | V4 Pro / V4 Flash | DeepSeek 官方 API / OpenCode Go API | 可触发 DSH Minimal 风格推理轨迹 |
| Kilo Code VS Code 插件 | V4 Pro / V4 Flash | DeepSeek 官方 API / OpenCode Go API | 可触发 DSH Minimal 风格推理轨迹 |

这里的“Minimal 风格”是对推理开头、短语、长度和工具行为的轨迹观察，不等同于对任务质量的自动判定，也不保证每个任务、每轮请求都产生完全相同的措辞。

项目侧进一步实测发现，在外部 Harness 中同时启用 [J-Space Cognition Suite](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) Skill 后，V4 Pro 与 V4 Flash 的复杂任务表现都有明显提升。相关的一句话单网页生成样例收录在 [`showcase/j-space-one-shot/`](showcase/j-space-one-shot/)；这些结果属于实际使用观察，不替代多次运行的受控评测。

当前主要能力：

- V4 Pro 与 V4 Flash 独立端口、独立上游地址、独立 Key 和独立 Anchor；
- OpenAI Chat Completions 请求的结构化 Anchor 注入；
- JSON 与 SSE 透明转发，保留外部 Harness 当前提供的工具集合；
- Gateway 统一持有上游 Key，丢弃 Harness 传入的凭据；
- 本地 WebUI 配置、请求诊断、缓存命中率和轨迹统计；
- 模型专属 Anchor 的后台生成、校验、冻结和热切换；
- 有界轮转日志，以及 Windows/Linux 启停脚本。

## 快速开始

需要 Node.js 22 或更高版本。

### Windows

双击 `start-windows.cmd`，或在终端运行：

```bat
start-windows.cmd
```

停止服务：

```bat
stop-windows.cmd
```

### Linux

```sh
sh ./start-linux.sh
```

停止服务：

```sh
sh ./stop-linux.sh
```

一键启动脚本会检查 Node.js，首次启动时从 `.env.example` 创建 `.env`，检查并安装缺失的运行时依赖，然后启动 Gateway。当前项目没有第三方运行时依赖。缺少 Node.js 或版本过低时，脚本只显示安装提示，不会擅自修改系统环境。

不希望自动打开浏览器时，可在启动前设置：

```text
GATEWAY_NO_OPEN=1
```

也可以手动复制 `.env.example` 为 `.env`，然后运行：

```text
npm start
```

## 默认地址

默认使用 `split` 部署：一个管理父进程监管两个模型数据子进程。

| 用途 | 默认地址 | 说明 |
| --- | --- | --- |
| WebUI / 聚合诊断 | `http://127.0.0.1:8642/` | 不转发模型请求 |
| V4 Pro | `http://127.0.0.1:8643/v1` | 只接受 `deepseek-v4-pro` |
| V4 Flash | `http://127.0.0.1:8644/v1` | 只接受 `deepseek-v4-flash` |

关闭启动终端、使用对应停止脚本或运行 `npm stop`，都会结束管理父进程及其 Pro/Flash 子进程。停止工具会校验 PID、健康地址和实例指纹，不会粗暴结束系统中的其他 Node.js 进程。

## 接入外部 Harness

1. 启动 Gateway，打开 `http://127.0.0.1:8642/`。
2. 在 WebUI 中分别为 Pro 或 Flash 填写上游 Base URL 和 API Key。
3. 确认该模型已启用，增强模式为 `anchor`，并绑定同模型的 Anchor。
4. 在外部 Harness 中选择 OpenAI-compatible Provider。
5. 把 Base URL 改为对应的本地数据地址：Pro 使用 `http://127.0.0.1:8643/v1`，Flash 使用 `http://127.0.0.1:8644/v1`。
6. Model 保持为 `deepseek-v4-pro` 或 `deepseek-v4-flash`。

部分 Harness 强制要求填写 API Key。此时可以填任意非空占位值：Gateway 会删除请求中的 `Authorization` 和 `x-api-key`，只使用 WebUI 或本地配置中保存的 Gateway Key 请求上游。

DeepSeek 官方 API 与 OpenCode Go API 不需要共用一个地址或一个 Key。每个模型配置都可以独立选择上游 Provider；外部 Harness 始终只连接本地 Gateway。

## 实现思路

```text
Copilot / Kilo Code / 其他 Harness
                 │ OpenAI Chat Completions
                 ▼
       DeepSeek Boost Gateway
       ├─ 校验端口与模型绑定
       ├─ 删除 Harness 凭据
       ├─ 载入模型专属 Anchor
       ├─ 前置回放 Minimal 轨迹
       ├─ 接回当前 Harness 指令、会话和工具
       └─ 使用 Gateway Key 请求上游
                 │
                 ▼
       DeepSeek 官方 / OpenCode Go
```

### 1. Anchor 是结构化历史，不是单句提示词

每个 Anchor 都是带 SHA-256 指纹的不可变 Artifact，包含已完成的 Minimal 风格推理片段、`bash → str_replace_editor` 工具调用及其固定结果。它们作为历史消息被回放，不会在用户机器上重新执行其中的命令，也不会把 Anchor 使用过的 bootstrap 工具强行加入当前 Harness 的工具目录。

Pro 与 Flash 使用独立 Artifact：

- `anchors/dsh-minimal-open-workstream-pro.json`
- `anchors/dsh-minimal-open-workstream-flash.json`

Gateway 会校验 Artifact 指纹和模型归属，避免把 Pro Anchor 误用于 Flash，或把已被手工篡改的文件静默加载。

### 2. Anchor 放在当前 Harness 上下文之前

对 `/chat/completions` 请求，Gateway 会把 Anchor 历史放到消息前缀，然后加入连续工作提示，再接回当前 Harness 的 system/developer 指令和原会话。当前请求的 `model`、`tools`、采样参数和流式设置保持不变。

这样做的目标是先建立 Minimal 风格的行为轨迹，再让模型处理真实 Harness 的任务和工具，而不是让 Gateway 替代 Harness 本身。

### 3. 固定前缀与缓存

Anchor 是稳定前缀，连续使用同一模型、同一 Artifact 和相近请求结构时，有机会获得较高的 Provider 前缀缓存命中率。WebUI 会同时显示单条请求和已保存请求的 token 加权缓存命中率。

切换以下任一内容都可能改变请求前缀并降低缓存命中：

- `anchor` / `bypass` 模式；
- Pro / Flash 或上游 Provider；
- Anchor Artifact；
- Harness 的 system/developer 指令；
- 当前工具 schema 或工具顺序。

因此不要为了短期观察频繁切换 Anchor。需要比较方案时，最好在独立会话中测试，并把缓存变化与轨迹变化分开看。

### 4. Gateway 持有上游凭据

外部 Harness 的凭据不会决定上游路由，也不会被转发。Pro 与 Flash 分别使用自己的 Gateway Key；页面只返回前后片段组成的脱敏预览，不返回明文。未配置 Key 时，数据端口会在本地返回 `503 gateway_upstream_api_key_not_configured`，不会向上游发请求。

## WebUI

管理页面可以：

- 独立启停 Pro/Flash，并配置端口、上游、Key、模式和 Anchor；
- 查看管理父进程及两个模型子进程的状态；
- 查看请求状态、推理/正文长度、工具调用和 finish reason；
- 查看单条与总体缓存命中率；
- 统计 `we`、`let me`、`let's`、`I am` 等轨迹短语；
- 显示推理开头四个英文词或四个中文字；
- 创建模型专属 Anchor；
- 在二次确认后清理已保存请求和轮转日志。

WebUI 默认不返回完整提示词、完整思维链或回复原文。轨迹分类中的“无明显倾向”仅表示关键词评分没有达到正负阈值，不代表回答含糊或质量较低。

WebUI 保存的覆盖配置位于本机 `gateway.config.json`，该文件已被 Git 忽略。Key 输入框留空会保留原值；只有勾选“清除现有 Key”才会删除。

如果 WebUI 监听在非 loopback 地址，必须设置 `GATEWAY_MANAGEMENT_TOKEN`。浏览器只把管理令牌保存在当前标签页的 `sessionStorage`。

## Anchor 管理

内置 Anchor 是只读、版本化的 Artifact。WebUI 的 Anchor Builder 允许用户选择 Pro 或 Flash，并自行填写锚定提示词。Builder 会：

1. 使用所选模型自己的上游地址和 Gateway Key 生成候选；
2. 用固定内存仓库返回工具结果，不执行模型生成的命令；
3. 校验工具顺序和 Artifact 结构；
4. 使用 create-only 语义保存通过的 Artifact，拒绝覆盖同名文件；
5. 自动绑定到对应模型并热应用。

生成 Anchor 会产生真实上游调用和 token 费用。命令行 dry run 不发送付费请求：

```text
npm run anchor:dry-run
```

检查现有 Artifact：

```text
npm run anchor:inspect
```

更多 Artifact 规则见 [`anchors/README.md`](anchors/README.md)。

## 诊断与日志

默认 `metadata` 模式只保存脱敏统计，不保存请求和回复原文。split 模式的日志分别位于：

```text
results/gateway/pro/
results/gateway/flash/
```

日志默认每个文件 64 MiB，最多保留 5 份，并可从 WebUI 手动清理。切换到 `full` 会额外保存完整请求、代码、推理和工具结果，只应在可信本机环境中短期调试。

CLI 查看最近请求：

```text
npm run gateway:inspect
npm run gateway:inspect -- --id <request-id>
```

管理接口：

```text
GET /__gateway/health
GET /__gateway/diagnostics?limit=10
GET /__gateway/diagnostics/<request-id>
```

每次数据请求的响应头会包含 `x-gateway-request-id`，便于在 WebUI、CLI 和日志之间定位同一请求。

## 配置

完整模板见 [`.env.example`](.env.example)。常用配置：

```dotenv
GATEWAY_INSTANCE_MODE=split
GATEWAY_WEB_UI_PORT=8642

GATEWAY_PRO_ENABLED=true
GATEWAY_PRO_PORT=8643
GATEWAY_PRO_UPSTREAM_BASE_URL=https://api.deepseek.com
GATEWAY_PRO_UPSTREAM_API_KEY=
GATEWAY_PRO_ENHANCEMENT_MODE=anchor
GATEWAY_PRO_ANCHOR_PATH=anchors/dsh-minimal-open-workstream-pro.json

GATEWAY_FLASH_ENABLED=true
GATEWAY_FLASH_PORT=8644
GATEWAY_FLASH_UPSTREAM_BASE_URL=https://api.deepseek.com
GATEWAY_FLASH_UPSTREAM_API_KEY=
GATEWAY_FLASH_ENHANCEMENT_MODE=anchor
GATEWAY_FLASH_ANCHOR_PATH=anchors/dsh-minimal-open-workstream-flash.json
```

WebUI 中保存的值优先于 `.env` 中对应的 Profile 配置。Pro/Flash 专用值留空时，可以回退到共享配置。

## 协议边界

当前 Anchor 变换只应用于 OpenAI-compatible `POST /chat/completions`。其他路径会透明转发，并标记为 `bypass-unsupported-path`；它们不会自动获得 Anchor。因此，外部 Harness 必须实际使用 Chat Completions 数据面，不能仅因为 Provider 自称兼容 Responses 或 Anthropic Messages 就假定 Anchor 已注入。

单个请求可以用以下 Header 临时覆盖默认模式：

```text
x-deepseek-boost-mode: anchor
x-deepseek-boost-mode: bypass
```

该控制 Header 不会转发给上游。

## 本地验证

```text
npm test
npm run probe:dry-run
npm run anchor:dry-run
npm run anchor:inspect
```

`probe:dry-run` 和 `anchor:dry-run` 不发送上游请求。完整探针和 Anchor 生成命令会产生费用，运行前请确认 Provider、模型、Key 和 token 上限。

## 参考与致谢

本项目受雨神与风神分享的方案启发。为了让实现依据可以公开复查，主要参考以下仓库：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：官方 Minimal 环境、工具协议和运行方式；
- [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)：Minimal bootstrap、轨迹锚定以及后续工具面的设计思路；
- [modeltest](https://github.com/xiaobright/modeltest)：公开的轨迹观测、Minimal/Standard 对照和统计方法；
- [J-Space Cognition Suite](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)：推理时工作空间、长程状态维持和按需加载思路。

这些项目与 DeepSeek Boost Gateway 相互独立。本仓库的 Anchor 回放、跨 Harness Gateway、凭据隔离和 WebUI 管理均为本项目自己的实现；外部项目的实验结论也不应被解释为本项目对所有模型和任务的效果保证。

协议来源与实现边界的进一步记录见 [`docs/protocol-sources.md`](docs/protocol-sources.md) 和 [`docs/architecture.md`](docs/architecture.md)。早期实验报告保留在 `docs/` 中供复查，但不再作为 README 的主要使用说明。
