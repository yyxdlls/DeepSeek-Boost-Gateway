# 锚点生成流式化 + 思维链统计改版

## 用户需求映射

1. 锚点生成从"轮次更新"改为流式：可点开查看当前输出，运行中卡片外部闪动。
2. 生成中预览格式崩（旧实现把 firstLine 拼成纯文本行）→ 新结构化渲染修复。
3. 候选"未通过原因"中文化。
4. 候选关键字统计只保留 4 组（I'm …ing 极正向 / we need 很正向 / let's 较正向 / let me 偏负面），英文在前中文在后，只统计推理。
5. 基础信息条：input / output / cache / 命中率 / 工具次数。输入不显示的根因之一：流式请求未注入 stream_options.include_usage，usage 不回传。
6. 详细信息面板精简：基础信息 + 锚点外推理关键字统计 + 锚点关键字统计 + 开头单词预览 + 弹窗看完整消息 + 完成状态/中断原因。
7. "运行模式"卡片样式修复；"轨迹"统一改叫"思维链"。

## 思维链判定规则（v3，替换 v2 评分）

- 单条 I'm …ing（匹配 i'm + 动词ing）→ gray-test（灰度测试思维链）
- let me 累计 ≥3 → let-me（let me 思维链，正式版弱思维链）
- we need/我们需要/let's/让我们 ≥1 且 ≥ 2×let me → minimal（Minimal 思维链，正式版强思维链）
- 其余 → mixed（无明显倾向）

markers 精简为 8 个：imIng, imIngZh, weNeed, weNeedZh, lets, letsZh, letMe, letMeZh（此顺序即展示顺序）。

## 文件改动

| 文件 | 改动 |
| --- | --- |
| src/gateway/trajectory-stats.mjs | COT_MARKER_PROFILE v3；cotStyleFromCounts；trajectory 字段改 cot；导出 openingPreview |
| src/lab/classifier.mjs | 对齐 v3：metrics 增 lets/imIng，label 新规则 |
| src/lab/anchor-profile.mjs | letMeTotal 含中文；label 比较更新 |
| src/lab/assistant-stream.mjs（新） | SSE 累积器 + DeltaThrottler |
| src/lab/run-anchor-candidate.mjs | 流式请求（stream+include_usage）、delta 事件、subturn 事件带 usage 快照 |
| src/gateway/anchor-jobs.mjs | job.live 维护；candidateSummary 增 markers/cot/openingPreview；publicJob 暴露 live |
| src/gateway/proxy.mjs | 注入 stream_options.include_usage；诊断保存 rawMessages（截断上限） |
| src/gateway/diagnostic-history.mjs | entry.messages = {request, response} |
| src/gateway/management-server.mjs | 导入改名 |
| src/gateway/web/index.html | 标题/文案思维链化；live-dialog、messages-dialog；metric-mode text-value |
| src/gateway/web/app.js | 详情面板重构、思维链标签、候选卡重构、运行中流式视图、弹窗、中文未通过原因 |
| src/gateway/web/app.css | text-value、脉冲动画、live 流样式、marker/cot 样式 |
| README.md / docs/protocol-sources.md | 说明更新 |
| test/*.mjs | 对应更新 + 新增 assistant-stream 测试 |

## 测试

用户本轮未授权运行测试 → 只做 node --check 语法自检，测试留待后续轮次统一运行。

## 2026-08-23 追加：第三模型与默认 Anchor 纠偏

- 新增独立 `vision` profile：模型 `deepseek-v4-flash-vision-exp`，端口 8645。
- Pro 默认 `anchor`；Flash/Vision 都没有可信内置模型原生 Anchor，默认 `bypass`。
- 删除 copied Pro→Flash baseline；catalog 排除、loader 拒绝 `copiedBaseline`。
- 后续产品复核已撤销 collective steering：关键字只观察自然输出，由用户挑选。
- 仅协议合格且思维链分类为 `minimal` 的候选自动标为推荐。
- Vision 支持结构化图像输入透明转发；诊断中的超大图像 data URI 会截断，避免日志失控。
