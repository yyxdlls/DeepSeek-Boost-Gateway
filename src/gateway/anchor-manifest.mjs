import { basename, relative, resolve, sep } from 'node:path'

export const ANCHOR_DISPLAY_NAME_MAX_LENGTH = 80

const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

export const ANCHOR_MANIFEST = Object.freeze([
  Object.freeze({
    fileName: 'deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json',
    path: 'anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json',
    id: 'deepseek-v4-pro-open-workstream-20260824101411-f2a74161',
    model: 'deepseek-v4-pro',
    category: 'default',
    displayName: 'DeepSeek V4 Pro 默认 Anchor',
    productVisible: true,
    selectable: true,
    expectedFingerprint: '032864c5f60fe86802f53b4a3ff88c48befccbf385d9e0628920f4f10496b763',
  }),
  Object.freeze({
    fileName: 'deepseek-v4-flash-open-workstream-20260824101819-8a8a3211.json',
    path: 'anchors/deepseek-v4-flash-open-workstream-20260824101819-8a8a3211.json',
    id: 'deepseek-v4-flash-open-workstream-20260824101819-8a8a3211',
    model: 'deepseek-v4-flash',
    category: 'default',
    displayName: 'DeepSeek V4 Flash 默认 Anchor',
    productVisible: true,
    selectable: true,
    expectedFingerprint: '8d2fe371c37647b07f3e388686db3f8ff764ca7842e06a0f132e643b71cd1753',
  }),
  Object.freeze({
    fileName: 'deepseek-v4-flash-vision-exp-open-workstream-20260824102129-7cdd27aa.json',
    path: 'anchors/deepseek-v4-flash-vision-exp-open-workstream-20260824102129-7cdd27aa.json',
    id: 'deepseek-v4-flash-vision-exp-open-workstream-20260824102129-7cdd27aa',
    model: 'deepseek-v4-flash-vision-exp',
    category: 'default',
    displayName: 'DeepSeek V4 Flash Vision 默认 Anchor',
    productVisible: true,
    selectable: true,
    expectedFingerprint: 'a7578b003796c2936d597aefbd0a48a412dc004fa1a49912bef59240aaa67338',
  }),
  Object.freeze({
    fileName: 'dsh-minimal-two-tool-v1.json',
    path: 'anchors/dsh-minimal-two-tool-v1.json',
    id: 'dsh-minimal-two-tool-v1',
    model: 'deepseek-v4-pro',
    category: 'control',
    displayName: 'DeepSeek V4 Pro two-tool control',
    productVisible: false,
    selectable: false,
    expectedFingerprint: '81ad9c24a57b7583b30aa24553c14e92fca69683ea0c9e814ee1dc59dbc5a601',
  }),
])

function portablePath(path) {
  return path.split(sep).join('/')
}

export function portableAnchorPath(path) {
  return portablePath(relative(process.cwd(), resolve(path)))
}

export function findAnchorManifestEntry(absolutePath) {
  if (!absolutePath) return null
  const portable = portableAnchorPath(absolutePath)
  return ANCHOR_MANIFEST.find((entry) => entry.path === portable) ?? null
}

export function displayNameError(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.type = 'gateway_anchor_display_name_invalid'
  return error
}

export function normalizeAnchorDisplayName(value) {
  if (value === undefined || value === null) {
    throw displayNameError('displayName is required.')
  }
  if (typeof value !== 'string') {
    throw displayNameError('displayName must be a string.')
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized.length < 1 || normalized.length > ANCHOR_DISPLAY_NAME_MAX_LENGTH) {
    throw displayNameError(
      `displayName must contain 1 to ${ANCHOR_DISPLAY_NAME_MAX_LENGTH} characters after trimming.`,
    )
  }
  if (CONTROL_OR_BIDI.test(normalized)) {
    throw displayNameError('displayName must not contain control or bidirectional characters.')
  }
  return normalized
}

export function comparableAnchorDisplayName(value) {
  return String(value ?? '').normalize('NFC').trim()
}

export function nameReservationKey(model, displayName) {
  return `${String(model ?? '')}\0${comparableAnchorDisplayName(displayName)}`
}

export function classifyAnchorArtifact(absolutePath, artifact) {
  if (artifact?.verification?.copiedBaseline) {
    return {
      excluded: true,
      reason: 'copiedBaseline',
      category: 'copiedBaseline',
      displayName: artifact.displayName ?? artifact.id ?? basename(String(absolutePath ?? '')),
      selectable: false,
      productVisible: false,
      bundledDefault: false,
    }
  }
  const manifest = findAnchorManifestEntry(absolutePath)
  if (manifest) {
    return {
      excluded: false,
      category: manifest.category,
      displayName: artifact.displayName ?? manifest.displayName,
      selectable: manifest.selectable,
      productVisible: manifest.productVisible,
      bundledDefault: manifest.category === 'default',
    }
  }
  return {
    excluded: false,
    category: 'user',
    displayName: artifact.displayName ?? artifact.id,
    selectable: true,
    productVisible: true,
    bundledDefault: false,
  }
}
