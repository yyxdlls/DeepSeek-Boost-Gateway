import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The "new input" of a request: the user/tool tail after the last assistant
// message. When there is no assistant message yet, system/developer prompts
// are excluded and the remaining user/tool messages are the new input.
export function currentInputMessages(messages) {
  if (!Array.isArray(messages)) return null
  let lastAssistant = -1
  messages.forEach((message, index) => {
    if (message?.role === 'assistant') lastAssistant = index
  })
  const tail = lastAssistant >= 0
    ? messages.slice(lastAssistant + 1)
    : messages
  const input = tail.filter((message) => ['user', 'tool'].includes(message?.role))
  return input.length ? input : null
}

export function diagnosticEntry(exchange, profile = 'single') {
  return {
    schemaVersion: 2,
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
    messages: {
      request: Array.isArray(exchange.request?.rawMessages) ? exchange.request.rawMessages : null,
      response: Array.isArray(exchange.response?.rawMessages) ? exchange.response.rawMessages : null,
      currentInput: currentInputMessages(exchange.request?.rawMessages),
    },
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

async function readExchanges(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function loadDiagnosticHistory(options = {}) {
  const limit = Math.max(1, Number(options.limit) || 100)
  const maxFiles = Math.max(1, Number(options.maxFiles) || 5)
  const logFile = resolve(options.logFile ?? join('results', 'gateway', 'traffic.jsonl'))
  const profile = options.profile ?? 'single'
  let restored = []

  for (let index = 0; index < maxFiles && restored.length < limit; index += 1) {
    const path = index === 0 ? logFile : `${logFile}.${index}`
    const exchanges = await readExchanges(path)
    const remaining = limit - restored.length
    const older = exchanges.slice(-remaining).map((exchange) => diagnosticEntry(exchange, profile))
    restored = [...older, ...restored]
  }

  return restored.slice(-limit)
}
