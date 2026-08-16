import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import {
  gatewayIsReady,
  gatewayLaunchConfiguration,
  gatewayMatchesDeployment,
  gatewayUrls,
} from '../scripts/launch-gateway.mjs'

test('builds local launcher URLs from Gateway environment values', () => {
  assert.deepEqual(gatewayUrls({}), {
    origin: 'http://127.0.0.1:8642',
    webUi: 'http://127.0.0.1:8642/',
    health: 'http://127.0.0.1:8642/__gateway/health',
    api: 'http://127.0.0.1:8642/v1',
  })
  assert.equal(
    gatewayUrls({ GATEWAY_HOST: '::1', GATEWAY_PORT: '9000' }).webUi,
    'http://[::1]:9000/',
  )
  assert.equal(gatewayUrls({ GATEWAY_HOST: '0.0.0.0' }).webUi, 'http://127.0.0.1:8642/')
})

test('treats authenticated management health as a ready Gateway', async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 401
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    assert.equal(
      await gatewayIsReady(`http://127.0.0.1:${server.address().port}/__gateway/health`),
      true,
    )
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('launches split data planes behind a separate management WebUI port', () => {
  const launch = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'split',
    GATEWAY_PRO_ENABLED: 'true',
    GATEWAY_FLASH_ENABLED: 'true',
    GATEWAY_WEB_UI_PORT: '8642',
    GATEWAY_PRO_PORT: '8643',
    GATEWAY_FLASH_PORT: '8644',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    GATEWAY_FLASH_UPSTREAM_API_KEY: 'flash-key',
  })
  assert.equal(launch.webUi, 'http://127.0.0.1:8642/')
  assert.deepEqual(launch.apis.map((api) => api.url), [
    'http://127.0.0.1:8643/v1',
    'http://127.0.0.1:8644/v1',
  ])
  assert.deepEqual(launch.apis.map((api) => api.keyConfigured), [true, true])
})

test('does not silently reuse a listener from the wrong deployment mode', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: 'ok', deploymentMode: 'single' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const healthUrl = `http://127.0.0.1:${server.address().port}/__gateway/health`
  try {
    assert.equal(await gatewayMatchesDeployment(healthUrl, 'single'), true)
    assert.equal(await gatewayMatchesDeployment(healthUrl, 'split'), false)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
