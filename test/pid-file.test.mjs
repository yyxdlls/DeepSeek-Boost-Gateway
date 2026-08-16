import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readGatewayPidFile,
  stopGateway,
  verifyGatewayProcess,
  writeGatewayPidFile,
} from '../src/gateway/pid-file.mjs'

function healthResponse(instanceId, status = 200) {
  return new Response(JSON.stringify({ status: 'ok', instanceId }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('writes a scoped PID record and verifies the live Gateway instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-pid-'))
  const path = join(directory, 'gateway.pid.json')
  const record = await writeGatewayPidFile({
    instanceId: 'instance-a',
    healthUrl: 'http://127.0.0.1:8642/__gateway/health',
    projectDirectory: directory,
  }, path)

  assert.equal((await readGatewayPidFile(path)).pid, process.pid)
  assert.equal(await verifyGatewayProcess(record, {
    fetchImpl: async () => healthResponse('instance-a'),
  }), true)
  assert.equal(await verifyGatewayProcess(record, {
    fetchImpl: async () => healthResponse('different-instance'),
  }), false)
})

test('stops only a process whose health instance matches the PID file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-stop-'))
  const path = join(directory, 'gateway.pid.json')
  await writeGatewayPidFile({
    instanceId: 'instance-b',
    healthUrl: 'http://127.0.0.1:8642/__gateway/health',
  }, path)
  let alive = true
  const signals = []
  const result = await stopGateway({
    path,
    fetchImpl: async () => healthResponse('instance-b'),
    processExistsImpl: () => alive,
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal })
      alive = false
    },
    delay: async () => {},
  })

  assert.deepEqual(result, { status: 'stopped', pid: process.pid })
  assert.deepEqual(signals, [{ pid: process.pid, signal: 'SIGTERM' }])
  assert.equal(await readGatewayPidFile(path), null)
})

test('refuses a stale or replaced PID when the live instance fingerprint differs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-refuse-'))
  const path = join(directory, 'gateway.pid.json')
  await writeGatewayPidFile({
    instanceId: 'instance-c',
    healthUrl: 'http://127.0.0.1:8642/__gateway/health',
  }, path)
  let signaled = false
  await assert.rejects(
    stopGateway({
      path,
      fetchImpl: async () => healthResponse('different-instance'),
      processExistsImpl: () => true,
      signalProcess: () => { signaled = true },
    }),
    /Refusing to stop PID/,
  )
  assert.equal(signaled, false)
})
