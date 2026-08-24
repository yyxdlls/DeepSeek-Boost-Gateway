# 运行模式 / 详情 / 默认来源 / Pro 生成 · 落地 plan

## 授权与节奏

- 当前 Plan。两块：A UI，B Pro 真实生成。
- 用户已点名「pro 也生成一下」。未获整单执行令前只写 plan。
- 默认甲：先授权 A，做完再授权 B。用户说按划分做完则改丙。

## 配置档

A：难度低 + 复杂度低 → 主判断 + 弱执行。测试 T2。
B：与上一轮 D 同档 → 主判断挑选 + 弱执行跑任务。测试 T4（真实上游，已点名）。

---

## A. 展示与刷新

### 1. 运行模式这一排

原因：single 的 `/health` 不再有单一 `mode`，卡片写成 `—`；卡片按大数字排版，中文部署名挤在 172px 格子里。

改：

- `metric-mode` 显示部署拓扑，不用 `health.mode`：
  - single → `单端口`
  - split → `三端口`
  - all → `全开启`
- `metric-mode-note`：`按 request.model 路由` / `每端口一个模型` / `多模型口 + 三单模型口`
- 样式：`.metric-card strong.text-value` 允许换行；运行模式卡 `minmax` 放宽或让该卡 `grid-column` 更宽，不再跟数字卡抢同一套 48px 字号。不改另外 6 个数字卡的含义。

### 2. 请求详情「思维链」被截断

原因：`.mini-metrics` 三列；「思维链」格 `nowrap + ellipsis`，右侧空着。

改：

- 「思维链」改为 `.wide`（与开头节选同），允许换行，字号不小于开头节选。
- 关键字芯片区保持现有只渲染 count>0。
- 不改判定规则。

### 3. Flash / Vision 标成模型默认

代码已把两份登记为 manifest `default`。正在跑的 Gateway 是登记前启动的，catalog 仍按 `user` 分类。

改：

- 执行 A 时重启 Gateway，让 catalog 读新 manifest。
- 卡片 / 下拉 / 只读「来源」一律：`default` = 内置默认示例 / 模型默认；不要把已登记 default 显示成用户生成。
- 不改两份 Artifact 文件。

### 4. 只读查看补思维链类型 + 关键字 + 上下文占用

`GET /__gateway/anchors/content` 现在不带轨迹统计。`renderAnchorView` 也没有类型/关键字；token 格子埋在一排小卡里。

改：

- content 接口对 `trajectory.messages` 跑现有 `summarizeMessageTrajectory`（与请求详情同一套 v3），返回 `reasoning.cot` + `markers`。
- 只读查看在生成统计上方加一块高亮「上下文占用」：
  - 主数字：回放消息 UTF-8 字节（`JSON.stringify(messages)` 的 byteLength）。现有 `measureAnchorArtifact` 明确 **没有** Provider tokenizer，禁止编造 replay tokens。
  - 副行：推理字符 / 正文字符；若 Artifact 有 `usage.promptTokens`，旁注「生成收尾提示 tokens：N（不是回放精确值）」。
  - 样式单独一套（比普通 basic-stat 大、用强调色），不要混进那排小卡。
- 同一块展示思维链类型 + 命中关键字（复用 `renderMarkers` / `trajectoryLabel`）。
- 请求详情的 Anchor 历史块同样加「上下文占用」高亮（用该次 `transformation.anchorHistory` 的消息体积；没有消息则不编）。

### 5. 模型独立配置不要跟着自动刷新重绘

原因：5 秒 `loadData` → `renderAll` → `renderProfiles` 整表重建，输入丢失、光标跳。

改：

- 自动刷新（含 `visibilitychange` 的 quiet 刷新）只更新：health 指标、请求列表、详情（当前选中项）、jobs。
- `renderProfiles` / `renderDeployment` / `renderMicroAnchors` / `renderConfig` 仅在：手动点刷新、保存成功、`force:true`、或对应数据指纹变化 **且** 焦点不在这些表单里。
- 焦点在 `#profile-list` / 部署表 / 微锚表内时，即使数据变了也不拆掉正在编辑的表。

### 不改

- 不改 v3 规则、token 口径、两份 Flash Artifact、旧 Pro Artifact 文件内容。
- 不为回放编造 Provider token。

### 验收

- single 顶栏运行模式不是 `—`，字能完整看见。
- 请求详情思维链类型整行可见。
- 重启后 Flash/Vision 卡片是「模型默认」，只读来源是「内置默认示例」。
- 只读查看有类型、关键字、高亮上下文占用。
- 在模型配置里打字 10 秒不会被刷新清掉。

### 分片

弱执行整包。上报：content 接口必须改 schema 才能带统计却会弄破现有测试。

---

## B. 给 Pro 也生成一份原生默认

额度与 Flash 相同：`preset: canonical-default`，`runs=3`，`maxSubturns=6`，`reasoningEffort=max`，`maxTokens=384000`。显示名「DeepSeek V4 Pro 默认 Anchor」。`activate:false` → 测试 → 再绑定。

挑选：协议全过 → 推理字符降序 → candidateIndex 升序。整批不合格则停，不追加批次。

旧 `anchors/dsh-minimal-open-workstream-pro.json` **文件不改**。manifest 里它从 `default` 改为 `legacy`（产品仍可见、只读，徽章「旧版」），新产品文件登记为唯一 `default` 并绑定。测试里 `bundledDefault && model===pro` 指向新文件。

不改 two-tool control。Key 不进仓库/汇报。

---

## 上报

- 自动刷新拆开后 jobs 进度停更
- Pro 整批不合格
- 发现 Flash 重启后仍不是 default（manifest 路径/指纹对不上）
