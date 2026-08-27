import { once } from 'node:events'
import http from 'node:http'
import { join, resolve } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { transformChatCompletionsRequest } from './chat-request-transform.mjs'
import { RotatingJsonlWriter } from './jsonl-writer.mjs'
import { diagnosticEntry } from './diagnostic-history.mjs'
import {
  OpenAiResponseObserver,
  COT_MARKER_PROFILE,
  summarizeMessageTrajectory,
  summarizeResponseBody,
} from './trajectory-stats.mjs'
import { serveWebUiRequest } from './web-ui.mjs'
import { handleAnchorJobRoutes, handleProfileProbeRoute } from './management-routes.mjs'
import { DEFAULT_UPSTREAM_BASE_URL, GATEWAY_MODELS } from './runtime-config.mjs'

const OFFICIAL_MODELS = new Set(Object.values(GATEWAY_MODELS))

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const RESPONSE_HEADERS_TO_DROP = new Set([
  ...HOP_BY_HOP_HEADERS,
  // The upstream is requested with identity encoding. Drop these defensively
  // because fetch may transparently decode a non-compliant upstream response.
  'content-encoding',
])

const LOCAL_CONTROL_HEADERS = new Set([
  'x-deepseek-boost-mode',
  'x-gateway-management-token',
])

const CALLER_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
])

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function anchorModel(anchor) {
  return anchor?.artifact?.source?.model ?? anchor?.source?.model ?? null
}

function configuredMicroAnchors(options) {
  const snapshots = new Map()
  const source = options.microAnchors
  if (source instanceof Map) {
    for (const [model, snapshot] of source.entries()) {
      if (snapshot) snapshots.set(model, snapshot)
    }
  } else if (source && typeof source === 'object') {
    for (const [model, snapshot] of Object.entries(source)) {
      if (snapshot) snapshots.set(model, snapshot)
    }
  }
  return snapshots
}

function configuredAnchors(options) {
  const anchors = new Map()
  for (const [model, anchor] of Object.entries(options.anchors ?? {})) {
    if (!anchor) continue
    const sourceModel = anchorModel(anchor)
    if (sourceModel !== model) {
      throw new Error(
        `Anchor configured for ${model} was generated for ${sourceModel ?? '(unknown)'}.`,
      )
    }
    anchors.set(model, anchor)
  }
  if (options.anchor) {
    const model = anchorModel(options.anchor)
    if (!model) throw new Error('Gateway anchor artifact has no source model.')
    anchors.set(model, options.anchor)
  }
  return anchors
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function managementAuthorized(request, config) {
  if (!config.managementToken) return true
  const supplied = String(request.headers['x-gateway-management-token'] ?? '')
  const expectedBytes = Buffer.from(config.managementToken)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

function managementMutationAuthorized(request) {
  return request.headers['x-gateway-management-request'] === '1' &&
    /^application\/json(?:;|$)/i.test(String(request.headers['content-type'] ?? ''))
}

async function readManagementJson(request) {
  const body = await readRequestBody(request, 64 * 1024)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    const error = new Error('Management request body must be valid JSON.')
    error.statusCode = 400
    throw error
  }
}

function normalizedBasePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '/' ? '' : trimmed
}

export function buildUpstreamUrl(upstreamBaseUrl, incomingUrl) {
  const upstream = new URL(upstreamBaseUrl)
  const incoming = new URL(incomingUrl, 'http://gateway.local')
  let suffix = incoming.pathname

  // Harnesses normally receive a base URL ending in /v1. Treat that segment
  // as the local compatibility prefix; the configured upstream owns its own
  // version prefix (if any).
  if (suffix === '/v1') suffix = ''
  else if (suffix.startsWith('/v1/')) suffix = suffix.slice(3)

  const basePath = normalizedBasePath(upstream.pathname)
  const suffixPath = suffix && !suffix.startsWith('/') ? `/${suffix}` : suffix
  upstream.pathname = `${basePath}${suffixPath}` || '/'
  upstream.search = incoming.search
  upstream.hash = ''
  return upstream
}

export function rewriteUpstreamRequestModel(body, upstreamModel) {
  const target = String(upstreamModel ?? '').trim()
  if (!target || body == null) return body
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  if (buffer.length === 0) return body
  try {
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    if (!Object.prototype.hasOwnProperty.call(parsed, 'model')) return body
    if (parsed.model === target) return body
    return Buffer.from(JSON.stringify({ ...parsed, model: target }), 'utf8')
  } catch {
    return body
  }
}

function appendIncomingHeader(headers, name, value) {
  if (Array.isArray(value)) {
    for (const item of value) headers.append(name, item)
  } else if (value !== undefined) {
    headers.set(name, value)
  }
}

export function buildUpstreamHeaders(incomingHeaders, gatewayApiKey = '') {
  const headers = new Headers()
  for (const [rawName, value] of Object.entries(incomingHeaders)) {
    const name = rawName.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      LOCAL_CONTROL_HEADERS.has(name) ||
      CALLER_CREDENTIAL_HEADERS.has(name)
    ) continue
    appendIncomingHeader(headers, name, value)
  }

  headers.set('accept-encoding', 'identity')
  if (gatewayApiKey) headers.set('authorization', `Bearer ${gatewayApiKey}`)
  return { headers, credentialSource: gatewayApiKey ? 'gateway' : 'none' }
}

export function redactHeaders(headers) {
  const redacted = {}
  for (const [name, value] of headers.entries()) {
    redacted[name] = /authorization|api-key|token|secret/i.test(name)
      ? '[REDACTED]'
      : value
  }
  return redacted
}

export function redactUrl(value) {
  const url = new URL(value, 'http://gateway.local')
  for (const name of [...url.searchParams.keys()]) {
    if (/authorization|api[-_]?key|token|secret/i.test(name)) {
      url.searchParams.set(name, '[REDACTED]')
    }
  }
  if (url.origin === 'http://gateway.local') return `${url.pathname}${url.search}`
  return url.toString()
}

function maybeJson(text, contentType = '') {
  if (!text) return null
  if (!/json|event-stream/i.test(contentType) && !/^[\s]*[\[{]/.test(text)) {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function maybeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toolNames(tools) {
  return Array.isArray(tools)
    ? tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
    : []
}

function messageContentChars(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => {
    if (typeof part === 'string') return sum + part.length
    if (typeof part?.text === 'string') return sum + part.text.length
    return sum
  }, 0)
}

// Streaming chat-completions requests are re-issued with an explicit
// stream_options.include_usage so the terminal usage (and therefore prompt
// cache hit / input tokens) is reported back for local diagnostics. This only
// touches the forwarded upstream body, never the caller's view of the request.
function injectStreamUsage(payload, bodyText) {
  if (!payload || typeof payload !== 'object') return bodyText
  if (payload.stream !== true) return bodyText
  if (payload.stream_options?.include_usage === true) return bodyText
  const next = {
    ...payload,
    stream_options: { ...(payload.stream_options ?? {}), include_usage: true },
  }
  return JSON.stringify(next)
}

const RAW_MESSAGE_CHAR_LIMIT = 64_000

function capRawText(value) {
  const text = String(value ?? '')
  if (text.length <= RAW_MESSAGE_CHAR_LIMIT) return { text, truncated: false }
  return { text: `${text.slice(0, RAW_MESSAGE_CHAR_LIMIT)}…（已截断）`, truncated: true }
}

function capRawMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => {
    const capped = { role: message?.role ?? 'assistant' }
    if (typeof message?.reasoning_content === 'string') {
      capped.reasoning_content = capRawText(message.reasoning_content).text
    }
    const contentValue = message?.content
    if (typeof contentValue === 'string') {
      capped.content = capRawText(contentValue).text
    } else if (Array.isArray(contentValue)) {
      capped.content = contentValue.map((part) => {
        if (typeof part === 'string') return capRawText(part).text
        if (typeof part?.text === 'string') return { type: part.type ?? 'text', ...capRawText(part.text) }
        // Vision requests may carry image URLs or data URIs. Preserve normal
        // structured parts, but never copy an unbounded base64 payload into
        // diagnostic history and the message dialog.
        try {
          const serialized = JSON.stringify(part)
          if (serialized.length <= RAW_MESSAGE_CHAR_LIMIT) return structuredClone(part)
          return {
            type: part?.type ?? 'unknown',
            preview: capRawText(serialized).text,
            truncated: true,
          }
        } catch {
          return { type: part?.type ?? 'unknown', preview: '[无法序列化]' }
        }
      })
    }
    if (Array.isArray(message?.tool_calls)) {
      capped.tool_calls = message.tool_calls.map((call) => ({
        id: call?.id ?? null,
        type: 'function',
        function: {
          name: call?.function?.name ?? '',
          arguments: capRawText(call?.function?.arguments ?? '').text,
        },
      }))
    }
    if (typeof message?.tool_call_id === 'string' && message.tool_call_id) {
      capped.tool_call_id = message.tool_call_id
    }
    return capped
  })
}

function messageCharsByRole(messages) {
  const chars = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 }
  for (const message of messages) {
    const role = message?.role ?? 'other'
    const bucket = role in chars ? role : 'other'
    chars[bucket] += messageContentChars(message?.content)
  }
  return { ...chars, total: Object.values(chars).reduce((sum, value) => sum + value, 0) }
}

export function summarizeRequest(text, scope = 'request_history') {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { json: false }
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  return {
    json: true,
    model: payload.model ?? null,
    stream: Boolean(payload.stream),
    messageCount: messages.length,
    roles: messages.map((message) => message?.role ?? 'unknown'),
    chars: messageCharsByRole(messages),
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    toolNames: toolNames(payload.tools),
    reasoningEffort: payload.reasoning_effort ?? null,
    maxTokens: payload.max_tokens ?? payload.max_output_tokens ?? null,
    history: summarizeMessageTrajectory(messages, scope),
  }
}

export function summarizeResponse(text, contentType = '') {
  return summarizeResponseBody(text, contentType)
}

async function readRequestBody(request, limitBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > limitBytes) {
      const error = new Error(`request body exceeds ${limitBytes} bytes`)
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function copyResponseHeaders(upstreamHeaders, response) {
  for (const [name, value] of upstreamHeaders.entries()) {
    if (RESPONSE_HEADERS_TO_DROP.has(name.toLowerCase())) continue
    response.setHeader(name, value)
  }
}

async function writeChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) return false
  if (response.write(chunk)) return true
  return new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolveWrite(true)
    }
    const onClose = () => {
      cleanup()
      resolveWrite(false)
    }
    const onError = (error) => {
      cleanup()
      rejectWrite(error)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
  })
}

function captureChunk(chunks, chunk, capturedBytes, limitBytes) {
  const remaining = limitBytes - capturedBytes
  if (remaining <= 0) return capturedBytes
  const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
  chunks.push(Buffer.from(kept))
  return capturedBytes + kept.length
}

function asAnchorMap(source) {
  const anchors = new Map()
  if (source instanceof Map) {
    for (const [model, anchor] of source.entries()) {
      if (anchor) anchors.set(model, anchor)
    }
    return anchors
  }
  if (source && typeof source === 'object') {
    for (const [model, anchor] of Object.entries(source)) {
      if (anchor) anchors.set(model, anchor)
    }
  }
  return anchors
}

function asMicroAnchorMap(source) {
  const snapshots = new Map()
  if (source instanceof Map) {
    for (const [model, snapshot] of source.entries()) {
      if (snapshot) snapshots.set(model, snapshot)
    }
    return snapshots
  }
  if (source && typeof source === 'object') {
    for (const [model, snapshot] of Object.entries(source)) {
      if (snapshot) snapshots.set(model, snapshot)
    }
  }
  return snapshots
}

function normalizePlane(input, fallbacks = {}) {
  if (!input || typeof input !== 'object') {
    throw new Error('Gateway model plane must be an object.')
  }
  const model = String(input.model ?? fallbacks.model ?? '')
  const upstream = new URL(input.upstreamBaseUrl || fallbacks.upstreamBaseUrl || DEFAULT_UPSTREAM_BASE_URL)
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('Gateway plane upstreamBaseUrl must use http or https.')
  }
  const anchors = asAnchorMap(input.anchors)
  if (input.anchor) {
    const sourceModel = anchorModel(input.anchor) ?? model
    anchors.set(sourceModel, input.anchor)
  }
  const microAnchors = asMicroAnchorMap(input.microAnchors)
  if (input.microAnchor && model) microAnchors.set(model, input.microAnchor)
  const gatewayApiKey = String(input.gatewayApiKey ?? fallbacks.gatewayApiKey ?? '')
  return {
    name: String(input.name ?? fallbacks.name ?? ''),
    model,
    enabled: input.enabled !== false,
    upstreamBaseUrl: upstream.toString(),
    upstreamModel: String(input.upstreamModel ?? fallbacks.upstreamModel ?? '').trim(),
    gatewayApiKey,
    gatewayApiKeySource: input.gatewayApiKeySource
      ?? fallbacks.gatewayApiKeySource
      ?? (gatewayApiKey ? 'profile' : 'none'),
    defaultMode: (input.defaultMode ?? fallbacks.defaultMode) === 'anchor' ? 'anchor' : 'bypass',
    anchors,
    microAnchors,
  }
}

function snapshotPlane(plane) {
  return {
    name: plane.name,
    model: plane.model,
    enabled: plane.enabled,
    upstreamBaseUrl: plane.upstreamBaseUrl,
    upstreamModel: plane.upstreamModel,
    gatewayApiKey: plane.gatewayApiKey,
    gatewayApiKeySource: plane.gatewayApiKeySource,
    defaultMode: plane.defaultMode,
    anchors: new Map(plane.anchors),
    microAnchors: new Map(plane.microAnchors),
  }
}

function isMultiModelListener(config) {
  return config.allowedModels.size > 1 || config.modelPlanes.size > 1
}

function takePlaneSnapshot(config, model) {
  if (model && config.modelPlanes.has(model)) {
    return snapshotPlane(config.modelPlanes.get(model))
  }
  if (config.fallbackPlane) {
    return snapshotPlane({
      ...config.fallbackPlane,
      model: model || config.fallbackPlane.model,
    })
  }
  return null
}

function collectAnchors(config) {
  const anchors = new Map(config.anchors)
  for (const plane of config.modelPlanes.values()) {
    for (const [model, anchor] of plane.anchors) anchors.set(model, anchor)
  }
  if (config.fallbackPlane) {
    for (const [model, anchor] of config.fallbackPlane.anchors) anchors.set(model, anchor)
  }
  return anchors
}

function publicPlaneView(plane) {
  const anchor = plane.anchors.get(plane.model)
  const micro = plane.microAnchors.get(plane.model)
  return {
    name: plane.name,
    model: plane.model,
    enabled: plane.enabled,
    mode: plane.defaultMode,
    upstreamBaseUrl: plane.upstreamBaseUrl,
    upstreamModel: plane.upstreamModel || '',
    gatewayApiKeyConfigured: Boolean(plane.gatewayApiKey),
    gatewayApiKeySource: plane.gatewayApiKeySource,
    microAnchorEnabled: Boolean(micro?.enabled),
    anchor: anchor ? {
      model: plane.model,
      id: anchor.id ?? anchor.artifact?.id ?? null,
      fingerprint: anchor.fingerprint ?? anchor.artifact?.artifactFingerprint ?? null,
      path: anchor.path ?? null,
    } : null,
  }
}

function listenerPlanes(config) {
  if (config.modelPlanes.size > 0) return [...config.modelPlanes.values()]
  return config.fallbackPlane ? [config.fallbackPlane] : []
}

function enabledModelIds(config) {
  const planes = listenerPlanes(config).filter((plane) => plane.enabled)
  const ids = planes.map((plane) => plane.model).filter(Boolean)
  if (ids.length > 0) {
    return config.allowedModels.size > 0
      ? ids.filter((model) => config.allowedModels.has(model))
      : ids
  }
  if (config.allowedModels.size > 0) return [...config.allowedModels]
  return [...OFFICIAL_MODELS]
}

function publicProfileFromPlane(plane) {
  const view = publicPlaneView(plane)
  return {
    name: view.name || view.model,
    model: view.model,
    enabled: view.enabled,
    upstreamBaseUrl: view.upstreamBaseUrl,
    upstreamModel: view.upstreamModel || '',
    apiKeyConfigured: view.gatewayApiKeyConfigured,
    apiKeySource: view.gatewayApiKeySource,
    enhancementMode: view.mode,
    anchorPath: view.anchor?.path ?? '',
    anchorConfigured: Boolean(view.anchor),
    microAnchor: {
      enabled: view.microAnchorEnabled,
    },
    running: true,
  }
}

function officialModelFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (!Object.prototype.hasOwnProperty.call(payload, 'model')) return undefined
  return payload.model
}

function publicConfig(config) {
  const anchors = [...collectAnchors(config).entries()].map(([model, anchor]) => ({
    model,
    id: anchor.id ?? anchor.artifact?.id ?? null,
    fingerprint: anchor.fingerprint ?? anchor.artifact?.artifactFingerprint ?? null,
    path: anchor.path ?? null,
  }))
  const planes = listenerPlanes(config).map(publicPlaneView)
  const configuredKeyCount = planes.filter((plane) => plane.gatewayApiKeyConfigured).length
  const enabledPlanes = planes.filter((plane) => plane.enabled)
  const multi = isMultiModelListener(config)
  return {
    instanceId: config.instanceId,
    version: config.version,
    deploymentMode: config.deploymentMode,
    profile: config.profileName,
    ...(multi ? {} : {
      mode: config.defaultMode,
      upstreamBaseUrl: config.upstreamBaseUrl,
      gatewayApiKeySource: config.gatewayApiKeySource,
    }),
    host: config.host,
    port: config.port,
    captureMode: config.captureMode,
    captureLimitBytes: config.captureLimitBytes,
    responseObservationLimitBytes: config.responseObservationLimitBytes,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    diagnosticHistoryLimit: config.diagnosticHistoryLimit,
    logMaxBytes: config.logMaxBytes,
    logMaxFiles: config.logMaxFiles,
    trajectoryMarkerProfile: COT_MARKER_PROFILE,
    gatewayApiKeyConfigured: configuredKeyCount > 0,
    allGatewayApiKeysConfigured:
      enabledPlanes.length > 0 && enabledPlanes.every((plane) => plane.gatewayApiKeyConfigured),
    gatewayApiKeyConfiguredCount: configuredKeyCount,
    managementAuthRequired: Boolean(config.managementToken),
    credentialPolicy: 'gateway-only',
    callerAuthorization: 'discarded; the selected model plane key is the only upstream credential',
    models: [...config.allowedModels],
    planes,
    webUiPath: config.webUiEnabled ? '/' : null,
    managementEnabled: config.managementEnabled,
    logFile: config.logFile,
    activityLogFile: config.activityLogFile,
    anchors,
    anchor: anchors.length === 1 ? anchors[0] : null,
  }
}

function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

async function recordExchange(config, exchange) {
  if (config.captureMode === 'off') return
  await config.trafficWriter.append(exchange)
}

async function recordActivity(config, activity) {
  if (config.captureMode === 'off') return
  await config.activityWriter.append(activity)
}

function bodyCapture(config, text, contentType, truncated) {
  if (config.captureMode !== 'full') return undefined
  return {
    value: maybeJson(text, contentType),
    truncated,
  }
}

export function createGatewayServer(options = {}) {
  const logDir = resolve(options.logDir ?? join(process.cwd(), 'results', 'gateway'))
  const anchors = configuredAnchors(options)
  const listenerUpstream = options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL
  const upstreamBaseUrl = new URL(listenerUpstream)
  if (!['http:', 'https:'].includes(upstreamBaseUrl.protocol)) {
    throw new Error('Gateway upstreamBaseUrl must use http or https.')
  }
  const modelPlanes = new Map()
  for (const plane of options.modelPlanes ?? []) {
    const normalized = normalizePlane(plane)
    if (normalized.model) modelPlanes.set(normalized.model, normalized)
  }
  const fallbackPlane = modelPlanes.size === 0
    ? normalizePlane({
        name: options.profileName ?? 'single',
        model: Array.isArray(options.allowedModels) ? options.allowedModels[0] ?? '' : '',
        enabled: true,
        upstreamBaseUrl: upstreamBaseUrl.toString(),
        upstreamModel: String(options.upstreamModel ?? '').trim(),
        gatewayApiKey: options.gatewayApiKey ?? '',
        gatewayApiKeySource: options.gatewayApiKeySource ?? (options.gatewayApiKey ? 'gateway' : 'none'),
        defaultMode: options.defaultMode === 'anchor' ? 'anchor' : 'bypass',
        anchors,
        microAnchors: configuredMicroAnchors(options),
      })
    : null
  const config = {
    instanceId: options.instanceId ?? null,
    version: options.version ?? null,
    deploymentMode: options.deploymentMode ?? 'single',
    profileName: options.profileName ?? 'single',
    host: options.host ?? '127.0.0.1',
    port: positiveInteger(options.port, 8642),
    upstreamBaseUrl: upstreamBaseUrl.toString(),
    gatewayApiKey: options.gatewayApiKey ?? '',
    gatewayApiKeySource: options.gatewayApiKeySource ?? (options.gatewayApiKey ? 'gateway' : 'none'),
    managementToken: options.managementToken ?? '',
    defaultMode: options.defaultMode === 'anchor' ? 'anchor' : 'bypass',
    allowedModels: new Set(options.allowedModels ?? []),
    modelPlanes,
    fallbackPlane,
    anchors,
    microAnchors: configuredMicroAnchors(options),
    captureMode: ['off', 'metadata', 'full'].includes(options.captureMode)
      ? options.captureMode
      : 'metadata',
    captureLimitBytes: positiveInteger(options.captureLimitBytes, 16 * 1024 * 1024),
    responseObservationLimitBytes: positiveInteger(
      options.responseObservationLimitBytes,
      64 * 1024 * 1024,
    ),
    upstreamTimeoutMs: positiveInteger(options.upstreamTimeoutMs, 15 * 60 * 1000),
    requestLimitBytes: positiveInteger(options.requestLimitBytes, 32 * 1024 * 1024),
    diagnosticHistoryLimit: positiveInteger(options.diagnosticHistoryLimit, 500),
    logMaxBytes: positiveInteger(options.logMaxBytes, 64 * 1024 * 1024),
    logMaxFiles: positiveInteger(options.logMaxFiles, 5),
    logDir,
    webUiEnabled: options.webUiEnabled !== false,
    managementEnabled: options.managementEnabled !== false,
    logFile: resolve(options.logFile ?? join(logDir, 'traffic.jsonl')),
    activityLogFile: resolve(
      options.activityLogFile ?? join(logDir, 'activity.jsonl'),
    ),
    onDiagnostic: typeof options.onDiagnostic === 'function' ? options.onDiagnostic : null,
    deploymentView: typeof options.deploymentView === 'function'
      ? options.deploymentView
      : () => ({ mode: options.deploymentMode ?? 'single', combinedPort: 8646 }),
    updateDeployment: typeof options.updateDeployment === 'function' ? options.updateDeployment : null,
    listAnchors: typeof options.listAnchors === 'function' ? options.listAnchors : null,
    readAnchorContent: typeof options.readAnchorContent === 'function' ? options.readAnchorContent : null,
    deleteAnchor: typeof options.deleteAnchor === 'function' ? options.deleteAnchor : null,
    updateProfile: typeof options.updateProfile === 'function' ? options.updateProfile : null,
    probeProfile: typeof options.probeProfile === 'function' ? options.probeProfile : null,
    profileViews: typeof options.profileViews === 'function' ? options.profileViews : null,
    anchorJobs: options.anchorJobs ?? null,
    listMicroAnchors: typeof options.listMicroAnchors === 'function' ? options.listMicroAnchors : null,
    createMicroAnchor: typeof options.createMicroAnchor === 'function' ? options.createMicroAnchor : null,
    updateMicroAnchor: typeof options.updateMicroAnchor === 'function' ? options.updateMicroAnchor : null,
    deleteMicroAnchor: typeof options.deleteMicroAnchor === 'function' ? options.deleteMicroAnchor : null,
  }
  config.trafficWriter = new RotatingJsonlWriter(config.logFile, {
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  })
  config.activityWriter = new RotatingJsonlWriter(config.activityLogFile, {
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  })
  if (config.modelPlanes.size > 0) {
    for (const plane of config.modelPlanes.values()) {
      if (plane.enabled && plane.defaultMode === 'anchor' && !plane.anchors.get(plane.model)) {
        throw new Error(`Gateway plane ${plane.name || plane.model} is in anchor mode but has no loaded Anchor.`)
      }
    }
  } else if (config.defaultMode === 'anchor' && config.anchors.size === 0) {
    throw new Error('Gateway anchor mode requires at least one loaded anchor artifact.')
  }
  if (!isLoopbackHost(config.host) && !config.managementToken) {
    throw new Error('A non-loopback Gateway host requires a managementToken.')
  }

  const diagnostics = Array.isArray(options.diagnosticStore)
    ? options.diagnosticStore
    : []
  const addDiagnostic = (exchange) => {
    const entry = diagnosticEntry(exchange, config.profileName)
    diagnostics.push(entry)
    while (diagnostics.length > config.diagnosticHistoryLimit) diagnostics.shift()
    config.onDiagnostic?.(entry)
  }

  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID()
    const startedAt = Date.now()
    const localUrl = new URL(request.url ?? '/', 'http://gateway.local')
    if (
      config.webUiEnabled &&
      serveWebUiRequest(request, response, localUrl.pathname)
    ) return

    if (!config.webUiEnabled && ['/', '/__gateway'].includes(localUrl.pathname)) {
      sendJson(response, 404, {
        error: {
          type: 'gateway_data_plane_only',
          message: 'This listener exposes only the Gateway data plane.',
        },
      })
      return
    }

    if (config.managementEnabled && localUrl.pathname === '/__gateway/health') {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      sendJson(response, 200, { status: 'ok', ...publicConfig(config) })
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'GET' &&
      localUrl.pathname === '/__gateway/diagnostics'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      const requestedLimit = Number(localUrl.searchParams.get('limit') ?? 20)
      const limit = Number.isSafeInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), config.diagnosticHistoryLimit)
        : 20
      sendJson(response, 200, {
        schemaVersion: 1,
        markerProfile: COT_MARKER_PROFILE,
        retained: diagnostics.length,
        entries: diagnostics.slice(-limit).reverse(),
      })
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'DELETE' &&
      localUrl.pathname === '/__gateway/diagnostics'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Clearing diagnostics requires a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const input = await readManagementJson(request)
        if (input.confirmation !== '\u6e05\u7a7a\u5168\u90e8\u8bf7\u6c42') {
          sendJson(response, 400, {
            error: {
              type: 'gateway_diagnostics_confirmation_required',
              message: '\u5fc5\u987b\u51c6\u786e\u8f93\u5165\u201c\u6e05\u7a7a\u5168\u90e8\u8bf7\u6c42\u201d\u624d\u80fd\u5220\u9664\u8bca\u65ad\u548c\u8f6e\u8f6c\u65e5\u5fd7\u3002',
            },
          })
          return
        }
        const deleted = await server.gatewayClearDiagnostics()
        sendJson(response, 200, { schemaVersion: 1, deleted })
      } catch (error) {
        sendJson(response, 500, {
          error: {
            type: 'gateway_diagnostics_clear_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    const diagnosticMatch = config.managementEnabled && request.method === 'GET'
      ? localUrl.pathname.match(/^\/__gateway\/diagnostics\/([0-9a-f-]+)$/i)
      : null
    if (diagnosticMatch) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      const entry = diagnostics.find((item) => item.requestId === diagnosticMatch[1])
      sendJson(
        response,
        entry ? 200 : 404,
        entry ?? { error: { type: 'gateway_diagnostic_not_found', request_id: diagnosticMatch[1] } },
      )
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'GET' &&
      localUrl.pathname === '/__gateway/config'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      const profiles = config.profileViews
        ? config.profileViews().map((profile) => {
            if (!profile || typeof profile !== 'object') return profile
            const { apiKey: _apiKey, gatewayApiKey: _gatewayApiKey, ...safe } = profile
            return safe
          })
        : listenerPlanes(config).map(publicProfileFromPlane)
      sendJson(response, 200, {
        schemaVersion: 1,
        deploymentMode: config.deploymentMode,
        deployment: config.deploymentView(),
        profiles,
      })
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'PATCH' &&
      localUrl.pathname === '/__gateway/config/deployment'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!config.updateDeployment) {
        sendJson(response, 501, { error: { type: 'gateway_deployment_config_read_only' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, { error: { type: 'gateway_management_mutation_forbidden' } })
        return
      }
      try {
        const deployment = await config.updateDeployment(await readManagementJson(request))
        sendJson(response, 200, { schemaVersion: 1, deployment })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: 'gateway_deployment_update_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'GET' &&
      localUrl.pathname === '/__gateway/micro-anchors'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      try {
        sendJson(response, 200, {
          schemaVersion: 2,
          microAnchors: config.listMicroAnchors ? await config.listMicroAnchors() : { definitions: [], profiles: {} },
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_view_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'POST' &&
      localUrl.pathname === '/__gateway/micro-anchors'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!config.createMicroAnchor) {
        sendJson(response, 501, { error: { type: 'gateway_micro_anchor_unavailable' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, { error: { type: 'gateway_management_mutation_forbidden' } })
        return
      }
      try {
        sendJson(response, 200, await config.createMicroAnchor(await readManagementJson(request)))
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_create_failed',
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    const singleMicroAnchorMatch = config.managementEnabled
      ? localUrl.pathname.match(/^\/__gateway\/micro-anchors\/([^/]+)$/)
      : null
    if (singleMicroAnchorMatch && ['PATCH', 'DELETE'].includes(request.method)) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      const handler = request.method === 'PATCH' ? config.updateMicroAnchor : config.deleteMicroAnchor
      if (!handler) {
        sendJson(response, 501, { error: { type: 'gateway_micro_anchor_unavailable' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, { error: { type: 'gateway_management_mutation_forbidden' } })
        return
      }
      try {
        const id = decodeURIComponent(singleMicroAnchorMatch[1])
        const payload = request.method === 'PATCH' ? await readManagementJson(request) : await readManagementJson(request)
        sendJson(response, 200, request.method === 'PATCH' ? await handler(id, payload) : await handler(id))
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_update_failed',
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    const singleProfileMatch = config.managementEnabled && request.method === 'PATCH'
      ? localUrl.pathname.match(/^\/__gateway\/config\/profiles\/(pro|flash|vision)$/)
      : null
    if (singleProfileMatch) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!config.updateProfile) {
        sendJson(response, 501, { error: { type: 'gateway_config_read_only' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, { error: { type: 'gateway_management_mutation_forbidden' } })
        return
      }
      try {
        const result = await config.updateProfile(singleProfileMatch[1], await readManagementJson(request))
        sendJson(response, 200, {
          schemaVersion: 1,
          profile: result?.profile ?? result,
          ...(result?.documentView ? result : {}),
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: error?.type ?? 'gateway_config_update_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'GET' &&
      localUrl.pathname === '/__gateway/anchors'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      try {
        sendJson(response, 200, {
          schemaVersion: 1,
          anchors: config.listAnchors ? await config.listAnchors() : [],
        })
      } catch (error) {
        sendJson(response, 500, {
          error: { type: 'gateway_anchor_catalog_failed', message: error?.message ?? String(error) },
        })
      }
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'DELETE' &&
      localUrl.pathname === '/__gateway/anchors'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!config.deleteAnchor) {
        sendJson(response, 501, { error: { type: 'gateway_anchor_delete_unavailable' } })
        return
      }
      if (!managementMutationAuthorized(request)) {
        sendJson(response, 403, { error: { type: 'gateway_management_mutation_forbidden' } })
        return
      }
      try {
        // Accept exactly one of path/id, either in the JSON body or in the
        // query string; the catalog lookup enforces the exactly-one rule.
        let input = await readManagementJson(request)
        if (!(input?.path || input?.id)) {
          const path = localUrl.searchParams.get('path')
          const id = localUrl.searchParams.get('id')
          if (path !== null || id !== null) {
            input = {
              ...(path !== null ? { path } : {}),
              ...(id !== null ? { id } : {}),
            }
          }
        }
        const deleted = await config.deleteAnchor(input)
        sendJson(response, 200, {
          schemaVersion: 1,
          deleted: { id: deleted.id, path: deleted.path },
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.type ?? (
              error?.statusCode === 404
                ? 'gateway_anchor_not_found'
                : 'gateway_anchor_delete_failed'
            ),
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    if (
      config.managementEnabled &&
      request.method === 'GET' &&
      localUrl.pathname === '/__gateway/anchors/content'
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (!config.readAnchorContent) {
        sendJson(response, 501, { error: { type: 'gateway_anchor_content_unavailable' } })
        return
      }
      try {
        const path = localUrl.searchParams.get('path')
        const id = localUrl.searchParams.get('id')
        sendJson(response, 200, {
          schemaVersion: 1,
          anchor: await config.readAnchorContent({
            ...(path !== null ? { path } : {}),
            ...(id !== null ? { id } : {}),
          }),
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.statusCode === 404
              ? 'gateway_anchor_not_found'
              : 'gateway_anchor_content_rejected',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (
      config.managementEnabled
      && request.method === 'POST'
      && localUrl.pathname.startsWith('/__gateway/config/profiles/')
    ) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (await handleProfileProbeRoute({
        request,
        response,
        pathname: localUrl.pathname,
        sendJson,
        mutationAuthorized: managementMutationAuthorized,
        probeProfile: config.probeProfile,
      })) return
    }

    if (config.managementEnabled && localUrl.pathname.startsWith('/__gateway/anchors/jobs')) {
      if (!managementAuthorized(request, config)) {
        sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
        return
      }
      if (await handleAnchorJobRoutes({
        request,
        response,
        pathname: localUrl.pathname,
        sendJson,
        readJson: readManagementJson,
        mutationAuthorized: managementMutationAuthorized,
        anchorJobs: config.anchorJobs,
      })) return
    }

    if (localUrl.pathname.startsWith('/__gateway/')) {
      sendJson(response, 404, {
        error: {
          type: 'gateway_management_route_not_found',
          path: localUrl.pathname,
        },
      })
      return
    }

    const localPath = localUrl.pathname.replace(/\/+$/, '') || '/'
    if (request.method === 'GET' && (localPath === '/v1/models' || localPath === '/models')) {
      sendJson(response, 200, {
        object: 'list',
        data: enabledModelIds(config).map((id) => ({
          id,
          object: 'model',
          owned_by: 'deepseek-boost-gateway',
        })),
      })
      return
    }

    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.setHeader('access-control-allow-origin', '*')
      response.setHeader('access-control-allow-headers', '*')
      response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      response.end()
      return
    }

    let requestBody
    try {
      requestBody = await readRequestBody(request, config.requestLimitBytes)
    } catch (error) {
      response.statusCode = error.statusCode ?? 400
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: { message: error.message, type: 'gateway_request_error' } }))
      return
    }

    const requestText = requestBody.toString('utf8')
    const parsedPayload = maybeParseJson(requestText)
    const requestedModel = officialModelFromPayload(parsedPayload)
    const isChatCompletions = /\/chat\/completions\/?$/i.test(localPath)
    const multiModel = isMultiModelListener(config)
    const allowed = [...config.allowedModels]
    const rejectLocal = async (status, type, message, extra = {}) => {
      const failureExchange = {
        schemaVersion: 1,
        requestId,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        mode: extra.mode ?? null,
        request: {
          method: request.method,
          path: redactUrl(request.url ?? '/'),
          credentialSource: extra.credentialSource ?? 'none',
          bytes: requestBody.length,
          summary: summarizeRequest(requestText, 'request_history'),
          ...(Array.isArray(parsedPayload?.messages)
            ? { rawMessages: capRawMessages(parsedPayload.messages) }
            : {}),
        },
        transformation: null,
        response: { status, error: message, errorType: type },
      }
      addDiagnostic(failureExchange)
      try {
        await recordExchange(config, failureExchange)
      } catch {
        // The deterministic local error still reaches the client.
      }
      response.setHeader('x-gateway-request-id', requestId)
      sendJson(response, status, {
        error: {
          message,
          type,
          request_id: requestId,
          ...extra.errorExtra,
        },
      })
    }

    let planeSnapshot = null
    if (requestedModel !== undefined && OFFICIAL_MODELS.has(requestedModel)) {
      if (config.allowedModels.size > 0 && !config.allowedModels.has(requestedModel)) {
        await rejectLocal(
          400,
          'gateway_model_not_allowed',
          `Model ${JSON.stringify(requestedModel)} is not served by Gateway profile ${config.profileName}. Allowed models: ${allowed.join(', ')}.`,
          { errorExtra: { profile: config.profileName, allowed_models: allowed } },
        )
        return
      }
      planeSnapshot = takePlaneSnapshot(config, requestedModel)
    } else if (requestedModel !== undefined) {
      if (multiModel || config.allowedModels.size > 0) {
        await rejectLocal(
          400,
          'gateway_model_not_allowed',
          `Model ${JSON.stringify(requestedModel)} is not served by Gateway profile ${config.profileName}. Allowed models: ${allowed.join(', ') || '(none)'}.`,
          { errorExtra: { profile: config.profileName, allowed_models: allowed } },
        )
        return
      }
      planeSnapshot = takePlaneSnapshot(config, requestedModel)
    } else if (!multiModel) {
      const onlyModel = config.modelPlanes.size === 1
        ? [...config.modelPlanes.keys()][0]
        : config.fallbackPlane?.model
      planeSnapshot = takePlaneSnapshot(config, onlyModel)
    } else {
      await rejectLocal(
        400,
        'gateway_model_required',
        'This multi-model listener requires a top-level official model to select a routing plane.',
      )
      return
    }

    if (!planeSnapshot) {
      await rejectLocal(
        400,
        'gateway_model_not_allowed',
        `Model ${JSON.stringify(requestedModel)} is not served by Gateway profile ${config.profileName}.`,
        { errorExtra: { profile: config.profileName, allowed_models: allowed } },
      )
      return
    }

    if (planeSnapshot.enabled === false) {
      await rejectLocal(
        400,
        'gateway_model_not_allowed',
        `Model ${JSON.stringify(planeSnapshot.model)} is not enabled on Gateway profile ${planeSnapshot.name || config.profileName}.`,
        { errorExtra: { profile: planeSnapshot.name || config.profileName, allowed_models: allowed } },
      )
      return
    }

    const requestedMode = String(request.headers['x-deepseek-boost-mode'] ?? '').toLowerCase()
    const selectedMode = requestedMode === 'bypass' || requestedMode === 'anchor'
      ? requestedMode
      : planeSnapshot.defaultMode
    const upstreamUrl = buildUpstreamUrl(planeSnapshot.upstreamBaseUrl, request.url ?? '/')
    const { headers, credentialSource } = buildUpstreamHeaders(
      request.headers,
      planeSnapshot.gatewayApiKey,
    )
    const requestContentType = headers.get('content-type') ?? ''

    if (!planeSnapshot.gatewayApiKey) {
      await rejectLocal(
        503,
        'gateway_upstream_api_key_not_configured',
        'This model has no configured upstream API key. Caller credentials are intentionally ignored.',
        { mode: selectedMode, credentialSource },
      )
      return
    }

    let appliedMode = selectedMode
    let upstreamBody = requestBody
    let anchorMetrics = null
    let parsedChatRequest = parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)
      ? parsedPayload
      : null

    if (isChatCompletions) {
      try {
        const parsedRequest = parsedChatRequest ?? JSON.parse(requestText)
        parsedChatRequest = parsedRequest
        const selectedAnchor = planeSnapshot.anchors.get(parsedRequest.model)
        if (selectedMode === 'anchor' && !selectedAnchor) {
          const configuredModels = [...planeSnapshot.anchors.keys()].join(', ') || '(none)'
          const error = new Error(
            `No Anchor is configured for model ${JSON.stringify(parsedRequest.model)}. Configured models: ${configuredModels}.`,
          )
          error.type = 'gateway_anchor_not_configured'
          throw error
        }
        const transformed = transformChatCompletionsRequest(parsedRequest, {
          mode: selectedMode,
          microAnchor: planeSnapshot.microAnchors.get(parsedRequest.model) ?? { enabled: false },
          anchor: selectedMode === 'anchor' ? selectedAnchor : null,
        })
        upstreamBody = Buffer.from(JSON.stringify(transformed.payload), 'utf8')
        anchorMetrics = transformed.metrics
      } catch (error) {
        if (error instanceof SyntaxError && !parsedChatRequest && selectedMode !== 'anchor') {
          // Malformed JSON in bypass still forwards the original body.
        } else {
          const errorType = error?.type ?? 'gateway_anchor_error'
          const message = error?.message ?? String(error)
          await rejectLocal(400, errorType, message, { mode: selectedMode, credentialSource })
          return
        }
      }
    } else if (selectedMode === 'anchor') {
      appliedMode = 'bypass-unsupported-path'
    }

    const upstreamText = upstreamBody.toString('utf8')

    if (isChatCompletions) {
      let parsedUpstream
      try {
        parsedUpstream = JSON.parse(upstreamText)
      } catch {
        parsedUpstream = null
      }
      const injected = injectStreamUsage(parsedUpstream, upstreamText)
      upstreamBody = Buffer.from(injected, 'utf8')
    }
    upstreamBody = rewriteUpstreamRequestModel(upstreamBody, planeSnapshot.upstreamModel)
    const outboundText = upstreamBody.toString('utf8')

    const rawRequestPayload = parsedChatRequest ?? (isChatCompletions ? maybeParseJson(requestText) : null)
    const exchange = {
      schemaVersion: 1,
      requestId,
      startedAt: new Date(startedAt).toISOString(),
      mode: appliedMode,
      request: {
        method: request.method,
        path: redactUrl(request.url ?? '/'),
        upstreamUrl: redactUrl(upstreamUrl.toString()),
        credentialSource,
        headers: redactHeaders(headers),
        bytes: requestBody.length,
        summary: summarizeRequest(requestText, 'request_history'),
        rawMessages: capRawMessages(Array.isArray(rawRequestPayload?.messages) ? rawRequestPayload.messages : null),
        ...bodyCapture(config, requestText, requestContentType, false),
      },
      transformation: anchorMetrics,
      upstreamRequest: {
        bytes: upstreamBody.length,
        summary: summarizeRequest(outboundText, 'upstream_history'),
        ...bodyCapture(config, outboundText, requestContentType, false),
      },
    }

    try {
      await recordActivity(config, {
        event: 'request-forwarding',
        requestId,
        startedAt: exchange.startedAt,
        mode: appliedMode,
        request: exchange.request.summary,
        upstreamRequest: exchange.upstreamRequest.summary,
        transformation: anchorMetrics,
      })
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: 'gateway-activity-log-error',
        requestId,
        message: error?.message ?? String(error),
      })}\n`)
    }

    let upstreamResponse
    let clientDisconnected = false
    const upstreamController = new AbortController()
    const onClientDisconnect = () => {
      if (response.writableEnded) return
      clientDisconnected = true
      upstreamController.abort(new Error('Gateway client disconnected.'))
    }
    request.once('aborted', onClientDisconnect)
    response.once('close', onClientDisconnect)
    const upstreamTimeout = setTimeout(() => {
      upstreamController.abort(
        new Error(`Upstream request timed out after ${config.upstreamTimeoutMs} ms.`),
      )
    }, config.upstreamTimeoutMs)
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : upstreamBody,
        redirect: 'manual',
        signal: upstreamController.signal,
      })
    } catch (error) {
      clearTimeout(upstreamTimeout)
      request.off('aborted', onClientDisconnect)
      response.off('close', onClientDisconnect)
      const cause = upstreamController.signal.aborted
        ? upstreamController.signal.reason
        : error
      const message = cause?.message ?? String(cause)
      const status = clientDisconnected ? 499 : 502
      if (!response.destroyed && !response.writableEnded) {
        response.statusCode = status
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ error: { message, type: 'gateway_upstream_error', request_id: requestId } }))
      }
      exchange.durationMs = Date.now() - startedAt
      exchange.completedAt = new Date().toISOString()
      exchange.response = {
        status,
        error: message,
        abortedByClient: clientDisconnected,
      }
      addDiagnostic(exchange)
      await recordExchange(config, exchange)
      try {
        await recordActivity(config, {
          event: clientDisconnected ? 'request-aborted-by-client' : 'upstream-request-error',
          requestId,
          completedAt: exchange.completedAt,
          mode: appliedMode,
          status,
          error: message,
          durationMs: exchange.durationMs,
        })
      } catch {
        // The diagnostic remains available in memory even if disk logging fails.
      }
      return
    }

    response.statusCode = upstreamResponse.status
    response.statusMessage = upstreamResponse.statusText
    copyResponseHeaders(upstreamResponse.headers, response)
    response.setHeader('x-gateway-request-id', requestId)

    const responseContentType = upstreamResponse.headers.get('content-type') ?? ''
    const responseObserver = new OpenAiResponseObserver(responseContentType, {
      maxJsonBytes: config.responseObservationLimitBytes,
    })
    const captured = []
    let capturedBytes = 0
    let responseBytes = 0
    let abortedByClient = false
    let transportError = null
    if (upstreamResponse.body) {
      try {
        for await (const chunk of upstreamResponse.body) {
          const bytes = Buffer.from(chunk)
          responseBytes += bytes.length
          responseObserver.push(bytes)
          if (config.captureMode === 'full') {
            capturedBytes = captureChunk(
              captured,
              bytes,
              capturedBytes,
              config.captureLimitBytes,
            )
          }
          if (!(await writeChunk(response, bytes))) {
            abortedByClient = true
            break
          }
        }
      } catch (error) {
        transportError = error?.message ?? String(error)
        abortedByClient = response.destroyed || response.writableEnded
      }
    }
    clearTimeout(upstreamTimeout)
    request.off('aborted', onClientDisconnect)
    response.off('close', onClientDisconnect)
    const responseBody = Buffer.concat(captured).toString('utf8')
    const truncated = capturedBytes < responseBytes
    exchange.durationMs = Date.now() - startedAt
    exchange.completedAt = new Date().toISOString()
    exchange.response = {
      status: upstreamResponse.status,
      headers: redactHeaders(upstreamResponse.headers),
      bytes: responseBytes,
      capturedBytes,
      abortedByClient,
      transportError,
      summary: responseObserver.finish({ abortedByClient, transportError }),
      rawMessages: capRawMessages(responseObserver.assembledMessages()),
      ...bodyCapture(config, responseBody, responseContentType, truncated),
    }
    addDiagnostic(exchange)
    try {
      await recordExchange(config, exchange)
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: 'gateway-log-error',
        requestId,
        message: error?.message ?? String(error),
      })}\n`)
    }
    if (!response.destroyed && !response.writableEnded) response.end()
    try {
      await recordActivity(config, {
        event: abortedByClient
          ? 'response-aborted-by-client'
          : transportError
            ? 'response-transport-error'
            : 'response-complete',
        requestId,
        completedAt: new Date().toISOString(),
        mode: appliedMode,
        status: upstreamResponse.status,
        bytes: responseBytes,
        capturedBytes,
        summary: exchange.response.summary,
        durationMs: exchange.durationMs,
      })
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        event: 'gateway-activity-log-error',
        requestId,
        message: error?.message ?? String(error),
      })}\n`)
    }
    process.stdout.write(`${JSON.stringify({
      requestId,
      mode: appliedMode,
      model: exchange.request.summary.model ?? null,
      stream: exchange.request.summary.stream ?? null,
      tools: exchange.request.summary.toolCount ?? null,
      credentialSource,
      status: upstreamResponse.status,
      responseBytes,
      complete: exchange.response.summary.complete,
      letMe: exchange.response.summary.reasoning?.markers?.letMe ?? 0,
      durationMs: exchange.durationMs,
    })}\n`)
  })

  server.gatewayConfig = publicConfig(config)
  server.replacePlane = (nextPlane) => {
    const normalized = normalizePlane(nextPlane)
    if (!normalized.model) throw new Error('replacePlane requires a model.')
    if (
      normalized.enabled &&
      normalized.defaultMode === 'anchor' &&
      !normalized.anchors.get(normalized.model)
    ) {
      throw new Error(
        `Gateway plane ${normalized.name || normalized.model} is in anchor mode but has no loaded Anchor.`,
      )
    }
    config.modelPlanes.set(normalized.model, normalized)
    config.fallbackPlane = null
    server.gatewayConfig = publicConfig(config)
    return publicPlaneView(normalized)
  }
  server.gatewayDiagnostics = (limit = config.diagnosticHistoryLimit) => {
    const normalizedLimit = Math.min(
      Math.max(Number(limit) || 1, 1),
      config.diagnosticHistoryLimit,
    )
    return diagnostics.slice(-normalizedLimit).reverse()
  }
  server.gatewayClearDiagnostics = async () => {
    const deleted = diagnostics.length
    diagnostics.splice(0)
    await Promise.all([
      config.trafficWriter.clear(),
      config.activityWriter.clear(),
    ])
    return deleted
  }
  return server
}

export async function listenGateway(server, host, port) {
  server.listen(port, host)
  await once(server, 'listening')
  return server.address()
}
