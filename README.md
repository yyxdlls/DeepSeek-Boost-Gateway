# DeepSeek Boost Gateway

DeepSeek Boost Gateway 是一个本地、跨平台的 OpenAI-compatible Gateway，用来把带有 **DeepSeek Harness Minimal 风格思维链**的 DeepSeek V4 接入其他 Coding Harness。

外部 Harness 不需要安装 DeepSeek Harness，也不需要放弃原有工具和工作流。它只需把 OpenAI-compatible Base URL 指向本机 Gateway；Gateway 会在 `anchor` 模式下注入模型专属的结构化 Anchor，再将回复以普通 JSON 或 SSE 原样流式返回。

## 当前状态

项目侧已经完成以下组合的实际接入测试：

| 外部 Harness | 模型 | 上游 Provider | 结果 |
| --- | --- | --- | --- |
| GitHub Copilot VS Code 插件 | V4 Pro / V4 Flash | DeepSeek 官方 API / OpenCode Go API | 可触发 DSH Minimal 风格思维链 |
| Kilo Code VS Code 插件 | V4 Pro / V4 Flash | DeepSeek 官方 API / OpenCode Go API | 可触发 DSH Minimal 风格思维链 |

这里的“Minimal 风格”是对推理开头、短语、长度和工具行为的思维链观察，不等同于对任务质量的自动判定，也不保证每个任务、每轮请求都产生完全相同的措辞。

当前主要能力：

- V4 Pro、V4 Flash 与 V4 Vision（experimental）三个独立 Profile：独立端口、独立上游地址、独立 Key 和独立日志；
- OpenAI Chat Completions 请求的结构化 Anchor 注入；
- 独立于 Full Anchor 的微锚点管理：每个模型独立开关与保存项，逐条 user 消息末尾确定性注入；
- JSON 与 SSE 透明转发，保留外部 Harness 当前提供的工具集合；
- Gateway 统一持有上游 Key，丢弃 Harness 传入的凭据；
- 本地 WebUI 配置、请求诊断、缓存命中率和思维链统计；
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

默认使用 `split` 部署：一个管理父进程监管 Pro、Flash、Vision 三个模型数据子进程。

| 用途 | 默认地址 | 说明 |
| --- | --- | --- |
| WebUI / 聚合诊断 | `http://127.0.0.1:8642/` | 不转发模型请求 |
| V4 Pro | `http://127.0.0.1:8643/v1` | 只接受 `deepseek-v4-pro` |
| V4 Flash | `http://127.0.0.1:8644/v1` | 只接受 `deepseek-v4-flash` |
| V4 Vision (exp) | `http://127.0.0.1:8645/v1` | 只接受 `deepseek-v4-flash-vision-exp` |

WebUI 可保存三种部署方式；拓扑变更在重启 Gateway 后生效：

| 方式 | 数据端口 |
| --- | --- |
| 多端口（`split`，默认） | 8643 / 8644 / 8645，每端口一个模型 |
| 单端口（`single`） | 8642，一个多模型路由端口；按请求 `model` 选用该模型自己的上游、Key、增强模式、Anchor 与微锚 |
| 全部开启（`all`） | 保留 8643 / 8644 / 8645 单模型口，并增加 8646 多模型路由端口；管理页仍为 8642 |

`all` 的 8646 与 `single` 的 8642 都是按模型分发的路由口，不是合并逻辑面。每个官方模型只用自己的 `GATEWAY_PRO_*` / `GATEWAY_FLASH_*` / `GATEWAY_VISION_*`；缺 Key 的模型返回 503，不会回填 `GATEWAY_UPSTREAM_API_KEY`。缺上游时该模型使用代码默认 `https://api.deepseek.com`。

关闭启动终端、使用对应停止脚本或运行 `npm stop`，都会结束管理父进程及其 Pro/Flash/Vision 子进程。停止工具会校验 PID、健康地址和实例指纹，不会粗暴结束系统中的其他 Node.js 进程。

## 接入外部 Harness

1. 启动 Gateway，打开 `http://127.0.0.1:8642/`。
2. 在 WebUI 中分别为 Pro、Flash 或 Vision 填写各自的上游 Base URL 和 API Key。
3. 确认该模型已启用。三个模型默认都启用内置微锚点（`ENHANCEMENT_MODE` 与微锚点是两件事）；Pro 默认增强模式为 `anchor` 并绑定同模型 Anchor；Flash 与 Vision 默认是 `bypass`，因为目前没有可信的内置模型原生 Anchor，必须先通过 WebUI 的 Anchor Builder 为「精确模型」生成并绑定 Anchor 后，才能切换到 `anchor` 模式。
4. 在外部 Harness 中选择 OpenAI-compatible Provider。
5. 把 Base URL 改为对应的本地数据地址：Pro 使用 `http://127.0.0.1:8643/v1`，Flash 使用 `http://127.0.0.1:8644/v1`，Vision 使用 `http://127.0.0.1:8645/v1`。
6. Model 保持为 `deepseek-v4-pro`、`deepseek-v4-flash` 或 `deepseek-v4-flash-vision-exp`。

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
       ├─ 前置回放 Minimal 思维链
       ├─ 接回当前 Harness 指令、会话和工具
       └─ 使用 Gateway Key 请求上游
                 │
                 ▼
       DeepSeek 官方 / OpenCode Go
```

### 1. Anchor 是结构化历史，不是单句提示词

每个 Anchor 都是带 SHA-256 指纹的不可变 Artifact，包含已完成的 Minimal 风格推理片段、`bash → str_replace_editor` 工具调用及其固定结果。它们作为历史消息被回放，不会在用户机器上重新执行其中的命令，也不会把 Anchor 使用过的 bootstrap 工具强行加入当前 Harness 的工具目录。

三个官方模型各有一个可信的内置模型原生 Artifact：

- `anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json`（「DeepSeek V4 Pro 默认 Anchor」）
- `anchors/deepseek-v4-flash-open-workstream-20260824101819-8a8a3211.json`（「DeepSeek V4 Flash 默认 Anchor」）
- `anchors/deepseek-v4-flash-vision-exp-open-workstream-20260824102129-7cdd27aa.json`（「DeepSeek V4 Flash Vision 默认 Anchor」）

仓库中不再提供把 Pro 轨迹复制过去的 Flash baseline——被复制过来的轨迹不是该模型原生的生成结果，不能作为可信默认。Anchor catalog 与加载器都会显式排除或拒绝 `copiedBaseline` 标记的 Artifact。Builder 目标模型旁的「查看该模型示例 Anchor」按钮只从 catalog 取**该模型自己的 default**；没有 default 时禁用并显示「尚无模型原生示例」，不会退回 Pro 或实验控制项。

真实默认生成流程：用 Builder/canonical preset 为精确模型生成候选（仅该模型自己的上游与 Key），按协议合格门槛挑选后以 `activate: false` 保存，随后在 manifest 中登记为 `default` 角色、产品可见/可选，完成回归后再显式绑定并把该模型的默认路径/模式切到新 Artifact；任意一环失败即恢复 `bypass + 空 anchorPath`，保留 Artifact 供检查，不冒充已启用默认。

命名规则：`displayName` 是唯一的展示名（NFC + trim 后 1–80 字符，同模型下不得重名，保存后不可原地重命名）；机器 id/path 由服务端生成（模型 + 时间 + UUID，`wx` create-only），用户名称不进入 path。

Gateway 会校验 Artifact 指纹和模型归属，避免跨模型误用 Anchor，或把已被手工篡改的文件静默加载。

### 2. Anchor 放在当前 Harness 上下文之前

对 `/chat/completions` 请求，Gateway 会把 Anchor 历史放到消息前缀，然后加入连续工作提示，再接回当前 Harness 的 system/developer 指令和原会话。当前请求的 `model`、`tools`、采样参数和流式设置保持不变。

这样做的目标是回放用户亲自挑选的思维链样本，再让模型处理真实 Harness 的任务和工具，而不是让 Gateway 替代 Harness 本身。Gateway 不会为生成候选私自追加 `We need` / `Let's` 引导词；这些关键字只统计自然输出。

### 3. 固定前缀与缓存

Anchor 是稳定前缀，连续使用同一模型、同一 Artifact 和相近请求结构时，有机会获得较高的 Provider 前缀缓存命中率。WebUI 会同时显示单条请求和已保存请求的 token 加权缓存命中率。

切换以下任一内容都可能改变请求前缀并降低缓存命中：

- `anchor` / `bypass` 模式；
- Pro / Flash / Vision 或上游 Provider；
- Anchor Artifact；
- 微锚点的正文、所选项或开关；
- Harness 的 system/developer 指令；
- 当前工具 schema 或工具顺序。

因此不要为了短期观察频繁切换 Anchor。需要比较方案时，最好在独立会话中测试，并把缓存变化与思维链变化分开看。

### 4. Gateway 持有上游凭据

外部 Harness 的凭据不会决定上游路由，也不会被转发。Pro、Flash、Vision 分别使用自己的 Gateway Key；页面只返回前后片段组成的脱敏预览，不返回明文。未配置 Key 时，数据端口会在本地返回 `503 gateway_upstream_api_key_not_configured`，不会向上游发请求。

## WebUI

管理页面可以：

- 独立启停 Pro/Flash/Vision，并配置端口、上游、Key、模式和 Anchor；
- 查看管理父进程及三个模型子进程的状态；
- 查看每次请求的基础信息（Input/Output tokens、缓存命中、命中率、工具次数）、状态与中断原因；流式请求会自动注入 `stream_options.include_usage`，确保上游回传 usage 与缓存数据；
- 查看推理（锚点外本次回复）与 Anchor 历史的思维链关键字与判定，并可打开弹窗查看本轮完整消息原文；
- 显示推理开头四个英文词或四个中文字；
- 创建模型专属 Anchor：生成时流式显示当前推理/正文并可点开看实时输出，可选择思考强度（默认 `max`）和可选 continuation；完成后预览自然关键字、两个工具状态及完整对话，由用户挑选后再保存；
- 独立管理微锚点：固定缓存警告、内置/自定义定义列表（默认项只读，可复制为自定义）、新建/编辑/删除、以及 Pro/Flash/Vision 各自的启用开关、保存项、生效指纹与应用状态；
- 在二次确认后清理已保存请求和轮转日志。

WebUI 默认不展示完整提示词；但为了让“查看本轮完整消息”可用，本机会在诊断记录里保存请求消息与回复的推理/正文原文（单条文本超过 64K 字符会截断并标注）。思维链判定中的“无明显倾向”表示没有命中任一思维链特征，不代表回答含糊或质量较低。

WebUI 保存的覆盖配置位于本机 `gateway.config.json`，该文件已被 Git 忽略。Key 输入框留空会保留原值；只有勾选“清除现有 Key”才会删除。

如果 WebUI 监听在非 loopback 地址，必须设置 `GATEWAY_MANAGEMENT_TOKEN`。浏览器只把管理令牌保存在当前标签页的 `sessionStorage`。

## Anchor 管理

内置 Anchor 是只读、版本化的 Artifact。WebUI 的 Anchor Builder 允许用户选择 Pro、Flash 或 Vision（只能为精确匹配的模型生成），并自行填写锚定提示词。Builder 会：

1. 使用所选模型自己的上游地址和 Gateway Key 生成候选，生成过程中任务卡片流式显示当前推理与正文；
2. 用固定内存仓库返回工具结果，不执行模型生成的命令；
3. 继续生成到 assistant 最终答复，确保 Anchor 是完整对话；任务卡片只展示两个工具是否调用、思维链类型和自然关键字统计，不显示“合格/不合格”；
4. continuation 可选（留空或自定义），作为 Artifact 中保存的桥接指令，与当前 Harness 说明合并后接在完整 Anchor 对话之后；
5. 由用户挑选候选后才用 create-only 语义保存 Artifact，拒绝覆盖同名文件；
6. 保存后绑定到对应模型并热应用，也可以废弃本次生成。

生成 Anchor 会产生真实上游调用和 token 费用。命令行 dry run 不发送付费请求：

```text
npm run anchor:dry-run
```

检查现有 Artifact：

```text
npm run anchor:inspect
```

更多 Artifact 规则见 [`anchors/README.md`](anchors/README.md)。

## 微锚点管理

微锚点是与 Full Anchor 相互独立的每轮短文本：开启后，Gateway 会把所选定义追加到**每条第三方 Harness 提交的 user 消息末尾**（字符串为 `Uᵢ + “\n\n<M>”`；多模态 content 数组保留原 part 并在末尾追加一条文本 part），再交给 Full Anchor 组合或直接转发上游。三个模型分别配置启用开关与保存项；默认全部启用内置「默认微锚点」。

- 内置默认项固定只读：既不能编辑也不能删除，只可「复制为自定义」后编辑（服务端读取默认正文，浏览器不提交正文副本）；
- 自定义项可新建/编辑/删除，名称 1–80 字符且全局唯一，正文最多 4000 字符；被任一模型选中的自定义项禁止删除（界面会列出引用它的具体模型，请先切换）；
- 不存在 revision/version；内容指纹每次从规范化后的实际正文计算；
- split/all 模式下保存后热应用受影响数据面；single 模式显示「已保存，重启后生效」；
- Gateway 无状态、不保存聊天：追加基于 Harness 回传的完整原始历史，请让 Harness 每次都提交完整且一致的未注入历史。

缓存影响遵循固定文案（WebUI 中总是显示）：

> 修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。Gateway 不会清除 Provider 侧缓存；恢复到此前的微锚点状态后，如果其他请求输入也一致，Provider 仍可能复用此前缓存。

当新旧状态的有效文本字节完全相同时（例如切换到正文相同的另一保存项），切换不改变上游历史，也不会提示缓存失效。当前实现细节见 [`docs/micro-anchor.md`](docs/micro-anchor.md)。

## 诊断与日志

为支持 WebUI 的“查看本轮完整消息”，`metadata` 会保存经过 64K 字符上限处理的请求/回复消息；图像 data URI 等超大结构会截断。`full` 模式才额外保存完整传输 body。split 模式的日志分别位于：

```text
results/gateway/pro/
results/gateway/flash/
results/gateway/vision/
results/gateway/combined/   # all 模式
```

日志默认每个文件 64 MiB，最多保留 5 份，并可从 WebUI 手动清理。切换到 `full` 会额外保存完整传输 body（可能包含代码、图像和工具结果），只应在可信本机环境中短期调试。

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
GATEWAY_COMBINED_PORT=8646

GATEWAY_PRO_ENABLED=true
GATEWAY_PRO_PORT=8643
GATEWAY_PRO_UPSTREAM_BASE_URL=https://api.deepseek.com
GATEWAY_PRO_UPSTREAM_API_KEY=
GATEWAY_PRO_ENHANCEMENT_MODE=anchor
GATEWAY_PRO_ANCHOR_PATH=anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json

GATEWAY_FLASH_ENABLED=true
GATEWAY_FLASH_PORT=8644
GATEWAY_FLASH_UPSTREAM_BASE_URL=https://api.deepseek.com
GATEWAY_FLASH_UPSTREAM_API_KEY=
# Flash has no trusted built-in model-native Anchor yet: keep bypass until an
# artifact is generated in the WebUI for deepseek-v4-flash and bound here.
GATEWAY_FLASH_ENHANCEMENT_MODE=bypass
GATEWAY_FLASH_ANCHOR_PATH=

GATEWAY_VISION_ENABLED=true
GATEWAY_VISION_PORT=8645
GATEWAY_VISION_UPSTREAM_BASE_URL=https://api.deepseek.com
GATEWAY_VISION_UPSTREAM_API_KEY=
# Vision (experimental) has no trusted built-in model-native Anchor yet either.
GATEWAY_VISION_ENHANCEMENT_MODE=bypass
GATEWAY_VISION_ANCHOR_PATH=
```

WebUI 中保存的值优先于 `.env` 中对应的 Profile 配置。各模型的 Key 只读自己的字段，不会回退到 `GATEWAY_UPSTREAM_API_KEY`。
部署方式保存在 `gateway.config.json` 的 `deployment` 节点；改 Key/上游/增强模式/Anchor/微锚可在 `single` 进程内热换该模型 plane，但 `split` / `single` / `all` 切换必须整体重启。

## 协议边界

当前 Anchor 变换只应用于 OpenAI-compatible `POST /chat/completions`。多模型路由口的 `GET /v1/models` 由本机返回已启用模型；其它非 Chat 路径若 JSON 顶层带官方 `model`，则按该模型 plane 透明转发（标记为 `bypass-unsupported-path`，不注入 Anchor）；没有 `model` 则返回 `gateway_model_required`。split 单模型口仍可转发无 `model` 的非 Chat 请求。因此，外部 Harness 必须实际使用 Chat Completions 数据面，不能仅因为 Provider 自称兼容 Responses 或 Anthropic Messages 就假定 Anchor 已注入。

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
- [modeltest](https://github.com/xiaobright/modeltest)：公开的轨迹观测、Minimal/Standard 对照和统计方法。

这些项目与 DeepSeek Boost Gateway 相互独立。本仓库的 Anchor 回放、跨 Harness Gateway、凭据隔离和 WebUI 管理均为本项目自己的实现；外部项目的实验结论也不应被解释为本项目对所有模型和任务的效果保证。

协议来源与实现边界的进一步记录见 [`docs/protocol-sources.md`](docs/protocol-sources.md) 和 [`docs/architecture.md`](docs/architecture.md)。早期实验报告保留在 `docs/` 中供复查，但不再作为 README 的主要使用说明。
