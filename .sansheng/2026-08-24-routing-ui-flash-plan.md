# 单端口路由 / 请求详情 / Flash 默认 · 落地 plan（乙）

## 授权与节奏

- 用户已按乙一次授权。按 A→B→C→D 执行，块间不询问。
- 复核已审 C：方向成立，若干契约需主判断拍板后才能施工（见文末「C 裁决」）。
- 升级 / 方案分裂 / 范围扩大 / 重大风险仍暂停上报。
- 阵容：主判断 + 复核 + 强执行 + 弱执行。

## 配置档

难度高 + 复杂度高 → 主判断 + 复核 + 强执行 + 弱执行。

测试：A/B = T2；C = T3；D = T4 + 真实上游（用户已点名真实做）。用户未点名跑测试前，执行块不擅自跑全量。授权执行后：A/B 由执行智能体按 T2 自跑；C 按主判断测试方案跑；D 的真实上游只在 C 验收通过后由主判断放行。

上报：方案要改、清理仍 404、路由把 Key/模式串模型、真实候选整批不合格 → 停，不硬闯。

---

## A. 清理 404 + 原文

### 原因

当前 `gateway.config.json` 是 `single`。WebUI 打在数据面。

- `DELETE /__gateway/diagnostics` 只在 `management-server.mjs`（split/all）
- `proxy.mjs` 只有 GET，没有 DELETE → HTTP 404
- `server.gatewayClearDiagnostics` 已实现（清内存 + traffic/activity jsonl），single 未接到 HTTP
- 旧 traffic 无 `rawMessages`；失败请求的 `failureExchange.request` 也不写。清掉旧数据后只留新请求，才能验证原文。

### 改

文件：

- `src/gateway/proxy.mjs`
  - `managementEnabled` 时实现 `DELETE /__gateway/diagnostics`：确认词 `清空全部请求`、mutation header 与 `management-server.mjs` 一致，调用已有 `gatewayClearDiagnostics`。
  - 三处 `failureExchange`（无 Key / 模型不允许 / transform 失败）：能 parse 出 Chat `messages` 时写入 `request.rawMessages`（走现有 `capRawMessages`）。
- `src/gateway/server.mjs` single 分支：不必另写清理函数；HTTP 路由直接调 server 上已有实现即可。
- `src/gateway/management-server.mjs`：split 下 IPC 发送失败必须打日志，不得静默丢条目。若体积导致发送失败，列表可只带 `messages.currentInput` + 条数，详情走 `GET /__gateway/diagnostics/:id`（管理面若还没有转发，补一条到对应数据面）。
- `src/gateway/web/app.js`：`hasMessages` 改为 request/response **至少一侧为非空数组**；空数组不当作可查看。

### 不改

- 不改确认词「清空全部请求」
- 不在清理时碰 Anchor / 配置 / Key
- 不改 A 块的路由/plane

### 验收

- single 下点清理：200，列表空，traffic/activity jsonl 空
- split/all 原清理路径不回归
- 新的成功 Chat 请求详情出现「查看本次消息」
- 新的失败 Chat 请求（能量出 messages 时）也能打开本次输入

### 分片

弱执行整包。上报：清理后文件还在 / 管理面 GET-by-id 转发不清。

### 测试（T2）

- 扩 `test/gateway.test.mjs` 或现有 proxy 测试：single 风格 listener 上 DELETE diagnostics → 200 且后续 GET 为空。
- 失败请求带 rawMessages 的单测（构造无 Key 或 transform 失败）。

---

## B. 请求详情与文案

### 改

文件以 `src/gateway/web/app.js` + `app.css` + `index.html` 为主；开头节选改 `src/gateway/trajectory-stats.mjs`（生成侧与展示侧同一函数）。

**锚点外推理**只留：推理 tokens、推理块、开头节选、思维链类型、命中关键字。

- 关键字 = 生成侧同一套 v3 八项；只渲染 count>0
- 开头节选：第一句（分隔符 `。．.！!？?`）；无句号则截 40 个字符（中英都按码点，不再四字/四词）
- 工具序列从该块挪到基础信息；基础信息保留次数 + 序列

**锚点块**与「锚点外推理」同字段，另加工具调用历史。

**每条对话消息**：有正文/思维链/工具参数则加「查看完整消息」（对付 200 字参数截断和 64k 截断）。请求级按钮保留，条件改为「有非空原文」（A 已改 hasMessages）。

**纯工具调用**：`currentInput` 全是 `tool`、没有 `user`。列表醒目标记；筛选增加「纯工具调用 / 非纯工具调用」（与状态筛选并列）。

**锚点卡片**：副行只留模型名，去掉机器 id。路径行保留。

**问号**：`.candidate-dialog-body` / `.anchor-dialog-body` / `.detail-panel` 的 `overflow-y: auto` 不得裁切 tooltip。优先标题区 `overflow: visible` + tooltip 向上展开；父级仍裁切则 hover/focus 把 tooltip 挂到 `document.body`。

**文案**：

- 「类型」→「来源」：内置默认示例 / 用户生成 / 实验控制项
- 「旧格式（非助手答复收尾）」→「未以助手答复收尾」；说明：按现在的保存规则最后一条应是助手答复；这份是更早存的，最后一条不是。不补造 assistant。
- 部署文案见 C.8（B 可先改展示文案，语义以 C 为准）。

### 不改

- 不改 token 统计口径
- 不改 v3 判定规则，只改展示与 `openingPreview` 截取
- 不改 Pro Artifact

### 验收

- 未命中关键字不占格子
- 节选能到一句或 40 字
- 纯工具调用能筛
- 问号全文可见
- 卡片副行无文件名

### 分片

弱执行整包。主判断过目文案。

### 测试（T2）

- 改 `test/trajectory-stats.test.mjs`：`openingPreview` 改为第一句 / 40 字。
- 改 `test/anchor-jobs.test.mjs` 里依赖四词预览的断言。
- UI 无浏览器单测则不硬造；文案/筛选用现有 html 字符串断言（`test/gateway.test.mjs` 已有页面包含检查）。

---

## C. 单端口 / 全开启 = 按模型路由

### 正确拓扑

| 模式 | 监听 | 每条请求 |
|---|---|---|
| split | 三端口，各一模型 | 只用该端口模型的配置 |
| single | 一个多模型口 | 按 `request.model` 选该模型配置 |
| all | 一个多模型口 + 三个单模型口 | 多模型口同 single；单模型口同 split |

多模型口不是合并逻辑面。禁止再写「共享上游和 Key」。

### 现状错误

- `applyManagedConfig` 在 single 强制 `GATEWAY_ENHANCEMENT_MODE=bypass`、三模型塞进一个共享面
- `singleProfile` / `gatewayCombinedProfile` 共用一把 Key、一个上游、一个 `defaultMode`
- `splitProfile` 还把缺的 Key/上游回退到全局 `GATEWAY_UPSTREAM_*`（会再次串模型）
- `proxy` `GET /__gateway/config` 写死 `profiles: []`
- `proxy` 没有 `PATCH /__gateway/config/profiles/:name`、没有 Anchor jobs 路由（只在 management-server）
- single 未创建 `AnchorJobManager`，也未接 `activateAnchor`
- 请求路径已按模型选 Anchor/微锚，但 Key / 上游 / `defaultMode` 仍是进程级一份；无 Key 检查发生在 parse model 之前
- `loadProfileAnchors` 用进程级 `defaultMode` 决定要不要加载各模型 Anchor

### 契约（执行不得改这些选择）

1. **plane**（内存，不落盘）每官方模型一份：
   `{ name, model, enabled, upstreamBaseUrl, gatewayApiKey, gatewayApiKeySource, defaultMode, anchors, microAnchors }`
   来源：managed 的 pro/flash/vision，互不覆盖。

2. **plane 的 Key/上游只读该模型自己的 prefix**（`GATEWAY_PRO_*` / `GATEWAY_FLASH_*` / `GATEWAY_VISION_*`，由 `applyManagedConfig` 从 document.profiles.* 写出）。禁止用 `GATEWAY_UPSTREAM_API_KEY` / `GATEWAY_UPSTREAM_BASE_URL` 回填其它模型。缺 Key → 该模型 `apiKeySource:'none'`，进程仍可启动；该模型请求 503。缺上游 → 代码默认 `https://api.deepseek.com`。

3. **singleProfile / gatewayCombinedProfile** 只表示「一个端口 + 三份 plane」。不再带共享 `gatewayApiKey` / `upstreamBaseUrl` / `defaultMode`。`name` 仍为 `single` / `combined`（监听身份）。`models` = 三个官方名。

4. **split 进程**继续一模型一面，不走 plane 表；行为与现在一致，但 Key 回退规则按第 2 条改掉（三端口也不再偷全局 Key）。

5. **Chat Completions**：parse body → 用 `payload.model` 取 plane。没有该模型 → 现有 400；该模型 `enabled===false` → 400，文案写明未启用。用该 plane 的 Key、上游、增强模式、Anchor、微锚。`X-DeepSeek-Boost-Mode` 仍可覆盖这一次。无 Key 检查必须在选中 plane 之后。

6. **多模型口的非 Chat Completions**：400 `gateway_model_required`（没有 model 就不能选 plane）。split 单模型口保持现状（可转发非 chat）。

7. **`applyManagedConfig`**：删除 single 强制 `GATEWAY_ENHANCEMENT_MODE=bypass`。single 仍可写 `GATEWAY_MODELS=三模型`（只表示监听接受的模型列表）。

8. **热更新**：`updateProfile(name, patch)` 存盘后只替换该模型 plane 快照；其它模型进行中的请求继续用旧快照。改 host/port/deployment.mode 才 `restartRequired:true`。改 Key/上游/enhancementMode/anchorPath/微锚 → 进程内换 plane，`restartRequired:false`。

9. **Config API（single 数据面必须与管理面齐）**：
   - `GET /__gateway/config` 返回 `managedProfileViews` 三项，禁止 `profiles: []`
   - `PATCH /__gateway/config/profiles/(pro|flash|vision)` 鉴权/mutation header 与管理面一致
   - Anchor jobs 全套路由挂上（list/start/get/select/activate/cancel），否则 D 无法在 single 生成
   - 不要为 single 另开管理端口

10. **`AnchorJobManager`（single）**：`getProfile(name)` 返回该模型自己的 secret profile（`managedProfileSecrets` 里那一项），`models[0]` 即该模型。`activateAnchor` 更新该模型 plane + 持久化 `anchorPath`/`enhancementMode`，不得写进共享面。

11. **`loadProfileAnchors`**：按 **plane.defaultMode** 决定是否加载该模型 Anchor；禁止用 listener 的单一 defaultMode 要求三个模型都有 Anchor。copiedBaseline 仍拒绝。

12. **UI**：部署说明改成上表；「合并数据端口」→「多模型路由端口」；删掉「合并数据面使用共享上游和 Key」。`MICRO_PROFILE_LABELS.combined/single` 改为「多模型路由口」。微锚保存后若已热应用，toast 显示已应用，不要「重启后生效」。

13. **路由抽取**：proxy 与 management-server 重复的管理路由若超过约 80 行，可抽 `management-routes.mjs`；抽完两个入口行为必须一致。不抽也可以，但必须补齐第 9 条，禁止只改 GET 文案不补 PATCH/jobs。

### 不改

- 三模型官方名、端口默认值 8643/8644/8645、all 的路由口默认 8646
- split 一端口一模型的进程模型
- 不改用户已保存的各模型 Key/上游字段（只改生效方式与禁止回退）
- 不改 Artifact 格式；不把 modelPlanes 写入 `gateway.config.json`

### 验收

- single：同一端口，Pro 走 Pro 的 mode+Key+上游，Flash 走 Flash 的；改 Flash 上游不影响进行中的 Pro 请求
- all：8646 同上；8643 只收 Pro
- Builder 目标配置三项，缺 Key 的项 disabled 并写「缺少 Key」，不是空白 select
- `managed-config` 不再断言 single 强制 bypass
- 单测钉死：Flash 请求用 Flash Key（可用 fake key 断言 Authorization），不是 Pro Key

### 分片

- 强执行：plane 契约、`runtime-config`/`managed-config`、`proxy` 按模型选 Key/上游/模式、`loadProfileAnchors`、single/combined 组装、热更新快照、jobs/PATCH 挂载骨架
- 弱执行：UI 文案、config GET 填充、测试填充
- 复核：审「不是合并面」是否被测试钉死

### 强理由（强执行写骨架）

Key/上游/模式若与 Anchor 拆开选，会在同一请求上串模型。难点与骨架不可拆。

### 测试（T3，主判断方案）

必须覆盖：

1. `applyManagedConfig`：single 不写强制 bypass；三模型各自 `GATEWAY_*_ENHANCEMENT_MODE` 保留 document 值。
2. `splitProfile` / plane 组装：只设 `GATEWAY_PRO_UPSTREAM_API_KEY` 时，flash/vision 的 key 为空，不回退到全局。
3. proxy 多模型口：同一 server，Pro 请求 Authorization=Pro key、Flash 请求 Authorization=Flash key（mock 上游）。
4. 未启用模型 → 400；未知模型 → 400；该模型无 Key → 503 且不影响另一模型有 Key 的请求。
5. 非 chat 路径在多模型口 → 400 `gateway_model_required`。
6. `GET /__gateway/config` 在 single 风格 listener 上 `profiles.length===3`。
7. `updateProfile('flash', { upstreamBaseUrl })` 后 Flash 新请求走新上游，Pro 不变；`restartRequired===false`。
8. all 的 combined listener 与 split 单模型口行为对照（可沿用 `test/deployment-server.test.mjs` / `test/gateway.test.mjs`）。

强执行对方案有执行前反馈权；有问题先报主判断，不擅自改契约。

### 上报条件

- 热更新必须重启才能换 Key（先报，不要偷偷改成整进程重启当完成）
- 抽共享 router 导致 split 管理面回归
- 发现非 chat 客户端依赖 single 转发（范围扩大，先报）

---

## D. 两个 Flash 真实默认

依赖 C（当前 single 下 Builder 目标配置为空且无 Job 管理器）。

### 额度

与既有 E 块相同，不扩大：

- 每模型一批：`preset: canonical-default`，`runs=3`，`maxSubturns=6`，`reasoningEffort=max`，`maxTokens=384000`，中性 continuation
- 先 Flash，合格再 Flash Vision
- 整批不合格 → 停，不追加付费批次
- 复用 Pro bootstrap 的 task/tools/固定工具结果；不复制 reasoning / assistant / tool call id

### 保存

- 显示名：`DeepSeek V4 Flash 默认 Anchor` / `DeepSeek V4 Flash Vision 默认 Anchor`
- `activate:false` 先落盘 → 写 manifest（default、产品可见）→ 测试过后再 activate
- canary 最多各 1 次短请求；失败则该模型保持 bypass + 空 path，Artifact 留着不冒充已启用

### 挑选规则（主判断执行，弱执行不得自行改规则）

协议全部合格 → reasoning 字符量降序 → candidateIndex 升序。主判断读三个完整候选后确认。

### 不改

- 不改 `anchors/dsh-minimal-open-workstream-pro.json`
- 不改 `anchors/dsh-minimal-two-tool-v1.json`
- 不恢复已删的 copied Flash baseline 路径
- Key 不进仓库、不进 `.sansheng/`、不进汇报

### 分片

主判断放行真实调用并挑候选。强执行验收门槛。弱执行登记/文档。复核看 manifest 与「非复制」。

### 测试（T4）

- 产物 reload、模型归属、copiedBaseline=false、指纹、最终 assistant（v2）
- catalog 产品列表出现两项 default，Builder 示例按钮对 Flash/Vision 可用
- 不改 Pro 指纹

---

## C 裁决（复核后，主判断拍板）

方向不变。执行按下列修正，不再按原文过严条款施工。

1. **请求原子快照**：parse 出 model 后只取一次 `planeSnapshot`，此后 URL / Authorization / mode / Anchor / 微锚 / 诊断只读该对象。禁止先用 listener 级 Key 再改。
2. **热更新**：single 进程内必须 `replacePlane`（先构建并校验候选 plane → 原子存盘 → 内存交换）。all 的 combined 在子进程：本轮不承诺不中断 Pro；改任一模型 plane 可 `restartRequired` 重建 combined。不要为 all 现写 IPC 热换。
3. **全局 Key 回填**：managed 各 profile 自有字段优先。该模型自有 Key 为空时不把 `GATEWAY_UPSTREAM_API_KEY` 填给它。缺 Key = 该模型 503，进程可起。缺上游用代码默认 `https://api.deepseek.com`。启动若检测到「多模型 + 仅有全局 Key」打警告，不静默三模型共用。改 `.env.example` / README 里「8646 共享 Key」的旧句。
4. **非 Chat**：`GET /v1/models` 本地返回已启用模型，不 400。其它路径若 JSON 顶层有官方 model，按该 plane 透明转发。无 model 才 `gateway_model_required`。
5. **管理路由**：`PATCH /__gateway/config/profiles/:name` 已在 proxy，不要重写。jobs 复用现有路径与 `discard`（没有 cancel）。缺的是 GET config 的 `profiles`、jobs 挂到 single、`AnchorJobManager`。超过 80 行抽 `management-routes.mjs`。
6. **健康视图**：single `/health` 不得再用单一 `upstreamBaseUrl`/`mode` 代表三模型。聚合：`gatewayApiKeyConfigured` / `allGatewayApiKeysConfigured` / count；每 plane 安全视图。`managedProfileViews` 在 single 要带 running。
7. **加载 Anchor**：有 path 就加载（支持 Header 切到 anchor）。无 path + 默认 anchor 才启动失败。无 path + bypass 可起。disabled / 无 Key 的 plane 不阻止 listener 启动。
8. **激活**：必须同时写 `anchorPath` 与 `enhancementMode:'anchor'`。改 Flash 不得使 Pro job 的 `configGeneration` 失效。
9. **测试**：同一请求同时断言上游 host、Authorization、mode/是否注入 Anchor、微锚。禁止只测 Key。

上报：热更新做不到 replacePlane（single）→ 停；发现非 chat 客户端必须走无 model 的自定义路径且不能本地处理 → 停。

---

## 本轮明确不做

- 不把 single 改回必须分端口
- 不实现 Responses / Anthropic
- 不在 A/B 块顺手改路由
- 不把 API Key 写入仓库或过程文档
- 不为 all combined 本轮做 IPC 热换
