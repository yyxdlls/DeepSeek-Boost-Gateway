import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import {
  applyManagedConfig,
  emptyManagedConfig,
  managedProfileViews,
  updateManagedProfile,
} from '../src/gateway/managed-config.mjs'
import { createGatewayServer, rewriteUpstreamRequestModel } from '../src/gateway/proxy.mjs'
import { gatewayModelPlanes, gatewaySplitProfiles } from '../src/gateway/runtime-config.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
    server.once('error', reject)
  })
}

async function close(server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

test('rewrites JSON model only when a different upstreamModel is set', () => {
  const body = Buffer.from(JSON.stringify({ model: 'deepseek-v4-pro', messages: [] }))
  assert.equal(rewriteUpstreamRequestModel(body, ''), body)
  assert.equal(rewriteUpstreamRequestModel(body, '   '), body)
  assert.equal(rewriteUpstreamRequestModel(body, 'deepseek-v4-pro'), body)
  const rewritten = rewriteUpstreamRequestModel(body, 'provider-pro-slug')
  assert.notEqual(rewritten, body)
  assert.deepEqual(JSON.parse(rewritten.toString()), {
    model: 'provider-pro-slug',
    messages: [],
  })
  assert.equal(rewriteUpstreamRequestModel('not-json', 'x'), 'not-json')
  assert.deepEqual(
    JSON.parse(rewriteUpstreamRequestModel(Buffer.from('{"n":1}'), 'x').toString()),
    { n: 1 },
  )
})

test('managed profile stores trimmed upstreamModel and exposes harness model separately', () => {
  const document = updateManagedProfile(emptyManagedConfig(), 'pro', {
    upstreamModel: '  custom-pro  ',
  })
  assert.equal(document.profiles.pro.upstreamModel, 'custom-pro')
  const effective = applyManagedConfig({}, document)
  assert.equal(effective.GATEWAY_PRO_UPSTREAM_MODEL, 'custom-pro')
  const views = managedProfileViews({}, document)
  const pro = views.find((profile) => profile.name === 'pro')
  assert.equal(pro.model, 'deepseek-v4-pro')
  assert.equal(pro.upstreamModel, 'custom-pro')
})

test('blank upstreamModel clears the override', () => {
  let document = updateManagedProfile(emptyManagedConfig(), 'flash', {
    upstreamModel: 'flash-slug',
  })
  document = updateManagedProfile(document, 'flash', { upstreamModel: '   ' })
  assert.equal(document.profiles.flash.upstreamModel, '')
  const views = managedProfileViews({}, document)
  assert.equal(views.find((profile) => profile.name === 'flash').upstreamModel, '')
  assert.equal(views.find((profile) => profile.name === 'flash').model, 'deepseek-v4-flash')
})

test('rejects oversized or control-character upstreamModel', () => {
  assert.throws(
    () => updateManagedProfile(emptyManagedConfig(), 'pro', { upstreamModel: 'a'.repeat(201) }),
    /at most 200/,
  )
  assert.throws(
    () => updateManagedProfile(emptyManagedConfig(), 'pro', { upstreamModel: 'bad\nname' }),
    /control characters/,
  )
})

test('runtime planes read GATEWAY_*_UPSTREAM_MODEL', () => {
  const planes = gatewayModelPlanes({
    GATEWAY_PRO_UPSTREAM_MODEL: 'slug-pro',
  })
  assert.equal(planes.find((plane) => plane.name === 'pro').upstreamModel, 'slug-pro')
  assert.equal(planes.find((plane) => plane.name === 'flash').upstreamModel, '')
  const pro = gatewaySplitProfiles({
    GATEWAY_PRO_UPSTREAM_MODEL: 'slug-pro',
  }).find((profile) => profile.name === 'pro')
  assert.equal(pro.upstreamModel, 'slug-pro')
  assert.equal(pro.models[0], 'deepseek-v4-pro')
})

test('chat completions forwards the configured upstream model name', async () => {
  const seen = []
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.setHeader('content-type', 'application/json')
    response.end('{}')
  })
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    allowedModels: ['deepseek-v4-pro'],
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    upstreamModel: 'provider-pro-slug',
    gatewayApiKey: 'gateway-key',
    defaultMode: 'bypass',
    captureMode: 'off',
  })
  const address = await listen(gateway)
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    assert.equal(response.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].model, 'provider-pro-slug')
    assert.deepEqual(seen[0].messages, [{ role: 'user', content: 'hi' }])
  } finally {
    await close(gateway)
    await close(upstream)
  }
})
