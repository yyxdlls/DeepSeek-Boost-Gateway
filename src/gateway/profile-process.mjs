import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url))

function mergeDiagnostics(target, incoming, limit) {
  const byId = new Map()
  for (const entry of [...target, ...incoming]) {
    if (entry?.requestId) byId.set(entry.requestId, entry)
  }
  const merged = [...byId.values()]
    .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)))
    .slice(-limit)
  target.splice(0, target.length, ...merged)
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve()
    }, timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function spawnGatewayProfileProcess(profile, options = {}) {
  return new Promise((resolve, reject) => {
    const diagnostics = Array.isArray(options.diagnosticStore)
      ? options.diagnosticStore
      : []
    const historyLimit = Math.max(1, Number(profile.diagnosticHistoryLimit) || 100)
    const pendingOperations = new Map()
    const child = fork(WORKER_PATH, [], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: false,
    })
    let started = false
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Gateway profile ${profile.name} child process did not start in time.`))
    }, 30_000)

    const handle = {
      child,
      childPid: child.pid,
      listening: false,
      gatewayConfig: null,
      address() {
        return {
          address: this.gatewayConfig?.host ?? profile.host,
          port: this.gatewayConfig?.port ?? profile.port,
        }
      },
      gatewayDiagnostics(limit = historyLimit) {
        const normalized = Math.min(Math.max(Number(limit) || 1, 1), historyLimit)
        return diagnostics.slice(-normalized).reverse()
      },
      async gatewayClearDiagnostics() {
        if (!child.connected || !this.listening) {
          const deleted = diagnostics.length
          diagnostics.splice(0)
          return deleted
        }
        const operationId = randomUUID()
        const result = new Promise((resolveOperation, rejectOperation) => {
          pendingOperations.set(operationId, { resolve: resolveOperation, reject: rejectOperation })
        })
        child.send({ type: 'clear-diagnostics', operationId })
        const deleted = await result
        diagnostics.splice(0)
        return deleted
      },
      async gatewayStop() {
        this.listening = false
        if (child.connected) child.send({ type: 'shutdown' })
        await waitForExit(child)
      },
    }

    child.on('message', (message) => {
      if (message?.type === 'started') {
        started = true
        settled = true
        clearTimeout(timeout)
        handle.childPid = message.pid ?? child.pid
        handle.gatewayConfig = message.gatewayConfig
        handle.listening = true
        mergeDiagnostics(diagnostics, message.diagnostics ?? [], historyLimit)
        resolve(handle)
        return
      }
      if (message?.type === 'diagnostic') {
        mergeDiagnostics(diagnostics, [message.entry], historyLimit)
        return
      }
      if (message?.type === 'start-failed' && !settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(message.error ?? `Gateway profile ${profile.name} failed to start.`))
        return
      }
      if (['diagnostics-cleared', 'operation-failed'].includes(message?.type)) {
        const operation = pendingOperations.get(message.operationId)
        if (!operation) return
        pendingOperations.delete(message.operationId)
        if (message.type === 'operation-failed') operation.reject(new Error(message.error))
        else operation.resolve(Number(message.deleted) || 0)
      }
    })

    child.once('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })
    child.once('exit', (code, signal) => {
      handle.listening = false
      for (const operation of pendingOperations.values()) {
        operation.reject(new Error(`Gateway profile ${profile.name} child exited.`))
      }
      pendingOperations.clear()
      if (!started && !settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(
          `Gateway profile ${profile.name} child exited before startup (${code ?? signal ?? 'unknown'}).`,
        ))
      }
    })

    child.send({
      type: 'start',
      profile,
      options: {
        version: options.version ?? null,
        instanceId: options.instanceId ?? null,
        deploymentMode: options.deploymentMode ?? 'split',
        webUiEnabled: false,
        managementEnabled: false,
      },
    })
  })
}
