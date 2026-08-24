# Anchor 命名、默认模型锚点与微锚点顶层任务清单

## 规模与配置判断

本轮不是局部单元，拆成 6 个顶层块逐步落地。整体属于理解难度高、结构复杂度高：主判断负责边界与裁决；强执行负责第三方历史重建、配置事务和真实 Artifact 生成关口；弱执行承担 WebUI、常规接口、测试填充与文档；复核审查 schema、缓存表述、默认 Artifact 验收和 T4 测试方案。视觉代理没有图片输入，不挂载。

测试是否实际运行仍由用户在编辑轮授权。设计档位：A/D 为 T2–T3，B/E/F 为 T3，C 为 T4。

## 已裁决的产品语义

1. Anchor 保存时必须填写用户可读名称；名称与机器 `id`、文件路径分离。机器路径由服务端生成并保持 create-only，保存后不提供原地重命名。
2. 模型内置默认 Anchor 可以和用户保存的 Anchor 一起出现在普通列表中，并正常选择、绑定和查看。当前多出的 `dsh-minimal-two-tool-v1.json` 只保留为实验 control，不作为产品 Anchor 或普通可选项；它不是 Builder 的 Pro 示例。Builder 在目标模型选择器旁提供“查看该模型示例 Anchor”按钮：Pro 打开当前 Pro 默认，Flash/Vision 在各自真实默认生成后打开对应模型默认；尚无对应模型示例时按钮明确禁用。
3. 旧 Pro Artifact 不修改、不伪造最终助手回复；其旧格式和已保存 continuation 原样展示。Builder 的新默认 continuation 只保留中性桥接，不再附加“先检查后行动、整合后续内容、不得虚构工具结果”等行为约束，并允许用户完全自定义或留空。
4. 对话查看按协议结构解释：`user` 是用户/引导请求；`assistant` 是模型消息容器，可同时含思维链、正文和工具调用；`tool` 只代表对应调用的工具结果，不等于本轮最终回复。工具结果中的 `cat -n` 行号前导空格只在展示层紧凑化，不改 Artifact 和指纹。
5. 微锚点是独立模块和独立保存对象。内置默认微锚固定只读、不可编辑、不可删除；自定义微锚可以新建、编辑、保存和删除，也可以从默认项复制后再改。保存库全局复用，启用和选择按模型配置；不保存微锚历史版本，不为微锚维护本地会话状态。
6. 默认微锚文本固定为：“回想你最开始的工作，那是很好的工作状态。以这样的状态完成接下来的工作。”产品 baseline 默认开启并选择该内置项。首次引入该 baseline 会重建既有请求历史，必须在界面和文档中突出缓存影响。
7. 启用后，Gateway 使用当前微锚状态，对第三方 Harness 传入的完整结构化历史做无状态、确定性重建：只在每一条第三方 `user` 消息的 content 末尾追加同一个微锚。历史 user turn 与最新 user turn 执行同一规则；Full Anchor bootstrap user、Gateway 生成的 harness bridge、continuation、assistant/tool/system/developer 消息均不得追加。第一版只处理 OpenAI Chat Completions。
8. 微锚历史重建与 Full Anchor 的 `anchor/bypass` 正交：先标识并变换第三方 user 历史，再组合 Full Anchor 与内部 bridge。Pro/Flash/Vision 的 split 配置按各自模型选择微锚点；single/all 的合并数据面按请求 model 使用同一份模型映射。
9. 修改当前有效微锚文本、切换到不同有效文本或改变开关，会使 Gateway 按新微锚点状态重建所有第三方历史 user turn，并可能导致 KV Cache 重新计算。恢复到此前的微锚点状态后，如果第三方历史、模型、Full Anchor、bridge、工具 schema 等其他输入也一致，Provider 仍可能复用此前缓存；Gateway 不能主动删除 Provider 侧缓存。
10. Flash 与 Flash Vision 默认 Anchor 必须使用各自模型的真实接口生成。复用的是版本化的 Pro bootstrap system/task/tools/固定工具结果，不复制 Pro 的 reasoning、assistant 输出、tool call ID。候选必须包含最终 assistant 回复并通过模型归属、工具顺序、无宿主执行和指纹校验后才能保存为默认。

## A. 请求列表与消息/Anchor 查看语义纠偏

**边界**

- 在请求消息列表中分别高亮“缓存输入”和“缓存命中率”，保留未返回、零命中和有效命中的可辨状态。
- 重构共用对话块：模型消息内部明确分出“思维链”“正文”“工具调用”；工具结果标出对应工具和调用关系。
- 对 `cat -n` 风格结果做只读展示格式化，消除大块无意义前导空白，不修改保存内容。
- 为锚定提示词、continuation、Anchor 查看器各统计项和工具状态增加支持 hover 与键盘 focus 的说明入口，并给出通常填写示例。
- Builder 默认 continuation 改为中性桥接；移除行为约束，允许留空。

**不改**

- 不篡改旧 Pro Artifact，不为旧格式补造 `#7 assistant`。
- 不改变 token/cache 的服务端统计口径。

**完成标准**

- 用户无需了解 OpenAI role 细节也能区分请求、模型思维链、工具调用、工具结果和最终回复。
- `#2/#3/#5/#6` 的含义在界面内有明确说明；行号输出不再出现夸张空白。
- 新建 Anchor 不会自动带入被否决的行为约束。

## B. Anchor 名称、目录分类与保存生命周期

**边界**

- Candidate 选用并保存时要求填写显示名称；后端校验长度、控制字符、同模型重名和 HTML 安全。
- `displayName` 写入新 Artifact 并受指纹保护；旧 Artifact 回退显示 `id`。
- 服务端生成机器 id/path；用户名称绝不直接成为路径。
- Catalog 在普通列表中同时展示模型默认与用户保存项，并用徽标区分；两者都能合法选择、绑定和只读查看。
- `dsh-minimal-two-tool-v1.json` 标记为实验 control，排除出产品普通列表和绑定下拉，但继续供实验、测试和开发检查使用，不删除文件。
- Builder 的目标模型选择器旁增加“查看该模型示例 Anchor”按钮；按钮按当前选择打开该模型默认 Anchor。Pro 立即可用，Flash/Vision 在 E 块真实默认落盘前显示“尚无模型原生示例”并禁用，禁止回退展示 Pro 或 control Artifact。
- 内容读取白名单与普通列表可见性分离，避免隐藏 control 后破坏开发检查，也避免默认项被误判为 orphan。
- 用户界面统一使用“保存/已保存”，不再把内部 freeze 术语当产品概念。

**不改**

- 不允许覆盖现有 Artifact；不提供保存后原地重命名。
- 不把列表隐藏等同于读取拒绝。

**完成标准**

- 同模型下用户能靠名称区分多个 Anchor；重名和非法名称返回可理解错误。
- 内置默认 Anchor 在普通列表中正常显示、选择和只读查看，不会被标成 orphan；实验 control 不再伪装成第二个可选 Pro Anchor；Builder 按目标模型打开对应默认示例。

## C. 微锚点独立模块、第三方历史重建与 Full Anchor 组合

**边界**

- 新建独立微锚点领域模块：固定只读默认项、自定义项 CRUD、定义校验、内容指纹、结构化 user content 末尾追加和第三方历史重建。
- 扩展 managed config：保存全局自定义定义库，以及 Pro/Flash/Vision 各自的 enabled + selected id；默认项来自代码且不写入可编辑定义库。兼容旧 schema，不保存 revision 或历史版本。
- 新建统一 Chat Completions 历史重建层，覆盖微锚开/关 × Full Anchor/bypass 四种组合；先克隆并标识第三方消息来源，只修改 `origin=third-party && role=user` 的 content，再交给 Full Anchor 组合层。不得在最终 messages 上无来源地区分地扫描所有 `user`。
- 对字符串 content 固定追加 `\n\n` + 微锚；对 OpenAI Chat Completions 多模态 content 数组保留原有 text/image 顺序和对象，只在数组末尾新增 text part。不得使用 `contentToText()` 把 Vision 内容写回字符串；遇到无法安全变换的 user content 整单返回明确错误，不能只跳过部分历史。
- Full Anchor trajectory、bootstrap user、内部 harness bridge 和 continuation 必须逐字保持原样；bypass 下只得到被重建的第三方历史。
- 请求热路径使用启动/热应用时生成的不可变快照，不逐请求读磁盘。
- 微锚点变更需事务式重配所有引用它的运行 Profile；失败时回滚配置和已切换实例。
- single/all 合并数据面按请求 model 选择微锚点；非 Chat Completions 不注入并在诊断中明确。
- 诊断记录微锚点 id、enabled、当前内容指纹、实际追加的第三方 user 数量和第三方历史变换指纹，但不泄露正文或图像内容。
- 输入契约是第三方 Harness 每轮提供其未被 Gateway 注入的结构化历史；Gateway 自身不保存完整聊天记录。同一个原始 user 恰好以微锚文本结尾时仍按规则追加一次，不用后缀猜测“是否已经注入”；双 Gateway 串联或回传已变换历史不在透明输入契约内。

**缓存约束**

- 不加入随机 cache-buster、时间戳、隐藏 revision 或其他动态文本；分隔符和默认文本必须字节级固定。
- 界面使用文档基线警告：“修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。”不得宣称已清除 Provider 缓存。
- 切换两个 id 但有效文本字节完全相同时，不应谎报上游历史已经变化；恢复此前微锚点状态时按第 9 条说明可能重新命中此前缓存谱系。

**完成标准**

- 相同当前微锚点状态与字节等价的第三方完整历史必然生成字节等价的上游 messages；配置不变且第三方历史正常延伸时，上一轮已变换历史成为下一轮结果的相同前段。
- 状态变化时，所有第三方历史 user turn 用当前状态同步重建；关闭后所有微锚后缀同时消失，不是只影响下一轮。
- Gateway 不需要保存聊天历史，但缓存连续性仍要求 Harness 回传完整且一致的未注入历史；截断、摘要替换或只发最新一轮时不保证历史缓存连续。
- 最新消息为 assistant/tool 时只重建此前的 user，不向工具结果或模型消息追加，也不虚构一个新的近场 user。
- Full Anchor bootstrap user 和内部 bridge 的内容与数量不受微锚影响。
- 默认微锚固定只读且不可删除；自定义微锚可编辑保存。删除被 Profile 选中的自定义项返回冲突，必须先切换选择，不静默回退。

## D. 微锚点管理 UI 与缓存风险说明

**边界**

- 微锚点作为独立管理模块展示，不嵌进 Full Anchor Builder。
- 支持新建、编辑、保存、删除自定义微锚点；内置默认项既没有编辑入口，也没有删除入口，提供“复制为自定义”以承接额外 steering。
- 每个模型启动配置可选择已保存微锚点并独立开关。
- 编辑当前使用项、切换选择或改变开关时，在操作前与保存结果处醒目标明缓存影响。
- 增加只读查看、当前引用模型、当前内容指纹和生效状态，不展示不存在的 revision/version 语义。

**完成标准**

- 用户可以通过自定义项完全控制微锚点提示词，并清楚知道哪一个会被固定追加到哪个模型的每条第三方历史 user 消息末尾。
- UI 不把微锚点描述成 Full Anchor 的 continuation，也不承诺清理 Provider 缓存。

## E. Flash 与 Flash Vision 模型原生默认 Artifact

**前置门槛**

- A/B 已确定中性 continuation、命名和默认项分类。
- 本地假上游测试证明两个目标模型每一轮都使用精确 model id，且请求中没有 Pro assistant 输出。
- dry-run 给出候选数、最大调用次数和费用风险；真实调用需要该块 Edit 授权。

**执行边界**

- 先 Flash、后 Flash Vision，串行调用各自配置的真实上游接口。
- 复用版本化 bootstrap fixture；固定工具结果仍由内存状态机返回，不执行宿主命令。
- 人工审查完整候选后再 create-only 保存；验收至少包括：精确模型归属、bash→editor 顺序、最终 assistant、无 unsafe attempt、指纹正确。
- 保存为模型默认类别和固定显示名称，再分别绑定并做小流量 canary；失败时保持原 bypass/空路径，不复制其他模型输出兜底。
- Flash/Flash Vision 默认落盘后进入普通 Anchor 列表，并成为 Builder 选择相应模型时的示例对象。
- 新安装默认路径与当前本机 managed config 的绑定分开处理，避免半成功状态。

**完成标准**

- 仓库拥有 Flash 与 Flash Vision 各自真实生成、可验证、完整对话的默认 Artifact。
- Loader 拒绝跨模型、copied baseline、缺最终 assistant 或指纹错误的默认项。

## F. 集成回归与开发文档

**边界**

- 更新 README、`docs/architecture.md`、`anchors/README.md`；保留根目录 `DeepSeek-Flash-Gateway-锚定方案(2).md` 作为原始设计输入，另建 `docs/micro-anchor.md`，在引用原方案和保留设计动机的前提下整理成适配当前实现的开发文档。
- 以用户本轮纠正覆盖 v0.2 中“默认微锚可编辑、可在默认后直接叠加”的旧描述：默认固定只读；额外 steering 通过复制/新建自定义项完成。
- 文档包含：第三方 user 全历史无状态重建、Full Anchor bootstrap/bridge 排除、多模态 content part 追加、Profile/combined 行为、自定义 CRUD、缓存重算与恢复此前微锚点状态的准确含义、真实默认 Anchor 生成/回滚流程。
- 明确 Gateway 自身不保存完整聊天记录，但 KV Cache 连续性依赖 Harness 回传完整且一致的未注入历史；不得继续写成“不回传完整历史也能稳定命中”。
- 记录 Anchor 列表规则：内置默认可混排；实验 control 隐藏；Builder 按当前目标模型查看对应默认示例。
- 清理旧文档中“仅 Pro 有默认”“continuation 必填且带行为约束”“实验 control 与产品 Anchor 混排”等过时描述。
- 执行跨块回归，核对启动、热应用、Anchor/bypass、single/split/all、诊断和 WebUI。

**完成标准**

- 文档与实际配置/API/界面一致；不存在暗含 Provider 缓存清除能力的表述。
- 所有实际修改文件通过自检，无无关格式化、临时结果、Key 或真实响应内容进入仓库。

## 依赖与建议顺序

建议顺序：A → B → C → D → E → F。

- A 先把用户当前看到的协议语义和默认 continuation 纠正。
- B 固定 Artifact 名称与目录分类，E 才能安全落盘为默认。
- C 先完成微锚点的第三方历史重建和运行时语义，D 再接管理 UI，避免前端先定义错误能力。
- E 必须在代码、测试和默认项分类稳定后才进行真实付费生成。
- F 最后统一回归和收口文档。

## 计划节奏

用户已选择乙：一次性完成 A–F 全部施工级落地 plan 和测试方案，审阅后一次授权，再按依赖顺序施工。任何真实上游调用、范围扩大、模型返回异常或缓存语义分裂都必须暂停上报。
