const DEFAULT_TIMEOUT_MS = 60_000
const REPLY_LIMIT = 400
const ERROR_LIMIT = 500
const PROBE_PROMPT = '你好'

export function chatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/chat/completions')) {
    url.pathname = `${path}/chat/completions`
  }
  return url.toString()
}

function redact(text, apiKey) {
  const raw = String(text ?? '').slice(0, ERROR_LIMIT)
  return apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw
}

function truncateReply(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= REPLY_LIMIT) return normalized
  return `${normalized.slice(0, REPLY_LIMIT)}…`
}

function assistantReply(payload) {
  const message = payload?.choices?.[0]?.message
  if (!message || typeof message !== 'object') return null
  const content = typeof message.content === 'string' ? message.content.trim() : ''
  const reasoning = typeof message.reasoning_content === 'string'
    ? message.reasoning_content.trim()
    : ''
  if (!content && !reasoning) return null
  return { content, reasoning }
}

export async function probeUpstream(options = {}) {
  const started = Date.now()
  const apiKey = String(options.apiKey ?? '').trim()
  const officialModel = String(options.model ?? '').trim()
  const upstreamModel = String(options.upstreamModel ?? '').trim() || officialModel
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const prompt = String(options.prompt ?? PROBE_PROMPT).trim() || PROBE_PROMPT

  if (!apiKey) {
    return {
      ok: false,
      error: '未配置 API Key',
      model: officialModel,
      upstreamModel,
      latencyMs: 0,
    }
  }

  let endpoint
  try {
    endpoint = chatCompletionsUrl(options.baseUrl)
  } catch {
    return {
      ok: false,
      error: '上游 Base URL 无效',
      model: officialModel,
      upstreamModel,
      latencyMs: 0,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        stream: false,
      }),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    const raw = await response.text()
    const redacted = redact(raw, apiKey)
    let payload = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? redacted ?? `HTTP ${response.status}`
      return {
        ok: false,
        status: response.status,
        error: redact(detail, apiKey) || `HTTP ${response.status}`,
        model: officialModel,
        upstreamModel,
        latencyMs,
      }
    }

    const reply = assistantReply(payload)
    if (!reply) {
      return {
        ok: false,
        status: response.status,
        error: '上游有响应，但没有助手回复',
        model: officialModel,
        upstreamModel,
        latencyMs,
      }
    }

    return {
      ok: true,
      status: response.status,
      model: officialModel,
      upstreamModel,
      latencyMs,
      reply: truncateReply(reply.content || reply.reasoning),
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    return {
      ok: false,
      error: aborted
        ? `等待回复超时（${timeoutMs}ms）`
        : redact(error?.message ?? String(error), apiKey),
      model: officialModel,
      upstreamModel,
      latencyMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeManagedProfile(profile) {
  if (!profile) {
    const error = new Error('Unknown Gateway profile.')
    error.statusCode = 404
    error.type = 'gateway_profile_not_found'
    throw error
  }
  const result = await probeUpstream({
    baseUrl: profile.upstreamBaseUrl,
    apiKey: profile.gatewayApiKey,
    model: profile.models?.[0] ?? profile.model,
    upstreamModel: profile.upstreamModel,
  })
  return {
    profile: profile.name,
    ...result,
  }
}
