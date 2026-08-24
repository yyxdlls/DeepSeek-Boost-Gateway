# Anchor / 微锚点 / 模型默认值施工级落地 Plan（乙方案）

## 1. 授权状态与施工节奏

- 当前仅完成计划，不修改项目文件、不运行测试、不启动服务、不调用真实上游。
- 用户已选择乙：本文件与配套测试方案一次性交付；用户审阅后只需一次明确 Edit 授权，A–F 按依赖顺序连续施工。
- 真实 Flash / Flash Vision 生成属于 E 块，会产生上游调用与费用。乙方案仍只需一次授权，但该授权必须明确包含“真实 Flash / Flash Vision 接口生成及本文件限定额度”；不能靠未排除而默认为授权。真实调用只由主判断在本地门禁全绿后放行，弱执行不得启动。
- 任何上报条件触发时暂停，不擅自扩大调用次数、改变模型、复制其他模型输出或修改范围。

## 2. 当前工作树基线与保护边界

当前工作树已有大量未提交成果：24 个已跟踪文件有改动，多个测试和 `src/lab/assistant-stream.mjs` 未跟踪，旧 copied Flash baseline 已删除。施工必须基于工作树现状，不按 HEAD 重做。

### 2.1 强制保护

- 禁止 `git checkout/reset/stash`，禁止整文件覆盖、无关格式化或恢复删除的 `anchors/dsh-minimal-open-workstream-flash.json`。
- 修改脏文件前重新读取并使用窄 hunk；保留现有流式 Builder、最终 assistant、reasoning effort、Vision profile、部署拓扑、诊断和测试改动。
- 不修改旧 Artifact 内容：
  - `anchors/dsh-minimal-open-workstream-pro.json`
  - `anchors/dsh-minimal-two-tool-v1.json`
- 不改历史实验报告：`docs/experiment-*.md`、`docs/anchor-candidate-2026-08-16.md`。
- 不把 API Key、真实候选集、真实响应正文、Authorization 或管理令牌写入仓库、测试 fixture 或汇报。
- 以下高冲突脏文件必须在分配执行前重新读取当前内容和相关断言：`src/lab/anchor-profile.mjs`、`src/lab/profile.mjs`、`src/lab/run-anchor-candidate.mjs`、`scripts/run-anchor-candidate.ps1`、`test/anchor-jobs.test.mjs`、`test/managed-config.test.mjs`、`test/anchor-catalog.test.mjs`、`test/gateway.test.mjs`、`test/runtime-config.test.mjs`、README、`anchors/README.md`、`docs/protocol-sources.md`。
- 测试迁移时明确把“load v1 / save v2”“普通 catalog 隐藏 control / content API 仍可读”作为增量修改；不得删除其余未提交断言。`classifier.mjs`、未跟踪 `assistant-stream.mjs` 和旧 Artifact 不因本轮顺手调整。
- 根目录 v0.2 是原始设计输入；其“默认微锚可编辑”等旧句已被用户本轮纠正和本施工 plan 覆盖。施工期间以本文件为实现事实源，不回头采用被否决语义。

### 2.2 本轮明确不做

- 不实现 Responses / Anthropic 微锚适配；第一版只处理 OpenAI Chat Completions。
- 不保存每轮聊天历史、旧微锚版本或隐式会话状态。
- 不给微锚加入随机 cache-buster、时间戳或动态 revision 文本。
- 不把 10–15k token 作为本轮默认 Artifact 的自动门槛；本轮保持现有版本化双工具 open-workstream fixture 的跨模型可比性。长轨迹实验另立任务。
- 不把思维链关键字当作 Anchor 合格门槛；它们只供观察和候选间辅助比较。

## 3. 已拍板的跨块数据契约

### 3.1 新增模块

1. `src/gateway/micro-anchor.mjs`
   - 固定默认微锚、名称/正文校验、内容指纹、运行时快照、字符串/多模态 user content 追加、第三方历史重建。
2. `src/gateway/chat-request-transform.mjs`
   - Chat Completions 唯一增强编排入口；先重建第三方 user 历史，再按 `anchor/bypass` 组合 Full Anchor，合并诊断 metrics。
3. `src/gateway/anchor-manifest.mjs`
   - 声明内置 Artifact 的 `default/control` 角色、模型、路径、是否产品可见/可选和固定指纹；用户 Artifact 自动归类为 `user`。
4. `src/gateway/managed-mutation-coordinator.mjs`
   - split/all/single 共用的串行 managed-document mutation coordinator；统一 candidate document 校验、原子保存、configured/applied 状态和错误结构，禁止各 route 各写一套 read-modify-write。

不新增通用协议抽象层，不移动现有 token/trajectory 统计模块。

### 3.2 内置微锚

```text
id: builtin:initial-work-recall-v1
name: 默认微锚点
content: 回想你最开始的工作，那是很好的工作状态。以这样的状态完成接下来的工作。
readonly: true
deletable: false
```

- 产品 baseline：每个模型默认 `enabled=true`、选择该内置项。
- 内置项不写入可编辑定义库；API 合并后返回。
- 自定义项可以创建、编辑、保存、删除，也可从默认项复制；被任一模型选中时禁止删除。
- 不存在 revision/version；内容指纹每次从规范化后的实际正文计算。

### 3.3 Managed config v2

```json
{
  "schemaVersion": 2,
  "deployment": { "mode": "split", "combinedPort": 8646 },
  "microAnchors": {
    "definitions": {
      "ma_<uuid>": {
        "name": "故障排查",
        "content": "修复问题时先定位原因，再决定修改。",
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601"
      }
    }
  },
  "profiles": {
    "pro": {
      "microAnchor": {
        "enabled": true,
        "selectedId": "builtin:initial-work-recall-v1"
      }
    }
  }
}
```

- `loadManagedConfig()` 接受 v1/v2，v1 在内存迁移为 v2；原样保留 deployment、profiles、Key 和已有字段。
- v1 未配置微锚的模型解析为 baseline 默认值；下一次成功保存时才以 v2 原子落盘。
- `saveManagedConfig()` 改为同目录临时文件写入后原子替换；失败时保留旧文件。
- 自定义名称：NFC + trim 后 1–80 字符，全局规范化名称唯一，拒绝控制字符和双向覆盖字符；存储合法原文，前端统一 escape，不写 HTML entity。
- 自定义正文：CRLF 规范化为 LF，`trim()` 后不得为空，最多 4000 字符；保留其余用户空格与换行。
- 微锚定义和正文不进入 `process.env`，不扩展 `ENV_FIELDS`；运行时快照只从 managed document 与内置默认解析。

### 3.4 微锚管理 API

- `GET /__gateway/micro-anchors`
  - 返回默认+自定义定义、内容指纹、引用模型、各模型 `enabled/selectedId/effectiveFingerprint` 和固定缓存警告文案。
- `POST /__gateway/micro-anchors`
  - `{ name, content }` 或 `{ name, copyFromId }`；复制默认时服务端读取默认正文，不信任浏览器正文副本。
- `PATCH /__gateway/micro-anchors/:id`
  - `{ name?, content? }`；内置项返回 409。
- `DELETE /__gateway/micro-anchors/:id`
  - 内置项或被引用项返回 409，并返回引用模型；不静默回落默认。
- 既有 `PATCH /__gateway/config/profiles/:profile`
  - 扩展 `{ microAnchor: { enabled, selectedId } }`。
- 所有写操作继续要求同源 JSON mutation marker；错误保持结构化 type/message/status。
- split/all management server 与 single proxy 使用同一 callback 契约：`microAnchorView/create/update/delete/updateProfileSelection`。Mutation 统一返回 `{ documentView, affectedProfiles, effectiveChanged, restartRequired, pendingRestart }`，或抛出带 `statusCode/type` 的结构化错误。

### 3.5 第三方 user 历史重建

输入契约：Harness 每次提交未被 Gateway 注入的结构化历史。Gateway 自身不保存聊天；双 Gateway 串联或回传已变换历史不属于透明输入契约。

```text
原始第三方 messages
  → 克隆并保留第三方来源
  → 若微锚开启，只处理 role=user
  → 再交给 Full Anchor 组合
```

- 字符串：`${originalContent}\n\n${microAnchorText}`。
- content 数组：仅接受非空数组，且每个 part 都是非 null 普通对象并含非空字符串 `type`；允许保留未知但结构合法的 type。保留所有原 part 和顺序，在末尾追加 `{ "type": "text", "text": "\n\n<M>" }`；不 stringify、不改 image/data URI/detail，也不修改已有文本 part。空数组、裸字符串 part、数组 part、null 或缺失 type 的对象均拒绝。
- 空字符串按字符串规则处理，结果为 `"\n\n<M>"`。
- 其他 user content 类型：微锚开启时整单返回 `gateway_micro_anchor_unsupported_user_content`，不得部分跳过；关闭时保持透明转发。
- 每次无条件对第三方原始 user 追加一次，不用后缀猜测是否已经注入；用户正文恰好以 M 结尾时会再追加一次。
- Full Anchor bootstrap user、内部 harness bridge、continuation、system/developer/assistant/tool 均不处理。
- 最新消息为 assistant/tool 时只重建此前 user，不伪造新的 user。

四组合：

| 微锚 | Full 模式 | 上游消息 |
|---|---|---|
| 关 | bypass | 原始第三方历史 |
| 开 | bypass | 第三方所有 user 为 `Uᵢ + M` |
| 关 | anchor | Full trajectory → bridge → 第三方会话 |
| 开 | anchor | Full trajectory → bridge → 第三方会话，其中所有第三方 user 为 `Uᵢ + M` |

`x-deepseek-boost-mode: bypass` 只绕过 Full Anchor，不覆盖模型配置中的微锚开关。

### 3.6 微锚诊断

在现有 `transformation` 中合并：

```json
{
  "microAnchor": {
    "enabled": true,
    "id": "...",
    "source": "builtin",
    "contentFingerprint": "sha256",
    "applied": true,
    "appliedUserMessageCount": 3,
    "stringUserMessageCount": 2,
    "multipartUserMessageCount": 1,
    "reason": "applied"
  },
  "thirdPartyHistoryFingerprint": "sha256"
}
```

- 不保存微锚正文、图像内容或不存在的 revision。
- `thirdPartyHistoryFingerprint` 固定哈希“微锚变换后、交给 Full Anchor 前”的第三方 messages 规范 JSON；保留 message/part 顺序与合法字段，不含任何内部来源标记。
- 原始请求诊断继续显示 Harness 提交内容；上游摘要反映重建后内容；WebUI 以独立诊断块说明追加数量和指纹，不把隐藏微锚混进“本次原始消息”弹窗。

### 3.7 缓存文案

统一使用：

> 修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。Gateway 不会清除 Provider 侧缓存；恢复到此前的微锚点状态后，如果其他请求输入也一致，Provider 仍可能复用此前缓存。

- 两个 ID 的有效文本字节完全相同时，切换不改变上游历史，不提示“缓存已失效”。
- Gateway 不保存聊天，但缓存连续性要求 Harness 回传完整且一致的未注入历史；截断、摘要替换或只发最新轮时不承诺连续命中。

### 3.8 Anchor Artifact v2 与分类

- 新 Artifact 使用 `schemaVersion: 2`，新增必填 `displayName`；displayName 写入 core 后参与 Artifact fingerprint。
- v1 继续只读兼容，显示名回退 manifest displayName 或 Artifact id。
- 用户名称不参与机器 id/path；沿用服务端生成的模型+时间+UUID 安全 id，文件继续 `wx` create-only。
- Artifact displayName 复用微锚名称的字符规则：NFC + trim 后 1–80 字符，拒绝控制/bidi；大小写不折叠；同模型下规范化名称唯一。存储合法原文、UI `escapeHtml`、永不进入 path。候选选用时校验并占位，防止两个待选任务并发重名。
- 不提供保存后原地重命名。

Manifest 初始角色：

- `dsh-minimal-open-workstream-pro.json`：`default`、产品可见/可选、固定显示名“DeepSeek V4 Pro 默认 Anchor”、Pro 示例，固定现有指纹。
- `dsh-minimal-two-tool-v1.json`：`control`、产品隐藏/不可选、固定开发显示名、只供实验/测试/开发读取，固定现有指纹。
- 非 manifest 且通过验证的 Artifact：`user`、产品可见/可选。
- `copiedBaseline`：完全排除并拒绝运行时加载。

Catalog 分层：

- `scanAnchorArtifacts({ includeControls:true })`：安全扫描及 content 白名单。
- `listAnchorArtifacts()`：只返回 default/user 产品项，包含 `category/displayName`。
- content API 使用全量合法扫描，因此 control 隐藏后仍可供开发检查；普通 UI 没有 control 入口。

## 4. 分块施工图

## A. 请求列表、消息查看器、说明入口与 continuation

施工拆分：A 中缓存高亮、查看器和 help 可先独立完成；continuation 属于 **AB0 原子切片**，不得在 A 阶段单独落地或宣告完成。实际顺序固定为 `A1 独立 UI → AB0（B 强执行先落 Artifact v2/legacy 分流，弱执行随即接 continuation UI/jobs）→ B 其余项`。AB0 完成前禁止运行 Builder 或启动会接受空 continuation 的服务。

### A1. 文件与局部单元

- `src/gateway/web/app.js`
  - `renderRows()`：把 `缓存输入`、`命中率` 从普通 `io-detail` 拆成独立高亮 pill；未返回/0/有效命中三态。
  - `conversationBlock()`：保留共用入口，增加预计算的 tool-call-id → 消息序号映射；assistant 改名“模型消息”，内部分“思维链 / 正文 / 工具调用”；tool 显示“仅工具结果”及对应 call id。
  - candidate/request/Anchor 三个弹窗统一使用新渲染器和 role legend。
  - `renderAnchorView()`：各统计项和工具状态增加说明；旧 Artifact 不补造最终 assistant。
  - cat-n 结果仅当整段至少两行匹配 `^ *\d+\t` 时，才在展示层解析为紧凑行号列+正文列；否则保持原样 `<pre>`。不改原字符串、日志或 fingerprint。
- `src/gateway/web/index.html`
  - 锚定提示词、continuation、统计说明使用可 hover/focus 的 `button.help-icon` + `aria-describedby` tooltip，不只依赖 title。
  - **AB0**：在 B 的 v2 骨架已落地后，continuation 才改为可选并默认预填唯一中性句：
    `Let's continue working on the same long, interconnected software engineering problem.`
  - 三个对话弹窗加入统一 legend。
  - help tooltip 固定文案：
    - 锚定提示词：用于让目标模型在固定合成仓库中实际完成一次工具轨迹；通常填写希望模型完成的探测任务，例如“依次查看仓库结构和 WORKSTREAM.md，再给出简短收尾”。
    - continuation：Anchor 与当前 Harness 之间的可选桥接文本，会随 Artifact 保存并原样注入；通常填写中性的工作流延续句，也可留空。
    - 工具状态：仅表示生成轨迹中是否完成对应调用，不代表质量判定。
- `src/gateway/web/app.css`
  - 新增 cache pill 三态、help tooltip、conversation section、tool-call、cat-n 行号布局和键盘焦点样式。
- `src/lab/anchor-profile.mjs`
  - **AB0**：只窄改现有 continuation 常量为上述中性句；不触碰其他未提交逻辑。
- `src/gateway/anchor-jobs.mjs`
  - **AB0（归强执行 B 骨架所有）**：`continuationMessage` 允许 0–4000；`undefined` 使用中性默认，显式空字符串保持空。
- `src/gateway/anchor.mjs`
  - **AB0（归强执行 B 骨架所有）**：v2 Artifact 无 continuation 时不注入行为型 `ENVIRONMENT_SWITCH_MESSAGE`，只生成当前 Harness bridge；v1 无 continuation 仍走 legacy fallback，保护 control 兼容。

### A2. 验收

- 请求列表直接辨认缓存输入和命中率；无 usage 不伪造值。
- `#2` 明确为用户/引导请求；`#3/#5` 为模型消息并显示 reasoning + tool call；`#4/#6` 明确仅为工具结果。
- `1\t# Interconnected...` 不再出现夸张前导空白，存储内容和旧 Artifact 指纹不变。
- 新 Builder 默认不再包含 inspect-before-act、整合后续或不得虚构工具输出等行为约束；用户可留空或自定义。

## B. Anchor 命名、Manifest、保存生命周期与示例按钮

### B1. 后端

- **AB0 原子切片先行**：强执行先完成 v1/v2 validator 与 legacy continuation 分流；随后弱执行在同一切片接入中性常量、jobs 空值和 UI 可选字段；立即运行 v1 control/v2 empty targeted tests。AB0 全绿前不运行 Builder、不启动服务，不允许 A 单独验收 continuation。

- `src/gateway/anchor-manifest.mjs`：实现上述 default/control manifest 和固定指纹校验。
- `src/gateway/anchor.mjs`：统一 v1/v2 校验；manifest 项额外核对模型、路径、expected fingerprint；v2 要求 displayName 和完整最终 assistant（默认/用户新 Artifact）。
- `src/gateway/anchor-catalog.mjs`：实现 scan/product list/content 白名单分层；返回 `category/displayName/selectable`。
- `src/gateway/anchor-jobs.mjs`
  - `select(jobId, { candidate, displayName, activate:true })`；名称在保存时提交。
  - `select()`在第一次 await 前把 Job 从 `awaiting-selection`原子切到 `reserving-name`；catalog 校验后以 `(model, normalizedDisplayName)`占位，保存前二次检查。保存失败且文件不存在时释放；保存成功后由 catalog 永久承担唯一性。
  - 生成阶段只保存 `candidateSetId/resultsPath`；最终机器 id/path/displayName 在 select 占位成功后生成。from-results 必须把最终 id 写入 Artifact，并复核 Artifact id、文件名和 Job identity 一致。
  - 保存成功但绑定失败时状态 `saved-not-activated`，保留 Artifact 和“重新绑定”入口，不重复生成/保存。
  - 新增 `POST /__gateway/anchors/jobs/:id/activate`，只允许 `saved/saved-not-activated`，仅绑定已存在 artifactPath；成功转 `succeeded`，失败保持 `saved-not-activated`。
  - Job 启动时记录 Profile config generation；自动激活携带 expectedGeneration。generation 已变化时只保存，不覆盖新配置，等待显式 activate。该 generation 仅用于管理 CAS，不进入上游消息或微锚版本语义。
- `src/lab/run-anchor-candidate.mjs`
  - `ANCHOR_DISPLAY_NAME` 进入 v2 core 和 fingerprint；from-results 再校验。
  - 不改变机器路径生成和 create-only。
- `scripts/run-anchor-candidate.ps1`：增加 `DisplayName/FromResults/Candidate` 参数以保持 CLI 与 WebUI 保存能力一致；不在参数或输出中携带 Key。
- `src/gateway/management-server.mjs`：select body 改为 `{candidate, displayName, activate}` 并 await；增加独立 activate route；区分 400 名称错误、409 重名/状态冲突/CAS 冲突。

### B2. WebUI

- `src/gateway/web/index.html/app.js/app.css`
  - “选用并保存”打开命名 dialog，字段为名称（1–80），说明“名称仅用于识别，机器 id/path 由服务端生成，保存后不可原地重命名”。
  - default/user 在普通列表混排并有清晰徽标；control 不出现；绑定下拉同样排除 control。
  - Builder 目标模型旁增加“查看该模型示例 Anchor”：从 catalog 选择该模型 default；无对应 default 时禁用并显示“尚无模型原生示例”，禁止退回 Pro/control。
  - UI 统一使用“保存/已保存”；内部代码可保留 freeze 术语。

### B3. 验收

- 中文名称可用，HTML 按文本转义；机器路径不含用户名称。
- 同模型重名拒绝，不同模型允许同名。
- Pro 默认在普通列表且可作为 Pro 示例；two-tool control 不再伪装成第二个产品 Anchor。
- 隐藏 control 不破坏开发只读 API，也不会让正常默认被判 orphan。

## C. 微锚领域、配置、历史重建和运行时应用

### C1. 领域与请求路径（强执行关键骨架）

- 实现 `micro-anchor.mjs` 和 `chat-request-transform.mjs` 的契约。
- 来源隔离使用与 messages 等长的本地 `origins[]` 或包装记录；不得向 message 增加可枚举 `_origin`。出站 payload 剥离所有内部包装，只包含上游合法 message 字段；`applyAnchorToChatRequest`只接收已重建的第三方 clone，不再扫描最终消息。
- `src/gateway/proxy.mjs`
  - 建立 `Map<model, MicroAnchorSnapshot>`；请求开始时捕获快照。
  - 模型白名单检查后，对 Chat Completions 调用唯一 transform；bypass 也执行微锚。
  - 合并 Full Anchor 和微锚 metrics；非 Chat path 明确不注入。
- `src/gateway/gateway-instance.mjs`：把 profile 的按模型微锚快照传入 server 并在启动时 fail closed 校验 selectedId。

### C2. 配置与运行时

- `src/gateway/managed-config.mjs`
  - v1→v2 内存迁移、原子保存、定义 CRUD、引用检测、profile nested patch、公开视图和按模型快照解析。
  - 首次从 v1 解析为 baseline enabled 后，在管理 API/UI 提供一次醒目迁移提示；health/诊断可确认 builtin baseline 已启用。
- `src/gateway/runtime-config.mjs`
  - profile 增加按模型微锚选择/快照；split 各一项，single/combined 按请求模型携带完整映射。
  - 新增仅供 Anchor path 使用的 `resolveAnchorPath(environment, keys, defaultPath)`：按优先级检查 key 是否真实存在；存在时返回规范化值（包括显式空字符串），所有 key 都不存在时才用 descriptor default。禁止修改全局 `nonEmpty()`，避免破坏 host/upstream/key 回退。
  - `splitProfile` 和 `singleProfile` 的所有模型 Anchor path 统一改用该 helper；combined 继承相同解析结果。
- `src/gateway/gateway-instance.mjs`
  - `loadProfileAnchors()`移除 Pro 的 `path || DEFAULT_ANCHOR_PATH`二次回退：显式空 + bypass 时不加载；显式空 + anchor 时 fail closed；missing 的默认继承只允许在 runtime-config helper 中发生。
- `src/gateway/gateway-runtime.mjs`
  - 使用共用 coordinator 串行化；Anchor 自动绑定和所有 managed 写入共用，避免覆盖竞争。
  - 新增唯一 `runtimeProfiles(document)`：split 返回启用的 Pro/Flash/Vision，all 再追加带三模型微锚映射的 combined；`startAll()`、影响实例、回滚和关闭都只使用此列表。combined 通过现有 profile child-process 工厂启动，`#start()`传真实 deployment mode，不再硬编码 split；`server.mjs` 删除 runtime 外手工 combined 分支。
  - 创建/删除未引用定义仅原子保存；修改被引用定义、选择或开关时，计算受影响 split/combined 实例并用现有 stop/start 机制重建完整 profile 快照。
  - 单实例重配返回 mutation record `{name,beforeProfile,afterProfile,activeState}`；多实例按确定顺序记录，失败时只逆序恢复 `activeState=after` 项。保存失败同样回滚；恢复失败保留原错与 restore error 并停止后续 mutation。
  - 影响实例按 effective profile diff 计算；凡 combined 消费的模型专属 Anchor path 或微锚映射发生有效变化，combined 也必须重建。
  - 承诺“配置最终全成或回滚、单请求只看到完整旧/新快照”，不承诺跨端口同一微秒切换，也不承诺超过关闭宽限期的长流式请求不中断。
- `src/gateway/server.mjs`
  - split/all 注入 Runtime 微锚 CRUD/配置 handlers。
  - single 启动时按三模型装载微锚映射；single 的 deployment、微锚 CRUD 和 Profile 微锚选择也使用共用 coordinator。配置响应同时区分 configured/applied；有效映射变化返回 `restartRequired:true,pendingRestart:true`，下次启动生效，未引用定义 CRUD 可返回 false。
- `src/gateway/management-server.mjs` 与 single 的 `src/gateway/proxy.mjs` 管理路由：实现同一 API 结构；single UI 明确“保存后重启生效”。

不新增 profile-worker 的微锚热交换 IPC；配置变化通过既有受控实例重启生效，降低跨进程半提交复杂度。第一版 single 下 Anchor Builder 保持不可用，API 返回 501，WebUI 明确提示切换 split/all；弱执行不得自行创建 single AnchorJobManager。

### C3. 验收

- 相同微锚状态 + 字节等价完整历史生成字节等价上游 messages。
- 历史正常延伸时，上一轮重建结果是下一轮相同前段。
- 改内容/选择/开关会用当前状态重建所有第三方历史 user；关闭后所有后缀一起消失。
- Full bootstrap 和 bridge 逐字不变；Vision parts 不丢失、不 stringify。
- split/single/all/combined 均按请求 model 解析；非法 selectedId 启动/保存失败，不静默回默认。
- 失败回滚不丢 Key、端口、Anchor 路径、日志或已有诊断存储。

## D. 微锚独立管理 UI

### D1. 页面

- 在 Anchor Builder 外新增独立 panel：固定缓存警告、定义列表和 Pro/Flash/Vision 选择区。
- 默认卡：锁定/内置徽标、完整只读正文、内容指纹、引用模型、“复制为自定义”；无编辑/删除。
- 自定义卡：名称、正文预览、内容指纹、引用模型、编辑/删除/只读查看。
- 新建/编辑 dialog：名称+正文；复制默认由服务端填充正文。
- 每模型：启用开关、保存项下拉、生效指纹和应用状态。

### D2. 交互

- 编辑正在使用的自定义项、切换到不同有效文本、开关变化前显示统一缓存警告；字节等价文本切换不误报。
- 被引用删除显示 409 返回的具体模型，要求先切换；不自动回落。
- split/all 保存成功后显示受影响并已重启的数据面；single 显示“已保存，重启后生效”。
- 所有帮助说明支持 hover 和键盘 focus。

### D3. 验收

- 默认项完全只读不可删；用户只能复制后编辑。
- 用户能明确看到哪个模型启用了哪个保存项，以及内容/开关变化对 KV Cache 的影响。
- UI 不把微锚称为 continuation，也不声称清除 Provider 缓存。

## E. Flash / Flash Vision 真实默认 Anchor

### E1. 付费调用前代码门禁

- 给当前 open-workstream fixture 增加稳定 `fixtureId/fingerprint`；同一 fixture 用于 Pro/Flash/Vision，不包含任何 Pro reasoning、assistant content 或 tool-call id。
- 生成结果记录 requested model、每 subturn reported model/system fingerprint、fixture fingerprint 和候选集 fingerprint。
- from-results 保存阶段验证候选集 fingerprint、目标模型、完整 final assistant、严格 bash→editor、无 unsafe attempt，并保证零 fetch。
- Builder 子进程只传必要环境；stderr 脱敏。真实结果只进 ignored `results/`。
- 本地假上游和 dry-run 全部通过后才允许真实调用。
- Anchor Job 新增服务端受控 `preset:"canonical-default"`：固定 fixture task/tools/results、runs=3、maxSubturns=6、reasoningEffort=max、maxTokens=384000 和中性 continuation；拒绝同时提交 `anchorPrompt` 或其他覆盖。普通 Builder 继续 custom prompt。
- `select(jobId,{candidate,displayName,activate})`显式支持 activate。E 必须 `activate:false`停在 saved；完成 reload、manifest 和 targeted tests 后才调用独立 activate endpoint。普通用户保存默认 `activate:true`。
- reported model 允许值固定为请求 model 或 `MODEL_CATALOG[requestedModel].servedVersion`；其他值、同一候选多个不兼容值或整轮缺 reported model 均停止，禁止模糊匹配或自动新增 alias。

### E2. 调用额度与顺序

1. 启动当前 Gateway，由管理面 Anchor Job 使用各 Profile 自己的上游和 Key；不把 Key复制到命令行或输出。
2. Flash：一次批次，`runs=3`、`maxSubturns=6`、`reasoningEffort=max`、`maxTokens=384000`、canonical prompt、默认中性 continuation。
3. 主判断（不是弱执行）读取三个完整候选；按“协议全部合格 → reasoning 字符量降序 → candidateIndex 升序”的固定规则确认推荐项，以 `activate:false` 保存名“DeepSeek V4 Flash 默认 Anchor”。
4. 若该批没有合格候选，停止并上报；不得自动追加付费批次。
5. Flash 成功后再按同一额度执行 Flash Vision，保存名“DeepSeek V4 Flash Vision 默认 Anchor”；异常时停止，不复制 Flash/Pro 输出。

候选合格门槛：精确请求模型；reported model 符合显式映射；fixture 相同；严格两次受理工具调用且跨 subturn；固定内存工具结果；无宿主执行；最后一条为非空 assistant；模型归属、候选集和 Artifact 指纹正确；无 secret。

### E3. 登记、默认与 canary

- 两个新文件使用新的 native 机器 id/path，不恢复已删除 copied baseline 路径。
- 以 `activate:false` 保存后重新 load，再把实际 id/path/model/fingerprint 写入 manifest，角色为 default、产品可见/可选；targeted tests 通过后才调用独立 activate endpoint，进入普通列表和对应模型示例按钮。
- 显式绑定后各执行最多 1 次短 canary；不以真实 Provider cache hit 作为确定性测试。
- canary 通过后：
  - `runtime-config.mjs` 将 Flash/Vision 新安装默认 path 指向原生 Artifact，并将默认模式切为 anchor；
  - 当前本机 `gateway.config.json` 只更新对应模型 `enhancementMode/anchorPath`，保留端口、URL、Key、部署和微锚选择。
- 任一 canary 失败：该模型恢复 `bypass + 空 anchorPath`；Artifact/manifest 保留供检查，不冒充已启用默认。
- Anchor path 解析必须区分“字段不存在”和“显式空字符串”：只有不存在才继承 descriptor 默认；managed config 显式 `""` 必须抑制内置默认，确保本机保持 bypass/回滚语义在 single/split/combined 一致。
- 上述语义只通过专用 `resolveAnchorPath`落地，并点名覆盖 `splitProfile/singleProfile/loadProfileAnchors`；禁止为此改变全局 `nonEmpty()`。`"" + bypass`不加载任何 Anchor；`"" + anchor`在保存/启动时拒绝，绝不回落 bundled Pro。

## F. 集成回归和开发文档

### F1. 文档

- 保留用户提供的根目录 `DeepSeek-Flash-Gateway-锚定方案(2).md` 原文件不动；新增 `docs/micro-anchor.md` 作为当前实现文档，引用根方案并列出已裁决差异：
  - 默认项固定只读；额外 steering 通过复制/新建自定义项；
  - 所有第三方历史 user 末尾确定性追加；排除 Full bootstrap/bridge；
  - Gateway 无状态但依赖 Harness 回传完整原始历史；
  - 多模态 parts 规则、配置模型、恢复此前微锚状态的缓存语义；
  - InternalMessage/长轨迹作为未来实验，不伪装成已实现。
- README：三模型默认、Anchor 命名/示例、微锚管理、缓存警告、真实默认生成流程。
- `docs/architecture.md`：Artifact v2/manifest、历史重建与组合顺序、配置迁移和运行时回滚。
- `anchors/README.md`：default/user/control、displayName 与机器 id、create-only、模型原生要求。
- `docs/protocol-sources.md` 只补必要链接，不重写现有未提交内容。

### F2. 最终验收

- 运行配套测试方案全部授权项目；检查实际 diff、未跟踪文件、secret、临时输出和意外格式化。
- WebUI 使用现有 MCP 浏览器能力或人工清单冒烟，不新增项目 Playwright 依赖：覆盖缓存高亮、help、对话语义、命名保存、默认/用户混排、control 隐藏、按模型示例、默认微锚只读、自定义 CRUD、删除冲突、缓存警告和三模型选择。
- 确认真实候选结果仍只在 ignored `results/`，仓库只包含选定 Artifact。

## 5. 执行分工

### 强执行（只承担难点和关键骨架）

- B：AB0 的 Artifact v2/legacy continuation 分流、manifest、名称占位和 `saved-not-activated` 状态骨架。
- C：`micro-anchor.mjs`、`chat-request-transform.mjs`、v1→v2、按模型映射、Runtime 串行/回滚及 combined 生命周期。
- E：fixture/candidate-set 指纹门禁；在真实调用时执行前判断、候选验收和异常上报。

强理由：这些部分同时决定不可变 Artifact、跨模型隔离、完整历史字节稳定性、配置/进程回滚和真实付费结果，难点与实现不可拆开；强执行只写可交接骨架，不承担 UI 和排列性代码。

### 弱执行（主要代码量）

- A 的缓存高亮、WebUI/CSS/查看器/说明；continuation UI/jobs 只在强执行完成 AB0 v2 骨架后接入，不单独落地。
- B 命名 dialog、API 常规接线、列表/下拉/示例渲染和普通校验测试。
- C 管理 API 包装、常规配置字段和测试排列（接强执行骨架）。
- D 全部 UI、交互和文案。
- F 文档、回归测试填充和常规收尾。

### 复核

- 审查最终实现是否偏离历史重建算法、control/default 分类、缓存文案和真实 Artifact 门槛。
- 审查 C 的 T4 方案和 E 的候选/manifest；不承担代码量。

### 主判断

- 裁决强执行反馈、控制范围、验收各块、决定是否进入真实调用和是否放行新安装默认。

## 6. 上报与暂停条件

- 施工前同一脏文件/同一 hunk 又发生变化，无法确认归属。
- v1→v2 会丢字段、Key 或无法原子保存；非法 selectedId 只能靠静默回落才能启动。
- single/all/combined 不能按模型解析或回滚不能恢复全部受影响实例。
- Vision content parts 无法无损保留；Full bootstrap/bridge 被追加微锚。
- Artifact/candidate-set/manifest 指纹不一致、目标路径已存在、缺 final assistant、出现 unsafe attempt 或任何 Pro 输出进入 Flash/Vision 请求。
- Provider reported model 不符合精确请求或显式映射；Vision 不支持当前 thinking/tool loop。
- 单模型真实批次超过 3 候选或计划调用次数、需要第二批付费生成。
- canary 出现跨模型、协议、绑定或安全异常。
- 测试原因不明、同一关键问题连续两轮修不对、回滚失败或发现 secret/真实候选拟进入 Git。

## 7. 文件边界汇总

### 新增

- `src/gateway/micro-anchor.mjs`
- `src/gateway/chat-request-transform.mjs`
- `src/gateway/anchor-manifest.mjs`
- `src/gateway/managed-mutation-coordinator.mjs`
- `test/micro-anchor.test.mjs`
- `test/chat-request-transform.test.mjs`
- `test/gateway-runtime.test.mjs`（跨实例回滚）
- 两个真实生成并选定的 native 默认 Artifact

### 保留原始输入并新增实现文档

- 根目录 `DeepSeek-Flash-Gateway-锚定方案(2).md` 保持原样。
- 新增 `docs/micro-anchor.md`。

### 续改现有

- Gateway：`anchor.mjs`、`anchor-catalog.mjs`、`anchor-jobs.mjs`、`managed-config.mjs`、`runtime-config.mjs`、`gateway-runtime.mjs`、`gateway-instance.mjs`、`proxy.mjs`、`management-server.mjs`、`server.mjs`
- Lab/脚本：`anchor-profile.mjs`、`run-anchor-candidate.mjs`、`scripts/run-anchor-candidate.ps1`
- WebUI：`web/index.html`、`web/app.js`、`web/app.css`
- 测试：现有 Anchor、Gateway、配置、部署测试中的相关断言
- 文档：`README.md`、`docs/architecture.md`、`docs/protocol-sources.md`、`anchors/README.md`

### 明确不改

- 旧 Pro/control Artifact 正文
- 历史实验报告
- 与本轮无关的 classifier/trajectory/token 统计语义
- 端口、上游 URL、Key 和日志策略（除当前本机成功绑定两个新默认所需的 anchorPath/mode）
