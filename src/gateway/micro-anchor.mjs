import { createHash, randomUUID } from 'node:crypto'

export const BUILTIN_MICRO_ANCHOR_ID = 'builtin:initial-work-recall-v1'
export const BUILTIN_MICRO_ANCHOR_NAME = '默认微锚点'
export const BUILTIN_MICRO_ANCHOR_CONTENT =
  '回想你最开始的工作，那是很好的工作状态。以这样的状态完成接下来的工作。'
export const MICRO_ANCHOR_NAME_MAX_LENGTH = 80
export const MICRO_ANCHOR_CONTENT_MAX_LENGTH = 4000
export const MICRO_ANCHOR_CACHE_WARNING =
  '修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。Gateway 不会清除 Provider 侧缓存；恢复到此前的微锚点状态后，如果其他请求输入也一致，Provider 仍可能复用此前缓存。'

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const CUSTOM_ID_PATTERN = /^ma_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function microAnchorError(statusCode, type, message, extra = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.type = type
  Object.assign(error, extra)
  return error
}

export function defaultMicroAnchorSelection() {
  return {
    enabled: true,
    selectedId: BUILTIN_MICRO_ANCHOR_ID,
  }
}

export function microAnchorContentFingerprint(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
}

export function builtinMicroAnchor() {
  return Object.freeze({
    id: BUILTIN_MICRO_ANCHOR_ID,
    name: BUILTIN_MICRO_ANCHOR_NAME,
    content: BUILTIN_MICRO_ANCHOR_CONTENT,
    readonly: true,
    deletable: false,
    source: 'builtin',
    contentFingerprint: microAnchorContentFingerprint(BUILTIN_MICRO_ANCHOR_CONTENT),
  })
}

export function normalizeMicroAnchorName(value) {
  if (value === undefined || value === null) {
    throw microAnchorError(400, 'gateway_micro_anchor_name_invalid', 'Micro-anchor name is required.')
  }
  if (typeof value !== 'string') {
    throw microAnchorError(400, 'gateway_micro_anchor_name_invalid', 'Micro-anchor name must be a string.')
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized.length < 1 || normalized.length > MICRO_ANCHOR_NAME_MAX_LENGTH) {
    throw microAnchorError(
      400,
      'gateway_micro_anchor_name_invalid',
      `Micro-anchor name must contain 1 to ${MICRO_ANCHOR_NAME_MAX_LENGTH} characters after trimming.`,
    )
  }
  if (CONTROL_OR_BIDI.test(normalized)) {
    throw microAnchorError(
      400,
      'gateway_micro_anchor_name_invalid',
      'Micro-anchor name must not contain control or bidirectional characters.',
    )
  }
  return normalized
}

export function comparableMicroAnchorName(value) {
  return String(value ?? '').normalize('NFC').trim()
}

export function normalizeMicroAnchorContent(value) {
  if (value === undefined || value === null) {
    throw microAnchorError(400, 'gateway_micro_anchor_content_invalid', 'Micro-anchor content is required.')
  }
  if (typeof value !== 'string') {
    throw microAnchorError(400, 'gateway_micro_anchor_content_invalid', 'Micro-anchor content must be a string.')
  }
  const normalized = value.replace(/\r\n/g, '\n')
  if (normalized.trim() === '') {
    throw microAnchorError(
      400,
      'gateway_micro_anchor_content_invalid',
      'Micro-anchor content must not be empty after trimming.',
    )
  }
  if (normalized.length > MICRO_ANCHOR_CONTENT_MAX_LENGTH) {
    throw microAnchorError(
      400,
      'gateway_micro_anchor_content_invalid',
      `Micro-anchor content must contain at most ${MICRO_ANCHOR_CONTENT_MAX_LENGTH} characters.`,
    )
  }
  return normalized
}

export function isBuiltinMicroAnchorId(id) {
  return id === BUILTIN_MICRO_ANCHOR_ID
}

export function isCustomMicroAnchorId(id) {
  return CUSTOM_ID_PATTERN.test(String(id ?? ''))
}

export function createCustomMicroAnchorId() {
  return `ma_${randomUUID()}`
}

function unsupportedUserContent(message) {
  return microAnchorError(400, 'gateway_micro_anchor_unsupported_user_content', message)
}

export function assertMultipartUserContent(content) {
  if (!Array.isArray(content) || content.length === 0) {
    throw unsupportedUserContent('User content array must be a non-empty list of typed parts.')
  }
  for (const part of content) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      throw unsupportedUserContent('Each user content part must be a non-null plain object.')
    }
    if (typeof part.type !== 'string' || part.type.trim() === '') {
      throw unsupportedUserContent('Each user content part must include a non-empty string type.')
    }
  }
}

export function appendMicroAnchorToUserContent(content, microAnchorText) {
  const suffix = String(microAnchorText ?? '')
  if (typeof content === 'string') return `${content}\n\n${suffix}`
  assertMultipartUserContent(content)
  return [
    ...content.map((part) => structuredClone(part)),
    { type: 'text', text: `\n\n${suffix}` },
  ]
}

export function disabledMicroAnchorSnapshot() {
  return {
    enabled: false,
    id: null,
    source: null,
    name: null,
    content: '',
    contentFingerprint: null,
    applied: false,
    reason: 'disabled',
  }
}

export function snapshotFromDefinition(definition, enabled) {
  const builtin = isBuiltinMicroAnchorId(definition.id)
  return {
    enabled: Boolean(enabled),
    id: definition.id,
    source: builtin ? 'builtin' : 'custom',
    name: definition.name,
    content: definition.content,
    contentFingerprint: definition.contentFingerprint
      ?? microAnchorContentFingerprint(definition.content),
    readonly: Boolean(definition.readonly ?? builtin),
    deletable: definition.deletable === false || builtin ? false : true,
    applied: Boolean(enabled),
    reason: enabled ? 'applied' : 'disabled',
  }
}

export function resolveMicroAnchorDefinition(definitions, id) {
  if (isBuiltinMicroAnchorId(id)) return { ...builtinMicroAnchor() }
  if (!isCustomMicroAnchorId(id) || !isRecord(definitions) || !isRecord(definitions[id])) {
    throw microAnchorError(
      400,
      'gateway_micro_anchor_selected_id_invalid',
      `Unknown micro-anchor: ${id}`,
    )
  }
  const entry = definitions[id]
  const name = typeof entry.name === 'string' ? entry.name : ''
  const content = typeof entry.content === 'string' ? entry.content : ''
  return {
    id,
    name,
    content,
    readonly: false,
    deletable: true,
    source: 'custom',
    contentFingerprint: microAnchorContentFingerprint(content),
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  }
}

export function resolveMicroAnchorSnapshot(definitions, selection) {
  const resolved = {
    ...defaultMicroAnchorSelection(),
    ...(isRecord(selection) ? selection : {}),
  }
  const definition = resolveMicroAnchorDefinition(definitions, resolved.selectedId)
  return snapshotFromDefinition(definition, resolved.enabled !== false)
}

export function collectMicroAnchorReferences(profiles, id) {
  const referenced = []
  if (!isRecord(profiles)) return referenced
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isRecord(profile?.microAnchor)) continue
    if (profile.microAnchor.selectedId === id) referenced.push(name)
  }
  return referenced
}

export function assertUniqueMicroAnchorName(definitions, name, exceptId = null) {
  const comparable = comparableMicroAnchorName(name)
  if (comparable === comparableMicroAnchorName(BUILTIN_MICRO_ANCHOR_NAME) && exceptId !== BUILTIN_MICRO_ANCHOR_ID) {
    throw microAnchorError(
      409,
      'gateway_micro_anchor_name_conflict',
      'A micro-anchor with this name already exists.',
    )
  }
  for (const [id, entry] of Object.entries(isRecord(definitions) ? definitions : {})) {
    if (id === exceptId) continue
    if (comparableMicroAnchorName(entry?.name) === comparable) {
      throw microAnchorError(
        409,
        'gateway_micro_anchor_name_conflict',
        'A micro-anchor with this name already exists.',
      )
    }
  }
}

export function createCustomMicroAnchor(definitions, input, now = new Date().toISOString()) {
  const source = isRecord(input) ? input : {}
  const name = normalizeMicroAnchorName(source.name)
  let content
  if (source.copyFromId !== undefined) {
    const copied = resolveMicroAnchorDefinition(definitions, source.copyFromId)
    content = copied.content
  } else {
    content = normalizeMicroAnchorContent(source.content)
  }
  assertUniqueMicroAnchorName(definitions, name)
  const id = createCustomMicroAnchorId()
  return {
    id,
    definition: {
      name,
      content,
      createdAt: now,
      updatedAt: now,
    },
  }
}

export function updateCustomMicroAnchor(definitions, id, patch, now = new Date().toISOString()) {
  if (isBuiltinMicroAnchorId(id)) {
    throw microAnchorError(409, 'gateway_micro_anchor_readonly', 'The built-in micro-anchor cannot be edited.')
  }
  const current = resolveMicroAnchorDefinition(definitions, id)
  const source = isRecord(patch) ? patch : {}
  const name = source.name === undefined ? current.name : normalizeMicroAnchorName(source.name)
  const content = source.content === undefined
    ? current.content
    : normalizeMicroAnchorContent(source.content)
  assertUniqueMicroAnchorName(definitions, name, id)
  return {
    name,
    content,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
  }
}

export function deleteCustomMicroAnchor(definitions, profiles, id) {
  if (isBuiltinMicroAnchorId(id)) {
    throw microAnchorError(409, 'gateway_micro_anchor_readonly', 'The built-in micro-anchor cannot be deleted.')
  }
  resolveMicroAnchorDefinition(definitions, id)
  const referencedBy = collectMicroAnchorReferences(profiles, id)
  if (referencedBy.length > 0) {
    throw microAnchorError(
      409,
      'gateway_micro_anchor_in_use',
      `Micro-anchor is referenced by: ${referencedBy.join(', ')}.`,
      { referencedBy },
    )
  }
  return referencedBy
}

function emptyMicroAnchorMetrics(snapshot, reason) {
  return {
    enabled: Boolean(snapshot?.enabled),
    id: snapshot?.id ?? null,
    source: snapshot?.source ?? null,
    contentFingerprint: snapshot?.contentFingerprint ?? null,
    applied: false,
    appliedUserMessageCount: 0,
    stringUserMessageCount: 0,
    multipartUserMessageCount: 0,
    reason,
  }
}

export function rebuildThirdPartyUserHistory(messages, snapshot) {
  if (!Array.isArray(messages)) {
    throw microAnchorError(400, 'gateway_micro_anchor_unsupported_user_content', 'Chat messages must be an array.')
  }
  const cloned = structuredClone(messages)
  const origins = cloned.map(() => 'third-party')
  const enabled = Boolean(snapshot?.enabled) && Boolean(snapshot?.content)
  if (!enabled) {
    return {
      messages: cloned,
      origins,
      metrics: emptyMicroAnchorMetrics(snapshot, snapshot?.enabled ? 'empty' : 'disabled'),
    }
  }

  const text = snapshot.content
  let appliedUserMessageCount = 0
  let stringUserMessageCount = 0
  let multipartUserMessageCount = 0
  for (const message of cloned) {
    if (message?.role !== 'user') continue
    if (typeof message.content === 'string') {
      message.content = appendMicroAnchorToUserContent(message.content, text)
      stringUserMessageCount += 1
      appliedUserMessageCount += 1
      continue
    }
    if (Array.isArray(message.content)) {
      message.content = appendMicroAnchorToUserContent(message.content, text)
      multipartUserMessageCount += 1
      appliedUserMessageCount += 1
      continue
    }
    throw unsupportedUserContent(
      'Enabled micro-anchor only accepts string or non-empty typed multipart user content.',
    )
  }

  return {
    messages: cloned,
    origins,
    metrics: {
      enabled: true,
      id: snapshot.id,
      source: snapshot.source,
      contentFingerprint: snapshot.contentFingerprint,
      applied: appliedUserMessageCount > 0,
      appliedUserMessageCount,
      stringUserMessageCount,
      multipartUserMessageCount,
      reason: appliedUserMessageCount > 0 ? 'applied' : 'no_user_messages',
    },
  }
}

export function thirdPartyHistoryFingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages ?? [])).digest('hex')
}

export function stripInternalMessageFields(message) {
  if (!isRecord(message)) return message
  const { _origin, origin, ...rest } = message
  return rest
}
