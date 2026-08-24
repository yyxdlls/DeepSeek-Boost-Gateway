import process from 'node:process'
import { startGatewayProfile } from './gateway-instance.mjs'

let server = null
let shuttingDown = false

function logSendFailure(message, error) {
  process.stderr.write(`${JSON.stringify({
    event: 'gateway-ipc-send-failed',
    type: message?.type ?? null,
    requestId: message?.entry?.requestId ?? null,
    message: error?.message ?? String(error),
  })}\n`)
}

// Oversized diagnostic entries cannot cross the IPC channel; retry with only
// the current input tail and message counts so the parent list still holds the
// requestId. The full body remains in the child's own diagnostics store.
function slimDiagnosticMessage(message) {
  if (message?.type !== 'diagnostic') return null
  const entry = message.entry ?? {}
  const messages = entry.messages ?? {}
  return {
    ...message,
    entry: {
      ...entry,
      messages: {
        request: null,
        response: null,
        currentInput: Array.isArray(messages.currentInput)
          ? messages.currentInput
          : null,
        requestMessageCount: Array.isArray(messages.request) ? messages.request.length : null,
        responseMessageCount: Array.isArray(messages.response) ? messages.response.length : null,
      },
    },
  }
}

function sendIpc(message) {
  if (!process.connected) return false
  const sent = process.send(message)
  if (sent === false) throw new Error('IPC channel is closed.')
  return true
}

function reply(message) {
  try {
    sendIpc(message)
    return
  } catch (error) {
    logSendFailure(message, error)
  }
  const slim = slimDiagnosticMessage(message)
  if (!slim) return
  try {
    sendIpc(slim)
    process.stderr.write(`${JSON.stringify({
      event: 'gateway-ipc-send-slimmed',
      type: message?.type ?? null,
      requestId: message?.entry?.requestId ?? null,
    })}\n`)
  } catch (retryError) {
    logSendFailure(slim, retryError)
  }
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve))
  }
  process.exit(0)
}

process.on('message', async (message) => {
  if (message?.type === 'start' && !server) {
    try {
      server = await startGatewayProfile(message.profile, {
        ...message.options,
        onDiagnostic: (entry) => reply({ type: 'diagnostic', entry }),
      })
      reply({
        type: 'started',
        pid: process.pid,
        gatewayConfig: server.gatewayConfig,
        diagnostics: server.gatewayDiagnostics(500).reverse(),
      })
    } catch (error) {
      reply({ type: 'start-failed', error: error?.message ?? String(error) })
      process.exit(1)
    }
    return
  }

  if (message?.type === 'clear-diagnostics' && server) {
    try {
      const deleted = await server.gatewayClearDiagnostics()
      reply({ type: 'diagnostics-cleared', operationId: message.operationId, deleted })
    } catch (error) {
      reply({
        type: 'operation-failed',
        operationId: message.operationId,
        error: error?.message ?? String(error),
      })
    }
    return
  }

  if (message?.type === 'shutdown') await shutdown()
})

process.on('disconnect', () => void shutdown())
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown())
}
