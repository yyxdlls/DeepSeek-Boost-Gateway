import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SERVER = fileURLToPath(new URL('../src/gateway/server.mjs', import.meta.url))
const PRO_ANCHOR = fileURLToPath(new URL('../anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json', import.meta.url))

async function freePort() {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) return response.json()
    } catch {
      // Startup still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Gateway did not become healthy: ${url}`)
}

test('all mode starts management, three isolated profiles, and one combined data plane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-all-mode-'))
  const ports = await Promise.all([1, 2, 3, 4, 5].map(() => freePort()))
  const [managementPort, proPort, flashPort, visionPort, combinedPort] = ports
  const anchorPath = join(directory, 'anchors', 'pro.json')
  await mkdir(dirname(anchorPath), { recursive: true })
  await copyFile(PRO_ANCHOR, anchorPath)
  await writeFile(join(directory, 'gateway.config.json'), JSON.stringify({
    schemaVersion: 1,
    deployment: { mode: 'all', combinedPort },
    profiles: {
      pro: {
        enabled: true,
        port: proPort,
        enhancementMode: 'bypass',
        anchorPath,
      },
      flash: { enabled: true, port: flashPort, enhancementMode: 'bypass', anchorPath: '' },
      vision: { enabled: true, port: visionPort, enhancementMode: 'bypass', anchorPath: '' },
    },
  }, null, 2), 'utf8')

  const child = spawn(process.execPath, [SERVER], {
    cwd: directory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GATEWAY_INSTANCE_MODE: 'split', // managed document must override this
      GATEWAY_WEB_UI_HOST: '127.0.0.1',
      GATEWAY_WEB_UI_PORT: String(managementPort),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_UPSTREAM_BASE_URL: 'http://127.0.0.1:9',
      GATEWAY_UPSTREAM_API_KEY: '',
      GATEWAY_LOG_DIR: join(directory, 'logs'),
    },
  })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    const health = await waitForHealth(
      `http://127.0.0.1:${managementPort}/__gateway/health`,
    )
    assert.equal(health.deploymentMode, 'all')
    assert.deepEqual(health.instances.map((instance) => instance.profile), [
      'pro', 'flash', 'vision', 'combined',
    ])
    assert.deepEqual(health.instances.map((instance) => instance.port), [
      proPort, flashPort, visionPort, combinedPort,
    ])
    const combined = health.instances.find((instance) => instance.profile === 'combined')
    assert.deepEqual(combined.models, [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    assert.equal(combined.deploymentMode, 'all')
    assert.ok(combined.processId)
  } finally {
    child.kill('SIGTERM')
    let timer
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(
            new Error(`Gateway child did not stop. stderr: ${stderr}`),
          ), 10_000)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
})
