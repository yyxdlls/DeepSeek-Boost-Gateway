import { once } from 'node:events'
import http from 'node:http'
import { join, resolve } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { applyAnchorToChatRequest } from './anchor.mjs'
import { RotatingJsonlWriter } from './jsonl-writer.mjs'
import {
  OpenAiResponseObserver,
  TRAJECTORY_MARKER_PROFILE,
  summarizeMessageTrajectory,
  summarizeResponseBody,
} from './trajectory-stats.mjs'
import { serveWebUiRequest } from './web-ui.mjs'

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

function toolNames(tools) {
  return Array.isArray(tools)
    ? tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
    : []
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

function publicConfig(config) {
  const anchors = [...config.anchors.entries()].map(([model, anchor]) => ({
    model,
    id: anchor.id ?? anchor.artifact?.id ?? null,
    fingerprint: anchor.fingerprint ?? anchor.artifact?.artifactFingerprint ?? null,
    path: anchor.path ?? null,
  }))
  return {
    version: config.version,
    deploymentMode: config.deploymentMode,
    profile: config.profileName,
    mode: config.defaultMode,
    host: config.host,
    port: config.port,
    upstreamBaseUrl: config.upstreamBaseUrl,
    captureMode: config.captureMode,
    captureLimitBytes: config.captureLimitBytes,
    responseObservationLimitBytes: config.responseObservationLimitBytes,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    diagnosticHistoryLimit: config.diagnosticHistoryLimit,
    logMaxBytes: config.logMaxBytes,
    logMaxFiles: config.logMaxFiles,
    trajectoryMarkerProfile: TRAJECTORY_MARKER_PROFILE,
    gatewayApiKeyConfigured: Boolean(config.gatewayApiKey),
    gatewayApiKeySource: config.gatewayApiKeySource,
    managementAuthRequired: Boolean(config.managementToken),
    credentialPolicy: 'gateway-only',
    callerAuthorization: 'discarded; GATEWAY_UPSTREAM_API_KEY is the only upstream credential',
    models: [...config.allowedModels],
    webUiPath: config.webUiEnabled ? '/' : null,
    managementEnabled: config.managementEnabled,
    logFile: config.logFile,
    activityLogFile: config.activityLogFile,
    anchors,
    anchor: anchors.length === 1 ? anchors[0] : null,
  }
}

function diagnosticEntry(exchange, profile = 'single') {
  return {
    schemaVersion: 1,
    profile,
    requestId: exchange.requestId,
    startedAt: exchange.startedAt,
    completedAt: exchange.completedAt ?? null,
    durationMs: exchange.durationMs ?? null,
    mode: exchange.mode,
    request: exchange.request
      ? {
          ...(exchange.request.summary ?? {}),
          credentialSource: exchange.request.credentialSource ?? null,
        }
      : null,
    transformation: exchange.transformation ?? null,
    response: exchange.response
      ? {
          status: exchange.response.status,
          bytes: exchange.response.bytes ?? null,
          capturedBytes: exchange.response.capturedBytes ?? null,
          captureTruncated:
            Number.isFinite(exchange.response.bytes) &&
            Number.isFinite(exchange.response.capturedBytes)
              ? exchange.response.capturedBytes < exchange.response.bytes
              : null,
          abortedByClient: Boolean(exchange.response.abortedByClient),
          transportError: exchange.response.transportError ?? null,
          error: exchange.response.error ?? null,
          summary: exchange.response.summary ?? null,
        }
      : null,
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
  const upstreamBaseUrl = new URL(
    options.upstreamBaseUrl ?? 'https://api.deepseek.com',
  )
  if (!['http:', 'https:'].includes(upstreamBaseUrl.protocol)) {
    throw new Error('Gateway upstreamBaseUrl must use http or https.')
  }
  const config = {
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
    anchors,
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
    diagnosticHistoryLimit: positiveInteger(options.diagnosticHistoryLimit, 100),
    logMaxBytes: positiveInteger(options.logMaxBytes, 64 * 1024 * 1024),
    logMaxFiles: positiveInteger(options.logMaxFiles, 5),
    logDir,
    webUiEnabled: options.webUiEnabled !== false,
    managementEnabled: options.managementEnabled !== false,
    logFile: resolve(options.logFile ?? join(logDir, 'traffic.jsonl')),
    activityLogFile: resolve(
      options.activityLogFile ?? join(logDir, 'activity.jsonl'),
    ),
  }
  config.trafficWriter = new RotatingJsonlWriter(config.logFile, {
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  })
  config.activityWriter = new RotatingJsonlWriter(config.activityLogFile, {
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  })
  if (config.defaultMode === 'anchor' && config.anchors.size === 0) {
    throw new Error('Gateway anchor mode requires at least one loaded anchor artifact.')
  }
  if (!isLoopbackHost(config.host) && !config.managementToken) {
    throw new Error('A non-loopback Gateway host requires a managementToken.')
  }

  const diagnostics = Array.isArray(options.diagnosticStore)
    ? options.diagnosticStore
    : []
  const addDiagnostic = (exchange) => {
    diagnostics.push(diagnosticEntry(exchange, config.profileName))
    while (diagnostics.length > config.diagnosticHistoryLimit) diagnostics.shift()
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
        markerProfile: TRAJECTORY_MARKER_PROFILE,
        retained: diagnostics.length,
        entries: diagnostics.slice(-limit).reverse(),
      })
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

    if (localUrl.pathname.startsWith('/__gateway/')) {
      sendJson(response, 404, {
        error: {
          type: 'gateway_management_route_not_found',
          path: localUrl.pathname,
        },
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

    const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, request.url ?? '/')
    const { headers, credentialSource } = buildUpstreamHeaders(
      request.headers,
      config.gatewayApiKey,
    )
    const requestText = requestBody.toString('utf8')
    const requestContentType = headers.get('content-type') ?? ''
    const requestedMode = String(request.headers['x-deepseek-boost-mode'] ?? '').toLowerCase()
    const selectedMode = requestedMode === 'bypass' || requestedMode === 'anchor'
      ? requestedMode
      : config.defaultMode

    if (!config.gatewayApiKey) {
      const message = 'GATEWAY_UPSTREAM_API_KEY is required. Caller credentials are intentionally ignored.'
      const failureExchange = {
        schemaVersion: 1,
        requestId,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        mode: selectedMode,
        request: {
          method: request.method,
          path: redactUrl(request.url ?? '/'),
          credentialSource,
          bytes: requestBody.length,
          summary: summarizeRequest(requestText, 'request_history'),
        },
        transformation: null,
        response: {
          status: 503,
          error: message,
          errorType: 'gateway_upstream_api_key_not_configured',
        },
      }
      addDiagnostic(failureExchange)
      try {
        await recordExchange(config, failureExchange)
      } catch {
        // The deterministic local configuration error still reaches the client.
      }
      response.setHeader('x-gateway-request-id', requestId)
      sendJson(response, 503, {
        error: {
          message,
          type: 'gateway_upstream_api_key_not_configured',
          request_id: requestId,
        },
      })
      return
    }

    const isChatCompletions = /\/chat\/completions\/?$/i.test(upstreamUrl.pathname)
    let appliedMode = selectedMode
    let upstreamBody = requestBody
    let anchorMetrics = null
    let parsedChatRequest = null

    if (isChatCompletions) {
      try {
        parsedChatRequest = JSON.parse(requestText)
      } catch {
        // Anchor mode reports malformed JSON through its existing error path.
      }
      const requestedModel = parsedChatRequest?.model
      if (
        config.allowedModels.size > 0 &&
        !config.allowedModels.has(requestedModel)
      ) {
        const allowed = [...config.allowedModels]
        const message = `Model ${JSON.stringify(requestedModel)} is not served by Gateway profile ${config.profileName}. Allowed models: ${allowed.join(', ')}.`
        const failureExchange = {
          schemaVersion: 1,
          requestId,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          mode: selectedMode,
          request: {
            method: request.method,
            path: redactUrl(request.url ?? '/'),
            credentialSource,
            bytes: requestBody.length,
            summary: summarizeRequest(requestText, 'request_history'),
          },
          transformation: null,
          response: {
            status: 400,
            error: message,
            errorType: 'gateway_model_not_allowed',
          },
        }
        addDiagnostic(failureExchange)
        try {
          await recordExchange(config, failureExchange)
        } catch {
          // The deterministic profile isolation error still reaches the client.
        }
        response.setHeader('x-gateway-request-id', requestId)
        sendJson(response, 400, {
          error: {
            message,
            type: 'gateway_model_not_allowed',
            request_id: requestId,
            profile: config.profileName,
            allowed_models: allowed,
          },
        })
        return
      }
    }

    if (selectedMode === 'anchor' && isChatCompletions) {
      try {
        const parsedRequest = parsedChatRequest ?? JSON.parse(requestText)
        const selectedAnchor = config.anchors.get(parsedRequest.model)
        if (!selectedAnchor) {
          const configuredModels = [...config.anchors.keys()].join(', ') || '(none)'
          const error = new Error(
            `No Anchor is configured for model ${JSON.stringify(parsedRequest.model)}. Configured models: ${configuredModels}.`,
          )
          error.type = 'gateway_anchor_not_configured'
          throw error
        }
        const transformed = applyAnchorToChatRequest(
          parsedRequest,
          selectedAnchor,
        )
        upstreamBody = Buffer.from(JSON.stringify(transformed.payload), 'utf8')
        anchorMetrics = transformed.metrics
      } catch (error) {
        const errorType = error?.type ?? 'gateway_anchor_error'
        const message = error?.message ?? String(error)
        const failureExchange = {
          schemaVersion: 1,
          requestId,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          mode: selectedMode,
          request: {
            method: request.method,
            path: redactUrl(request.url ?? '/'),
            credentialSource,
            bytes: requestBody.length,
            summary: summarizeRequest(requestText, 'request_history'),
          },
          transformation: null,
          response: { status: 400, error: message, errorType },
        }
        addDiagnostic(failureExchange)
        try {
          await recordExchange(config, failureExchange)
        } catch {
          // The client still receives the deterministic transformation error.
        }
        response.statusCode = 400
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({
          error: {
            message,
            type: errorType,
            request_id: requestId,
          },
        }))
        return
      }
    } else if (selectedMode === 'anchor') {
      appliedMode = 'bypass-unsupported-path'
    }

    const upstreamText = upstreamBody.toString('utf8')
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
        ...bodyCapture(config, requestText, requestContentType, false),
      },
      transformation: anchorMetrics,
      upstreamRequest: {
        bytes: upstreamBody.length,
        summary: summarizeRequest(upstreamText, 'upstream_history'),
        ...bodyCapture(config, upstreamText, requestContentType, false),
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
  server.gatewayDiagnostics = (limit = config.diagnosticHistoryLimit) => {
    const normalizedLimit = Math.min(
      Math.max(Number(limit) || 1, 1),
      config.diagnosticHistoryLimit,
    )
    return diagnostics.slice(-normalizedLimit).reverse()
  }
  return server
}

export async function listenGateway(server, host, port) {
  server.listen(port, host)
  await once(server, 'listening')
  return server.address()
}
