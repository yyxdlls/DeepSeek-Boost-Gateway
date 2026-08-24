# Anchor / 微锚点 / 模型默认值测试方案（乙方案）

## 1. 授权和档位

- 本文件当前只设计测试，尚未运行。
- 后续一次 Edit 授权包含本方案的哪些项目，以授权原文为准。若要按完整乙方案一次做完，授权必须明确写入本地测试、Gateway 启停以及 E 块限定额度的真实 Flash/Flash Vision 调用；不能靠未排除默认为付费授权。
- A、D：T2–T3；B、E、F：T3；C：T4。
- 真实 Provider 行为不替代本地确定性测试；只断言上游 messages 的字节变化/不变，禁止用 Provider `prompt_cache_*` 证明“已清缓存”或必然 miss/hit。

## 2. 测试执行顺序

1. 修改前记录基线工作树和已有失败（不得把旧失败算成本轮引入）。
2. 每块完成后运行对应 targeted tests 和 `node --check`。
3. C 完成后运行 T4 多进程/回滚测试。
4. A–D 本地完成后运行全量 `npm test`。
5. 执行 Anchor dry-run 和假上游门禁；确认 `paidRequestsSent: 0`。
6. 启动本地 Gateway，使用现有 MCP 浏览器能力或人工清单执行 WebUI 冒烟；不新增 Playwright npm 依赖、e2e 配置或项目测试脚本。
7. 只有 1–6 全绿才进入 E 的真实调用。
8. 每个真实 Artifact 冻结后运行 loader/catalog/manifest targeted tests；绑定后各做最多 1 次短 canary。
9. E/F 完成后再次运行全量 `npm test`、浏览器冒烟和最终自检。

## 3. A：请求列表、查看器与 continuation（T2–T3）

Continuation 测试属于 AB0 原子切片：先由 B 强执行落 Artifact v2/legacy 分流，再由弱执行接 jobs/UI；AB0 targeted tests 全绿前，不单独运行会保存 Anchor 的 A 冒烟，也不把 continuation 计为 A 已完成。

### 自动测试

- `test/anchor-profile.test.mjs`
  - 默认 continuation 精确等于中性单句；不包含 `inspect-before-act`、`integrate`、`never invent` 等行为 steering。
- `test/anchor-jobs.test.mjs`
  - Artifact v2 与 continuation 放宽同批落地：`undefined` 使用中性默认；显式空字符串通过并保持空；>4000 拒绝。保留该脏测试文件其他未提交断言。
- `test/gateway-anchor.test.mjs`
  - v2 无 continuation 时只构造 Harness bridge，不回退行为型 legacy transition。
  - v1 无 continuation 仍保持 legacy fallback。
  - 旧 Pro/control 消息和 fingerprint 不变。
- `test/gateway.test.mjs`
  - Anchor 查看 content API 仍返回原始 tool result 和旧格式完整性状态。

### 浏览器冒烟

- 请求列表：usage 未返回、0% 命中、部分命中、100% 命中四种显示；缓存输入和命中率均有独立高亮。
- help icon：鼠标 hover 和键盘 Tab/focus 均可读，Esc/移焦关闭，不遮挡输入。
- 三个对话弹窗：
  - `#2` 显示用户/引导请求；
  - `#3/#5` 显示模型消息、思维链和工具调用；
  - `#4/#6` 显示仅工具结果及 call id；
  - 无最终 assistant 的旧 Artifact 不补造 `#7`。
- cat-n：行号紧凑，复制/原数据仍包含原字符串；页面无脚本注入。
- continuation 可留空，默认仅中性单句。

## 4. B：Artifact v2、命名、分类与保存（T3）

### `test/anchor-artifact.test.mjs` / `test/anchor-freeze.test.mjs`

- v2 必须含 displayName；v1 可无并回退 id/manifest 名称。
- displayName 参与 fingerprint；同 trajectory 不同显示名得到不同 Artifact fingerprint。
- 机器 id/path 与显示名独立，中文/空格不会进入路径。
- create-only；已存在路径在任何上游调用前拒绝。
- v2 默认/用户 Artifact 必须以非空 assistant 收尾；legacy v1 control 可读但不能晋升默认。

### `test/anchor-catalog.test.mjs`

- Pro manifest 项为 default、产品可见/可选、固定指纹匹配。
- two-tool manifest 项为 control、普通 list 和绑定选项均不出现。
- control 通过合法 id/path 仍可只读；路径穿越、绝对路径、UNC、损坏/改指纹拒绝。
- 普通 user Artifact 自动归类 user；copiedBaseline 完全排除。
- default/user 混排；displayName/id 回退；正常默认不变 orphan。
- E 后追加 Flash/Vision default 的模型、路径和固定指纹断言。

### `test/anchor-jobs.test.mjs` / `test/gateway.test.mjs`

- select 缺名称、空白、超长、控制/bidi 字符返回 400；合法 HTML 字符作为原文保存、渲染时 escape，不做双重编码。
- 同模型按 NFC+trim 且大小写敏感重名返回 409，不同模型同名允许。
- 两个 awaiting jobs 并发选择同名只能一个占位成功。
- 合法 `{candidate,displayName}` 传入 from-results，产物重新 load 通过。
- from-results 使用 select 阶段最终机器 id，断言 Artifact id、文件名和 Job identity 一致。
- 保存成功/绑定失败进入 `saved-not-activated`，保留 path/fingerprint；重试绑定不再次生成或覆盖文件。
- `activate:false`停在 saved；独立 activate endpoint 只绑定现有文件。配置 generation 已变化时自动激活 CAS 失败且不覆盖新绑定。
- UI/API 始终使用“保存”，内部 freeze 状态不泄漏成产品文案。

### 浏览器冒烟

- 命名 dialog 的字段、说明、取消、错误和成功 toast。
- default/user 徽标与绑定下拉；control 不可见。
- Builder 切换 Pro/Flash/Vision 时示例按钮打开对应 default；无 default 时禁用且不展示别的模型。

## 5. C：微锚领域与历史重建（T3）

### 新增 `test/micro-anchor.test.mjs`

- 默认 id/name/text 逐字匹配，只读不可删。
- 自定义名称/正文规范化、长度、控制/bidi、CRLF→LF、全空白拒绝。
- 内容指纹稳定；相同正文不同 id 指纹相同。
- create/update/delete、复制默认、被引用删除冲突。
- string content 固定追加 `\n\nM`。
- content parts 保持原 part 的顺序、字段、嵌套图像 URL/data URI/detail 和序列化值，只新增末尾 text part；输入对象不被修改，不要求变换前后 JavaScript 对象引用相同。
- `content:""` 得到 `"\n\nM"`；空数组、null、裸字符串 part、数组 part、缺少非空 `type` 的对象整单拒绝。
- 非 string/array user content 在 enabled 时整单失败；disabled 时完全透明。
- 每条第三方 user 都追加；system/developer/assistant/tool 不变。
- 用户原文已经以 M 结尾时仍追加一次，不做后缀推断。
- 输入对象不原地修改。

### 新增 `test/chat-request-transform.test.mjs`

四组合矩阵：micro off/on × bypass/anchor。

- on+bypass：全部第三方 user 为 `Uᵢ+M`，其他字段不变。
- on+anchor：Full trajectory 和 bridge 逐字不变；只变第三方 user。
- header bypass 只绕过 Full Anchor，微锚仍按 profile 开关生效。
- 最新消息为 assistant/tool 时不新增 user。
- tools、thinking、reasoning_effort、stream、response_format、采样参数不变。
- 出站 messages 不含 `_origin/origin` 或任何内部来源字段。
- metrics id/fingerprint/count/string/multipart/reason 正确；不含正文或图像。
- `thirdPartyHistoryFingerprint` 等于微锚变换后、Full Anchor 组合前第三方 messages 规范 JSON 的 SHA-256，并且不含 origin。
- `T(S,H)` 确定性；`H2=H1+A1+U2` 时 `T(S,H1)` 为 `T(S,H2)` 的相同消息前段。
- 改正文/选择不同有效正文/关开关会重建所有历史 user；恢复旧状态得到原变换。
- 相同正文不同 id 不改变上游 messages/history fingerprint。

## 6. C：Managed config 与按模型映射（T3）

### `test/managed-config.test.mjs`

- empty config 为 schema v2；load v1 内存迁移并保留 deployment/profile/Key/未知已有合法字段；下一次保存写 schema v2，不保留旧测试中“始终写 schemaVersion:1”的断言。
- 未配置微锚解析为 baseline enabled + builtin id。
- 微锚不进入 `process.env/ENV_FIELDS`；运行时快照只从 managed document 解析。
- 保存使用原子替换；模拟写/rename 失败时旧文件字节不变。
- API 公开视图不泄露 Key；微锚正文只出现在受保护管理 API。
- profile nested patch 只改变目标模型；非法 selectedId fail closed。
- 自定义定义被多模型引用时 references 正确。
- v1 迁移后的第一次 Chat 请求已给第三方 user 追加 `\n\n` + 默认 M，并在管理 UI/health 暴露 baseline 已启用提示。

### `test/runtime-config.test.mjs` / `test/gateway-instance.test.mjs`

- split 三 profile 各有精确一模型快照。
- single/combined 有三模型 map，按请求 model 精确选择，不能共用一条“当前微锚”。
- 非 Chat path 不注入。
- 默认 builtin、custom、disabled 和损坏引用的启动行为。
- 现有 Anchor 模型归属和 copiedBaseline 拒绝不回归。
- 专用 `resolveAnchorPath`：字段 missing 才继承 descriptor default；显式 `"" + bypass`在 split/single/combined 都不加载、不继承；显式 `"" + anchor`在保存/启动 fail closed。
- Pro loader 不再用 `path || DEFAULT_ANCHOR_PATH`二次回退；Flash/Vision 规则相同。
- 全局 `nonEmpty()`保持原行为，host/upstream/key 的既有 fallback 测试不变。

## 7. C：运行时重配与回滚（T4）

### 新增 `test/gateway-runtime.test.mjs`

- mutation queue 串行化：profile save、微锚更新、Anchor activate 不互相覆盖。
- split：修改被 Pro/Flash 共用定义，两个 profile 使用同一新快照。
- all：相关 split 实例和 combined 都更新；combined 按请求模型选择。
- single：共用 coordinator 串行处理 deployment/微锚写入；有效映射变化返回 `restartRequired:true,pendingRestart:true`，configured/applied 可区分，重启后使用新状态；未引用定义 CRUD 可为 false。
- 仅创建/删除未引用定义不重启数据面。
- restart 第一个/中间/combined 失败：已变更实例恢复旧 document 快照，配置文件不变。
- 多实例 mutation record 只逆序恢复实际处于 after 状态的实例；原错误和 restore error 均保留。
- atomic save 失败：实例回滚，Key/端口/Anchor path/日志字段不丢。
- rollback 自身失败：Runtime 标记 degraded、后续 mutation 拒绝并上报。
- 配置变化期间单请求只看到完整旧或完整新快照；不出现同请求混用。
- 超过关闭宽限期的旧流式请求允许被明确中断，但同一上游请求不得混入两套微锚。
- 现有诊断 store 在重启/回滚后保留。

### `test/deployment-server.test.mjs`

- all 模式仍启动 management + pro/flash/vision + combined；Runtime 接管 combined 后端口/模型/关闭流程不回归。
- combined 由统一 runtimeProfiles/startAll 路径启动，子进程收到真实 `deploymentMode:all`，不再由 `server.mjs` 手工启动或硬编码 split。
- 微锚更新后 health/config 视图反映三个模型，管理面不泄露 secret。

## 8. D：微锚管理 UI（T2–T3）

### API 集成（`test/gateway.test.mjs`）

- GET 返回 builtin+custom、refs、profile selection、指纹和缓存警告。
- POST create/copy-default；PATCH custom；builtin PATCH/DELETE 409；被引用 DELETE 409。
- profile switch/toggle 返回 affected profiles、effectiveChanged、restartRequired。
- 相同有效正文切换返回 `effectiveChanged:false`。
- mutation auth、content-type、非本机保护与现有管理 API 一致。

### 浏览器冒烟

- 独立 panel，不嵌 Full Anchor Builder。
- builtin 无编辑/删除，复制后自定义可改。
- 自定义新建/编辑/删除、同名/空正文/超长错误。
- 被引用删除显示具体模型，不静默回退。
- 三模型开关/下拉和当前生效指纹。
- 改正文/不同正文选择/开关显示统一警告；相同正文切换不误报。
- split/all 显示已应用；single 显示重启后生效。
- 页面无 `revision`、无“已清除 Provider 缓存”文案。

## 9. E：真实默认 Artifact 门禁（T3 + 手工 canary）

### 无费用自动门禁

- Flash/Vision 假上游逐 subturn 请求 model 精确。
- 两模型 fixture id/fingerprint 与 Pro canonical fixture 相同，请求中不存在 Pro assistant/reasoning/tool-call id。
- 固定工具结果来自内存 fixture，不执行宿主工具。
- exactly bash→editor，跨 subturn，最后非空 assistant。
- candidate-set fingerprint 篡改、模型不符、缺 final assistant、unsafe attempt、路径存在均在 freeze 前拒绝。
- from-results 通过 fetch spy 证明零上游调用。
- dry-run 输出 `paidRequestsSent:0`、调用上界、模型、fixture fingerprint、结果路径，不输出 Key。
- `preset:canonical-default` 固定全部参数并拒绝 `anchorPrompt`/其他覆盖；普通 custom Builder 不受影响。
- select 使用 `activate:false`后停在 saved；manifest/targeted tests 前不得绑定。独立 activate endpoint 不再次 freeze/fetch。
- from-results 把 select 阶段最终 id 写入 Artifact，并校验 Artifact id、文件名、Job identity 一致。
- reported model 只允许请求 model 或 `MODEL_CATALOG[requestedModel].servedVersion`；缺失/未知/候选内不一致均停止。

### 真实调用限额

- Flash：最多 1 批 × 3 candidates × 6 subturns。
- Vision：Flash 合格后，最多 1 批 × 3 candidates × 6 subturns。
- 每模型无合格候选即停止；不自动第二批。
- 冻结后验证 requested/reported model、fixture、tool sequence、final assistant、source.model、Artifact fingerprint 和无 secret。

### 默认登记和 canary

- manifest 固定实际路径/模型/指纹；catalog role=default，示例按钮正确。
- Loader 拒绝把任一 Artifact 用给其他模型。
- targeted tests 通过后才调用独立 activate endpoint。
- 当前本机只改目标 profile mode/path；端口、URL、Key、部署、微锚字段字节不变。
- 显式 `anchorPath:""` 抑制 descriptor 默认；missing 字段才继承默认，single/split/combined 一致。
- canary 回滚实际启动数据面后确认 Anchor 集合为空，而不只检查 managed view。
- 每模型最多 1 次短真实 canary；验证 HTTP 成功、diagnostic 中正确 Anchor/微锚 id、无跨模型。
- canary 失败恢复该模型 `bypass + 空 path`；不删除 Artifact、不复制其他模型输出。

## 10. F：全量回归、自检与文档一致性

### 命令阶梯

按实际改动文件运行 `node --check`，然后依次：

```text
node --test test/anchor-profile.test.mjs test/anchor-jobs.test.mjs test/gateway-anchor.test.mjs
node --test test/anchor-artifact.test.mjs test/anchor-freeze.test.mjs test/anchor-catalog.test.mjs
node --test test/micro-anchor.test.mjs test/chat-request-transform.test.mjs
node --test test/managed-config.test.mjs test/runtime-config.test.mjs test/gateway-instance.test.mjs
node --test test/gateway-runtime.test.mjs test/deployment-server.test.mjs test/gateway.test.mjs
npm test
```

随后运行两个模型 dry-run、Gateway 启动 smoke 和 MCP 浏览器/人工冒烟；不新增项目浏览器依赖。E 完成后再次运行 catalog/loader targeted tests 与 `npm test`。

### 最终自检

- `git status`、`git diff --stat`、逐文件 diff；区分既有改动与本轮增量。
- 无 `.env`、Key、候选结果、流量日志、PID、临时 config、浏览器截图等意外入库。
- 旧 Pro/control Artifact 字节不变；copied Flash baseline 仍保持删除。
- 无无关格式化、临时 debug、死按钮、重复 route、未引用样式或 TODO。
- README、architecture、micro-anchor、anchors README 与实际 API/schema/UI 一致。

## 11. 失败处理

- 测试自身明显错误：执行智能体在 T1/T2 范围修正并重跑。
- 被测代码明显错误：按弱执行→强执行升级链处理。
- 原因不明、跨进程/回滚测试反复失败：暂停，由主判断选择改测试方案、升级执行或缩小覆盖。
- 同一测试方案连续两轮修不对：升档或换设计者。
- 任何真实调用异常、费用上界变化、模型身份不明、secret 风险或候选不完整：立即停止 E，不重试。
