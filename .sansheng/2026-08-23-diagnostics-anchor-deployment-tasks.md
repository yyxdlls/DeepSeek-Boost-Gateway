# 诊断 / Anchor / 部署模式顶层任务清单

## 规模判断

本轮不是局部单元，共 4 个相对独立的结构块。先按顶层块推进，不一次拆到底。

## A. Token 优先的请求诊断与预览

**边界**

- 将请求列表与详情统一改为 token 口径：本次上游输入、输出、缓存输入、未缓存输入、缓存命中率。
- 输出拆分为推理 tokens 与正文 tokens；上游没有分项时仅这两个字段回退字符数。
- 工具调用量与思维链类型直接进入请求预览首部。
- Input / Output 不使用特殊紫色、绿色，跟其他基础数据同一视觉层级。
- “开头四词 / 四字”独占整行。
- 完整消息只展示当前请求新增输入（最后一个 assistant 之后的 user/tool 尾部；没有 assistant 时排除 system/developer 后展示输入）与本次新回复。
- 修复消息弹窗说明被通用 CSS 覆盖导致的版式问题；预览与角色名称尽量中文。

**不改**

- 不自行估算模型 tokenizer；输入/输出没有上游 usage 时显示“未返回”，不拿字符冒充 token。
- 中断流没有终态 usage 时，仅推理/正文允许显示已观测字符。

**完成标准**

- 有 usage 的请求预览可直接看到输入/输出/缓存输入/命中率/推理/正文/工具/思维链。
- 当前历史日志中的 `prompt_tokens`、`completion_tokens`、`reasoning_tokens`、cache hit/miss 能正确显示。

**测试档**：T3（usage 多协议字段、完整/中断 SSE、详情与预览口径）。

## B. Anchor 生成语义纠偏

**边界**

- 删除私自追加的 collective steering 提示词；We need / Let's / Let me 只做自然输出统计，由用户挑选。
- Anchor 生成继续执行到 assistant 最终答复，允许 final answer；Artifact 必须是完整对话，不能以 tool 结果结尾。
- UI 不再显示“合格/不合格/未通过”；只显示两个工具状态牌：调用为绿，未调用为红。
- 去掉候选预览中的 `#1 无工具` 等无意义轮次行；保留开头预览、思维链类型、完整对话入口。
- 新增 continuation 输入框并写入 Artifact；注入时作为明确的桥接语义处理并在只读查看器中可见。
- 新增思考强度下拉：low / high / max，默认 max；请求和 Artifact requestSettings 都记录实际选择。
- 中文化 Anchor 预览中不必要的英文标签。

**continuation 设计决定**

- continuation 不是 Anchor 内已经得到回复的一轮，而是 Anchor 完整对话与真实 Harness 历史之间的“桥接指令”。
- 不再作为两个连续 synthetic user 消息之一单独悬空；与当前 Harness 说明合并为一条 bridge message，再接回原会话。
- Artifact 保存 continuation 文本与 mode；诊断 transformation 保存 bridge 的存在和字符数，便于解释实际注入顺序。

**完成标准**

- 新生成 Artifact 的最后一条消息是 assistant 最终回复。
- 生成请求不含额外 We need / Let's steering。
- 用户能选择思考强度、填写 continuation、查看自然关键字结果并自由冻结候选。

**测试档**：T3（工具循环第三轮最终回复、Artifact 完整性、continuation 注入顺序、reasoning effort 传递）。

## C. 已生成 / 默认 Anchor 只读查看器

**边界**

- Anchor 管理列表同时显示内置默认、已生成、当前绑定状态。
- 每个 Artifact 可打开只读弹窗，查看模型、生成参数、continuation、完整消息、推理、正文与工具调用。
- 新增只读管理 API，限定 anchors 目录/目录清单中的合法 Artifact，拒绝路径穿越。

**完成标准**

- 默认 Pro Anchor 与后续生成的 Flash/Vision Anchor 都能只读打开；没有任何编辑/覆盖入口。

**测试档**：T2（合法读取、404、路径穿越、损坏 Artifact）。

## D. 部署拓扑设置

**三档定义（建议默认）**

1. `split`：多数据端口，每端口一个模型；管理 8642，Pro/Flash/Vision 为 8643/8644/8645。
2. `single`：单端口多模型，沿用当前 single 语义；共享上游、Key、默认模式。
3. `all`：同时开放 split 端口与额外合并数据端口 8646；管理仍为 8642。合并端口使用 shared 上游/Key，默认 bypass。

**边界**

- WebUI 新增部署方式设置，写入本机配置；拓扑变更标记为“重启后生效”，不伪装成热切换。
- launcher / server / health / PID / stop 链路统一识别三档。
- split 内的 profile 设置仍可热应用；档位切换必须整体重启。

**风险**

- single/all 的合并数据面只有一份 shared Key 和 upstream；若要求合并端口仍按模型使用独立 Key/上游，需要另做模型路由层，不能顺手混入。
- all 的 8646 是新默认值；端口冲突必须在启动前拒绝。

**完成标准**

- 三档启动信息、health、WebUI 端点与停止脚本一致；不会重复启动或占用同一监听。

**测试档**：T4（多进程、端口冲突、模式切换重启、PID 与关闭回归）。

## 建议顺序与依赖

A → B → C → D。

- A 独立，先修用户当前最直接看到的数据错误。
- B 先确定新 Artifact 语义；C 再按最终 schema 做查看器。
- D 与前三块代码耦合较低，但进程/测试范围最大，最后单独施工。

## 计划节奏

默认甲：逐块细化落地 plan、逐块授权。若用户明确要求一次做完，则切丙：一次授权、逐块推进，遇到部署定义分歧或范围扩大再暂停。
