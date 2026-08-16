import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnGatewayProfileProcess } from '../src/gateway/profile-process.mjs'

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

test('runs a data profile in a child process and stops it with the parent handle', async () => {
  const port = await freePort()
  const logDir = await mkdtemp(join(tmpdir(), 'deepseek-profile-child-'))
  const handle = await spawnGatewayProfileProcess({
    name: 'pro',
    host: '127.0.0.1',
    port,
    models: ['deepseek-v4-pro'],
    upstreamBaseUrl: 'https://provider.invalid',
    gatewayApiKey: 'test-key',
    gatewayApiKeySource: 'profile',
    managementToken: '',
    defaultMode: 'anchor',
    anchorPaths: {
      'deepseek-v4-pro': 'anchors/dsh-minimal-open-workstream-pro.json',
    },
    logDir,
    diagnosticHistoryLimit: 10,
    logMaxFiles: 2,
  }, {
    version: 'test',
    instanceId: 'parent-instance',
    diagnosticStore: [],
  })

  try {
    assert.equal(handle.listening, true)
    assert.notEqual(handle.childPid, process.pid)
    assert.equal(handle.gatewayConfig.profile, 'pro')
    assert.equal(handle.gatewayConfig.port, port)
    assert.equal(await handle.gatewayClearDiagnostics(), 0)
  } finally {
    await handle.gatewayStop()
  }
  assert.equal(handle.listening, false)
  assert.equal(handle.child.exitCode !== null || handle.child.signalCode !== null, true)
})
