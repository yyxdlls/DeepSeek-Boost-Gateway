import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function diagnosticEntry(exchange, profile = 'single') {
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
