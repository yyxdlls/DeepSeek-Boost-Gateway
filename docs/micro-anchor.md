# 微锚点（Micro-Anchor）当前实现

本文档描述 Gateway 当前对**微锚点**的实现（2026-08-24），是面向当前行为的事实源。早期设计备忘已归档删除；与旧表述不一致处，以本文「已裁决差异」为准。

## 1. 概念

微锚点是一个很短的正文文本，由 Gateway 在**每条第三方 Harness 提交的 user 消息末尾**确定性追加，之后才交给 Full Anchor 组合或上游。它与模型配置里的「增强模式 / Anchor Artifact」（Full Anchor）相互独立：

- 模型配置中的 `enhancementMode`（`anchor` / `bypass`）与 `anchorPath` 控制 **Full Anchor**（完整轨迹回放）；
- 微锚点开关 `microAnchor.enabled` 与 `microAnchor.selectedId` 控制**每轮 user 消息末尾追加的短文本**；
- `x-deepseek-boost-mode: bypass` 只绕过 Full Anchor，不改变微锚点设置。

微锚点不是 continuation，也不是 Anchor 的一部分；页面与文档不把它们混称。

## 2. 内置默认微锚点

```text
id:     builtin:initial-work-recall-v1
name:   默认微锚点
content: 回想你最开始的工作，那是很好的工作状态。以这样的状态完成接下来的工作。
readonly: true
deletable: false
```

- 产品 baseline：每个模型默认 `enabled=true` 并选择该内置项（v1 配置在迁移后按此解析）。
- 内置项不写入可编辑定义库，由 API 合并后返回；**固定只读**，不提供编辑/删除。
- 不存在 revision/version；内容指纹每次从规范化后的实际正文计算（SHA-256，UTF-8）。

## 3. 自定义定义

- 用户可以新建、编辑、删除自定义微锚点，也可以把默认微锚点「复制为自定义」（服务端读取默认正文，浏览器正文副本不参与保存）。
- 名称：NFC + trim 后 1–80 字符，全局规范化名称唯一，拒绝控制字符和双向覆盖字符；存储合法原文，前端统一 escape。
- 正文：CRLF 规范化为 LF，`trim()` 后不得为空，最多 4000 字符；保留其余用户空格与换行。
- 被任一模型选中（`selectedId` 指向）时禁止删除；删除冲突返回 409，并列出引用它的具体模型，不自动回落默认。
- 微锚点定义与正文不进入 `process.env`，不扩展 `ENV_FIELDS`；运行时快照只从 managed document 与内置默认解析。

## 4. 每模型配置

模型是 Pro / Flash / Vision 三个配置 Profile，每个都有独立：

- `enabled`：是否注入微锚点；
- `selectedId`：使用哪个定义（内置或自定义）；
- 生效指纹（`effectiveFingerprint`）：启用时 = 所选项正文指纹，关闭时为 `null`。

配置通过既有 `PATCH /__gateway/config/profiles/:profile` 提交：

```json
{ "microAnchor": { "enabled": true, "selectedId": "builtin:initial-work-recall-v1" } }
```

- split/all：保存后按影响范围重建对应数据面，配置与运行快照一致；
- single：配置原子落盘，有效映射变化时返回 `restartRequired: true, pendingRestart: true`，下次启动生效（WebUI 显示「已保存，重启后生效」）；
- 非法 `selectedId` 在保存/启动时 fail closed，绝不静默回落默认。

## 5. 请求历史重建

输入契约：Harness 每次提交未被 Gateway 注入的结构化历史；Gateway 自身不保存聊天（无状态）。流程：

```text
原始第三方 messages
  → 克隆并保留第三方来源
  → 若微锚开启，只处理 role=user
  → 再交给 Full Anchor 组合
```

- 字符串内容：`${originalContent}\n\n${microAnchorText}`。
- content 数组：只接受**非空数组**，且每个 part 都是非 null 普通对象并含非空字符串 `type`；允许保留未知但结构合法的 type。所有原 part 与顺序保留，在末尾追加 `{ "type": "text", "text": "\n\n<M>" }`；不 stringify、不改 image/data URI/detail、不改已有文本 part。空数组、裸字符串 part、数组 part、null 或缺失 type 的对象整单拒绝。
- 空字符串按字符串规则处理，结果为 `"\n\n<M>"`。
- 其他 user content 类型：微锚开启时整单返回 `gateway_micro_anchor_unsupported_user_content`（HTTP 400），不部分跳过；关闭时透明转发。
- 每次无条件对第三方原始 user 追加一次，不用后缀猜测是否已注入——用户正文恰好以 `M` 结尾时会再追加一次。
- Full Anchor bootstrap user、内部 harness bridge、continuation、system/developer/assistant/tool 均**不处理**。
- 最新消息为 assistant/tool 时只重建此前 user，不伪造新的 user。

四组合（微锚 × Full 模式）：

| 微锚 | Full 模式 | 上游消息 |
|---|---|---|
| 关 | bypass | 原始第三方历史 |
| 开 | bypass | 第三方所有 user 为 `Uᵢ + M` |
| 关 | anchor | Full trajectory → bridge → 第三方会话 |
| 开 | anchor | Full trajectory → bridge → 第三方会话，其中所有第三方 user 为 `Uᵢ + M` |

诊断 metrics 并入现有 `transformation`：

```json
{
  "microAnchor": {
    "enabled": true, "id": "...", "source": "builtin",
    "contentFingerprint": "sha256", "applied": true,
    "appliedUserMessageCount": 3, "stringUserMessageCount": 2,
    "multipartUserMessageCount": 1, "reason": "applied"
  },
  "thirdPartyHistoryFingerprint": "sha256"
}
```

不保存微锚正文、图像内容或不存在的 revision。`thirdPartyHistoryFingerprint` 是「微锚变换后、交给 Full Anchor 前」第三方 messages 规范 JSON 的 SHA-256。

## 6. 缓存语义（统一文案）

> 修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。Gateway 不会清除 Provider 侧缓存；恢复到此前的微锚点状态后，如果其他请求输入也一致，Provider 仍可能复用此前缓存。

- 两个 ID 的有效文本字节完全相同时，切换不改变上游历史，不提示「缓存已失效」。
- Gateway 不保存聊天，但缓存连续性要求 Harness 回传**完整且一致**的未注入历史；截断、摘要替换或只发最新轮时不承诺连续命中。

## 7. 管理 API

- `GET /__gateway/micro-anchors`：默认+自定义定义、内容指纹、引用模型、各模型 `enabled/selectedId/effectiveFingerprint` 与固定缓存警告文案。
- `POST /__gateway/micro-anchors`：`{ name, content }` 或 `{ name, copyFromId }`；复制默认时服务端读取默认正文。
- `PATCH /__gateway/micro-anchors/:id`：`{ name?, content? }`；内置项返回 409。
- `DELETE /__gateway/micro-anchors/:id`：内置项或被引用项返回 409 并带 `referencedBy`。
- `PATCH /__gateway/config/profiles/:profile`：`{ microAnchor: { enabled, selectedId } }`。
- 所有写操作要求同源 JSON mutation marker；错误保持结构化 `type/message/status`。mutation 统一返回 `{ documentView, affectedProfiles, effectiveChanged, restartRequired, pendingRestart }`。

## 8. 与早期设计备忘的已裁决差异

| 早期设计备忘的表述 | 当前实现 |
|---|---|
| 默认微锚点可编辑 | 默认项固定只读；额外 steering 只能通过复制/新建自定义项 |
| 「每轮末尾轻量召回」 | 不实现滚动召回；改为所有第三方历史 user 末尾确定性追加 |
| 微锚可参与 InternalMessage / 长轨迹锚定 | InternalMessage、长轨迹（10–15k token）锚定作为未来实验，不伪装成已实现 |
| 隐式会话状态 | Gateway 无状态；完全依赖 Harness 回传完整且一致的未注入历史 |
| 单篇文本模型 | 多模态 user content 由 parts 规则处理：保留原 part、追加尾部 text part、非法 content 整单拒绝 |
| 缓存失效凭感觉判断 | 以**有效文本字节等价**为准：正文/选中项/开关变化对比生效指纹，等价则不报警 |

另外两项约束：

- 微锚点正文不进入 `process.env`，无 revision/version、无 cache-buster；页面不显示修订版本号。
- Flash / Flash Vision 尚无模型原生默认 Anchor（见 [README](../README.md) 的生成流程说明）；微锚点默认值与 Full Anchor 默认是两件事，不互相依赖。
