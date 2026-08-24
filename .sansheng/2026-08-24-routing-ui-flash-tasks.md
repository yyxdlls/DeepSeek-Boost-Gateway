# 单端口路由 / 请求详情 / Flash 默认锚点 · 顶层任务清单

## 规模

不是局部单元。拆成 4 块。理解难度高、结构复杂度高。

配置：主判断 + 复核 + 强执行 + 弱执行。测试档：A/B 为 T2，C 为 T3，D 为 T4（真实上游另计）。

用户未选计划节奏 → 按甲（逐块授权）。本轮已确认：C 这轮就做；D 真实打上游。

## 已裁决

1. 单数据端口只是中转：按 `request.model` 选用该模型自己的 Key / 上游 / 增强模式 / Anchor / 微锚。逻辑不合并。
2. 「全部开启」的多模型端口同样是路由分发；额外再开三个单模型端口。8646 不是合并逻辑面。
3. 清理 404：当前 `deployment.mode=single`，DELETE 只挂在 split/all 管理面。
4. 两个 Flash 默认必须各自真实生成，不复制 Pro 输出。
5. 不把 `gateway.config.json` 里的 Key 写入仓库、过程文档或汇报。

## 块

| 块 | 边界 | 依赖 | 完成标准 | 建议执行 |
|---|---|---|---|---|
| A | 清理 DELETE 全拓扑可用；新请求原文可查看 | 无 | single 下能清空旧诊断；新 Chat 成功请求能打开原文 | 弱执行 |
| B | 请求详情/列表/锚点卡片文案与展示 | 无（可与 A 并行） | 见落地 plan B | 弱执行 |
| C | single / all 多模型口按模型路由；Builder 目标配置有三项 | A 后（清完再验新路由） | 三模型配置各自生效；下拉有 Pro/Flash/Vision；single 也能开工 | 强执行骨架 + 弱执行填充 |
| D | Flash / Flash Vision 真实默认 Anchor | C | 两份 native Artifact 落盘、登记、canary | 主判断放行调用；强执行验收候选 |

建议顺序：A → B → C → D。

## 不改

- 不改已有 Pro 默认 Artifact 内容
- 不把 control `dsh-minimal-two-tool-v1` 做成产品项
- 不把 Key、真实候选正文写入仓库
