# 落地 plan：产品面只看 token；保存不再硬拦工具

## 粒度 / 配置

- 局部单元：产品面统计改 token + 保存时工具可选
- 难度低 + 复杂度低 → 主判断 + 弱执行
- 测试档 T2（改现有断言 + 补保存警告/放行用例）
- 不改 artifact 指纹、不改 JSONL/请求体字节上限、不编造 replay tokens

## 需求落地

### A. 产品面统计：token 优先，去掉字数/字节展示

原则：

- 展示上游返回的 token。总 token 最醒目；其次推理 token、正文 token。
- 未返回就写「未返回」/「—」，禁止用字符数或字节数冒充 token。
- 字数、UTF-8 字节不再作为产品统计出现。
- 内部仍可保留 chars/bytes 字段（trajectory-stats、measureAnchorArtifact、请求体限制），只是 UI/CLI 人读输出不再用它们当统计。

改哪里：

1. `src/gateway/web/app.js`
   - `renderContextOccupancy`：主数字改为生成记录里的 **总 tokens**（`usage.totalTokens`；没有则「未返回」）。副行：推理 tokens · 正文 tokens · 输入/输出（有则显示）。去掉 `formatBytes` / 回放 UTF-8 字节 / 推理字符 / 正文字符。思维链类型与关键字仍留在这块。
   - 只读 Anchor 详情、请求详情「锚点历史」都走新块。
   - 候选卡、直播进度、列表行：有 token 显示 token；没有就「—」，不再回退「X 字符」。
   - 顶栏 `metric-reasoning`：改成已保存推理 **tokens** 合计（从 `tokensFromSummary`）；副文案改「平均 N tokens / 请求」。无 usage 的条目不计入，不拿字符顶替。
   - job 摘要去掉「续接/提示词 X 字符」。
   - 直播标题「已输出推理 X 字符」→ 有 live.usage 则显示 token，否则只写「推理中」，不报字符。
2. `src/gateway/web/index.html`：`已保存推理总长` → `已保存推理 tokens`。
3. `src/gateway/inspect.mjs` 人读输出：改 token；无 usage 写 `tokens=未返回`，不再打印 chars/bytes。
4. 自动挑选长度维：`anchor-jobs.mjs` `recommendedCandidate`、`run-anchor-candidate.mjs` `selectBestCandidate` 的长度比较从 `reasoningChars` 改为 `usage.totalTokens`（缺省当 0）。思维链 collective / interruptive 排序不变。

不改：

- `anchor-metrics.mjs` / `inspect-anchor.mjs` 实验室量具（仍可输出字节，不当产品统计）
- JSONL 轮转、请求体超限、displayName 1–80 字符、开头节选 40 code points
- 不计算、不声称 replay 精确 token

### B. 工具调用不是保存门槛

原则：

- 协议检查字段保留，UI 继续高亮 bash / view 是否调用。
- `validateResultsForFreeze` **不再**因缺工具 / 非「bash 然后 editor」拒绝保存。
- 仍硬拦：无完整末轮 assistant、unsafe 工具、指纹/模型/夹具不匹配。
- `eligible` 定义先不动（仍含工具协议项）；不合格也可保存（已有 freeze 用例）。
- WebUI 点「选用并保存」或提交保存对话框时：若该候选 `toolStatus.bash` 与 `toolStatus.strReplaceEditor` 未都为 true，先 `confirm`：「该候选未完成全部工具调用（bash / view）。仍要保存吗？」取消则不发请求；确认后照常保存。

改哪里：

- `src/lab/anchor-generation-gates.mjs`：删掉 exactAcceptedSequence / editorAfterBash / exactTwoToolCalls 那道 throw。
- `src/gateway/web/app.js`：`openSelectDialog` 或提交前加确认。
- 测试：补「缺工具仍可 freeze」；改掉任何仍期望这句报错的断言。

## 分片

- 弱执行：上述文件按 plan 改完并跑测试。
- 主判断：验收展示是否还漏字符/字节、保存路径是否真能放行、有无编造 token。

## 不改什么

- 三份默认 artifact 内容
- 生成提示词
- unsafe 仍拒绝
- 不把实验室字节量具改成 tokenizer

## 验收

- 只读 Anchor 详情主数字是总 tokens，不见「字节」「字符」统计。
- 请求详情 / 列表 / 顶栏 / 候选卡 / 直播 / inspect CLI 人读输出同样。
- 缺 usage 显示未返回，不出现「N 字符」回退。
- 缺 bash/view 的候选：UI 仍高亮未调用；确认后能保存；服务端不再抛 `must be exactly bash then editor`。
- unsafe / 无末轮 assistant 仍拒绝。
- `node --test` 全绿。

## 上报条件

- 某处统计没有 usage、又必须显示长度，不知是否破例
- 发现改 eligible 语义才能做下去
- 自动挑选改 totalTokens 后与现有测试冲突且无法就地修
