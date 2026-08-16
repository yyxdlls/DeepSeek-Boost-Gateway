import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const GATEWAY_PID_KIND = 'deepseek-boost-gateway-pid-v1'
export const DEFAULT_GATEWAY_PID_PATH = resolve('results', 'gateway.pid.json')

function validRecord(record) {
  return record?.kind === GATEWAY_PID_KIND &&
    Number.isSafeInteger(record.pid) && record.pid > 0 &&
    typeof record.instanceId === 'string' && record.instanceId.length > 0 &&
    typeof record.healthUrl === 'string' && record.healthUrl.length > 0
}

export async function readGatewayPidFile(path = DEFAULT_GATEWAY_PID_PATH) {
  try {
    const record = JSON.parse(await readFile(path, 'utf8'))
    if (!validRecord(record)) throw new Error('Gateway PID file has an invalid format.')
    return record
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeGatewayPidFile(record, path = DEFAULT_GATEWAY_PID_PATH) {
  const complete = {
    kind: GATEWAY_PID_KIND,
    pid: process.pid,
    instanceId: record.instanceId,
    healthUrl: record.healthUrl,
    startedAt: record.startedAt ?? new Date().toISOString(),
    projectDirectory: resolve(record.projectDirectory ?? process.cwd()),
  }
  if (!validRecord(complete)) throw new Error('Cannot write an invalid Gateway PID record.')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(complete, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return complete
}

export async function removeGatewayPidFile(instanceId, path = DEFAULT_GATEWAY_PID_PATH) {
  const record = await readGatewayPidFile(path)
  if (!record || record.instanceId !== instanceId) return false
  await unlink(path)
  return true
}

export function processExists(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

export async function verifyGatewayProcess(record, options = {}) {
  if (!validRecord(record)) return false
  const response = await (options.fetchImpl ?? fetch)(record.healthUrl, {
    headers: {
      accept: 'application/json',
      ...(options.managementToken
        ? { 'x-gateway-management-token': options.managementToken }
        : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
  })
  if (!response.ok) return false
  const health = await response.json()
  return health?.instanceId === record.instanceId
}

export async function stopGateway(options = {}) {
  const path = options.path ?? DEFAULT_GATEWAY_PID_PATH
  const record = await readGatewayPidFile(path)
  if (!record) return { status: 'not-running' }

  const exists = options.processExistsImpl ?? processExists
  if (!exists(record.pid)) {
    await removeGatewayPidFile(record.instanceId, path)
    return { status: 'stale', pid: record.pid }
  }

  if (!(await verifyGatewayProcess(record, options))) {
    throw new Error(
      `Refusing to stop PID ${record.pid}: its live Gateway instance does not match the PID file.`,
    )
  }

  const signalProcess = options.signalProcess ?? process.kill
  signalProcess(record.pid, 'SIGTERM')
  const delay = options.delay ?? ((milliseconds) => new Promise(
    (resolvePromise) => setTimeout(resolvePromise, milliseconds),
  ))
  const attempts = options.attempts ?? 50
  const intervalMs = options.intervalMs ?? 100
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!exists(record.pid)) {
      try {
        await removeGatewayPidFile(record.instanceId, path)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return { status: 'stopped', pid: record.pid }
    }
    await delay(intervalMs)
  }
  throw new Error(`Gateway PID ${record.pid} did not stop within ${attempts * intervalMs} ms.`)
}
