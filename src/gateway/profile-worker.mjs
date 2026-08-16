import process from 'node:process'
import { startGatewayProfile } from './gateway-instance.mjs'

let server = null
let shuttingDown = false

function reply(message) {
  if (process.connected) process.send(message)
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
