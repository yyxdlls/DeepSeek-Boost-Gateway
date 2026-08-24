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
    GATEWAY_VISION_ENABLED: 'false',
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

test('launches all three split data planes with independent keys and ports', () => {
  const launch = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'split',
    GATEWAY_PRO_ENABLED: 'true',
    GATEWAY_FLASH_ENABLED: 'true',
    GATEWAY_VISION_ENABLED: 'true',
    GATEWAY_WEB_UI_PORT: '8642',
    GATEWAY_PRO_PORT: '8643',
    GATEWAY_FLASH_PORT: '8644',
    GATEWAY_VISION_PORT: '8645',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    GATEWAY_FLASH_UPSTREAM_API_KEY: 'flash-key',
    GATEWAY_VISION_UPSTREAM_API_KEY: 'vision-key',
  })
  assert.equal(launch.webUi, 'http://127.0.0.1:8642/')
  assert.deepEqual(launch.apis.map((api) => api.profile), ['pro', 'flash', 'vision'])
  assert.deepEqual(launch.apis.map((api) => api.url), [
    'http://127.0.0.1:8643/v1',
    'http://127.0.0.1:8644/v1',
    'http://127.0.0.1:8645/v1',
  ])
  assert.deepEqual(launch.apis.map((api) => api.keyConfigured), [true, true, true])
})

test('all mode advertises split endpoints plus the combined endpoint', () => {
  const launch = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'all',
    GATEWAY_WEB_UI_PORT: '8642',
    GATEWAY_PRO_PORT: '8643',
    GATEWAY_FLASH_PORT: '8644',
    GATEWAY_VISION_PORT: '8645',
    GATEWAY_COMBINED_PORT: '8646',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
  })
  assert.equal(launch.deploymentMode, 'all')
  assert.equal(launch.webUi, 'http://127.0.0.1:8642/')
  assert.deepEqual(launch.apis.map((api) => api.profile), [
    'pro', 'flash', 'vision', 'combined',
  ])
  assert.equal(launch.apis.at(-1).url, 'http://127.0.0.1:8646/v1')
  assert.equal(launch.apis.at(-1).model, 'deepseek-v4-pro,deepseek-v4-flash,deepseek-v4-flash-vision-exp')
  assert.equal(launch.apis.at(-1).keyConfigured, false)
})

test('single and combined keyConfigured follow per-model planes, not a shared key', () => {
  const emptySingle = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'single',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
  })
  assert.equal(emptySingle.apis[0].keyConfigured, false)

  const proOnly = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'single',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
  })
  assert.equal(proOnly.apis[0].keyConfigured, true)

  const allWithFlash = gatewayLaunchConfiguration({
    GATEWAY_INSTANCE_MODE: 'all',
    GATEWAY_WEB_UI_PORT: '8642',
    GATEWAY_PRO_PORT: '8643',
    GATEWAY_FLASH_PORT: '8644',
    GATEWAY_VISION_PORT: '8645',
    GATEWAY_COMBINED_PORT: '8646',
    GATEWAY_FLASH_UPSTREAM_API_KEY: 'flash-key',
  })
  assert.deepEqual(allWithFlash.apis.map((api) => api.keyConfigured), [false, true, false, true])
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
