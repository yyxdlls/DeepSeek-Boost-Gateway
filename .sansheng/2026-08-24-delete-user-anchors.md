# 落地 plan：删除用户生成的 Anchor

## 粒度 / 配置

- 局部单元：catalog + 管理 API + 卡片删除按钮
- 难度低 + 复杂度低 → 主判断 + 弱执行
- 测试档 T2

## 需求

用户生成的 Anchor 能从 WebUI 删掉。内置默认 / control 不能删。

绑定处理跟微锚点一致：仍被某模型平面引用则 409，提示先换绑定，不自动解绑、不自动切 bypass。

## 做什

1. `src/gateway/anchor-catalog.mjs` 增加 `deleteUserAnchorArtifact(input, directory)`
   - 路径/id 解析复用 `readAnchorArtifactContent` 同一套安全规则（相对路径、禁 `..`、只在 `anchors/` 顶层）
   - `category !== 'user'` 或 `bundledDefault` → 409，不可删
   - 找到后 `unlink` 该 json，返回被删条目摘要
   - 不扫、不删 `anchors/legacy/`

2. 管理路由（`management-server.mjs` 与 `proxy.mjs` 两处对称）
   - `DELETE /__gateway/anchors`，body 或 query 只收 `path` 或 `id` 其一
   - 需要 `mutationAuthorized`
   - 删文件前查当前配置里各 profile 的 `anchorPath`：路径或指纹对上则 409，`referencedBy: ['pro',…]`
   - 成功 200：`{ schemaVersion: 1, deleted: { id, path } }`

3. WebUI `app.js`
   - 用户生成卡片加红色「删除」；模型默认卡不加
   - confirm：「确认删除 Anchor「名称」？删除后不可恢复。」
   - 409：toast 列出占用的模型平面，让用户先换绑定
   - 成功后刷新 catalog + 配置表

## 不改

- 默认 artifact 文件与 manifest
- leftover 里的旧文件（本来就不在产品列表）
- 不自动改 `gateway.config.json` 绑定
- 不删正在跑的 job 结果文件（那是 discard job）

## 验收

- 用户生成可删，列表立刻消失
- 默认 / control 无删除按钮；API 也拒
- 当前绑定中的用户 Anchor：409，文件仍在
- 路径穿越 / 绝对路径 400
- `node --test` 全绿

## 上报

- 发现绑定比较不能只靠 path（指纹对上但 path 写法不同）且现有 `bindingMatchesArtifact` 不够用
