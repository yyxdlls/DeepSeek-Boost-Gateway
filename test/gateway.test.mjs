import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  createGatewayServer,
  listenGateway,
  redactUrl,
} from '../src/gateway/proxy.mjs'
import { createGatewayManagementServer } from '../src/gateway/management-server.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address()
}

async function close(server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

test('maps the local /v1 prefix onto the configured upstream prefix', () => {
  assert.equal(
    buildUpstreamUrl(
      'https://provider.example/api/v1',
      '/v1/chat/completions?beta=1',
    ).toString(),
    'https://provider.example/api/v1/chat/completions?beta=1',
  )
  assert.equal(
    buildUpstreamUrl('https://api.deepseek.com', '/v1/chat/completions').toString(),
    'https://api.deepseek.com/chat/completions',
  )
})

test('Gateway credentials replace and isolate all caller credentials', () => {
  const gateway = buildUpstreamHeaders(
    {
      authorization: 'Bearer caller-key',
      'x-api-key': 'caller-x-api-key',
      'x-gateway-management-token': 'management-secret',
    },
    'gateway-key',
  )
  assert.equal(gateway.credentialSource, 'gateway')
  assert.equal(gateway.headers.get('authorization'), 'Bearer gateway-key')
  assert.equal(gateway.headers.has('x-api-key'), false)
  assert.equal(gateway.headers.has('x-gateway-management-token'), false)

  const missing = buildUpstreamHeaders({ authorization: 'Bearer caller-key' })
  assert.equal(missing.credentialSource, 'none')
  assert.equal(missing.headers.has('authorization'), false)
})

test('requires a separate management token when binding beyond loopback', () => {
  assert.throws(
    () => createGatewayServer({ host: '0.0.0.0' }),
    /requires a managementToken/,
  )
})

test('rejects a non-HTTP upstream at startup', () => {
  assert.throws(
    () => createGatewayServer({ upstreamBaseUrl: 'file:///tmp/provider' }),
    /must use http or https/,
  )
})

test('protects management endpoints when a token is configured', async () => {
  const gateway = createGatewayServer({
    managementToken: 'management-secret',
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const denied = await fetch(
      `http://127.0.0.1:${address.port}/__gateway/diagnostics`,
    )
    assert.equal(denied.status, 401)

    const allowed = await fetch(
      `http://127.0.0.1:${address.port}/__gateway/diagnostics`,
      { headers: { 'x-gateway-management-token': 'management-secret' } },
    )
    assert.equal(allowed.status, 200)
  } finally {
    await close(gateway)
  }
})

test('rejects data-plane requests locally when the Gateway key is absent', async () => {
  let upstreamCalls = 0
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1
    response.end('{}')
  })
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-key-must-not-be-used',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] }),
    })
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.error.type, 'gateway_upstream_api_key_not_configured')
    assert.equal(upstreamCalls, 0)

    const diagnostics = await fetch(
      `http://127.0.0.1:${address.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    assert.equal(diagnostics.entries[0].request.credentialSource, 'none')
    assert.equal(diagnostics.entries[0].response.status, 503)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('keeps split data-plane model isolation even in bypass mode', async () => {
  let upstreamCalls = 0
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1
    response.end('{}')
  })
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    profileName: 'pro',
    allowedModels: ['deepseek-v4-pro'],
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    gatewayApiKey: 'pro-key',
    defaultMode: 'bypass',
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.error.type, 'gateway_model_not_allowed')
    assert.deepEqual(payload.error.allowed_models, ['deepseek-v4-pro'])
    assert.equal(upstreamCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('serves the local WebUI without sending browser routes upstream', async () => {
  let upstreamCalls = 0
  const upstream = http.createServer((_request, response) => {
    upstreamCalls += 1
    response.end('{}')
  })
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const root = await fetch(`http://127.0.0.1:${address.port}/`, {
      redirect: 'manual',
    })
    assert.equal(root.status, 302)
    assert.equal(root.headers.get('location'), '/__gateway/')

    const page = await fetch(`http://127.0.0.1:${address.port}/__gateway/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.match(await page.text(), /DeepSeek Boost Gateway/)

    const script = await fetch(`http://127.0.0.1:${address.port}/__gateway/app.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /^text\/javascript/)

    const missing = await fetch(`http://127.0.0.1:${address.port}/__gateway/missing.js`)
    assert.equal(missing.status, 404)
    assert.equal(upstreamCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('aggregates split data planes on a dedicated management WebUI listener', async () => {
  const pro = {
    gatewayConfig: {
      version: 'test',
      profile: 'pro',
      host: '127.0.0.1',
      port: 8643,
      mode: 'anchor',
      gatewayApiKeyConfigured: true,
      diagnosticHistoryLimit: 100,
      anchors: [{ model: 'deepseek-v4-pro', id: 'pro-anchor' }],
    },
    gatewayDiagnostics: () => [{
      profile: 'pro',
      requestId: '00000000-0000-0000-0000-000000000001',
      startedAt: '2026-08-16T00:00:00.000Z',
    }],
  }
  const flash = {
    gatewayConfig: {
      version: 'test',
      profile: 'flash',
      host: '127.0.0.1',
      port: 8644,
      mode: 'anchor',
      gatewayApiKeyConfigured: true,
      diagnosticHistoryLimit: 100,
      anchors: [{ model: 'deepseek-v4-flash', id: 'flash-anchor' }],
    },
    gatewayDiagnostics: () => [{
      profile: 'flash',
      requestId: '00000000-0000-0000-0000-000000000002',
      startedAt: '2026-08-16T00:00:01.000Z',
    }],
  }
  const management = createGatewayManagementServer({
    version: 'test',
    dataServers: [pro, flash],
  })
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const origin = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${origin}/__gateway/health`).then((response) => response.json())
    assert.equal(health.deploymentMode, 'split')
    assert.deepEqual(health.instances.map((instance) => instance.baseUrl), [
      'http://127.0.0.1:8643/v1',
      'http://127.0.0.1:8644/v1',
    ])
    assert.equal(health.anchors.length, 2)

    const diagnostics = await fetch(`${origin}/__gateway/diagnostics`).then((response) => response.json())
    assert.deepEqual(diagnostics.entries.map((entry) => entry.profile), ['flash', 'pro'])

    const page = await fetch(`${origin}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /DeepSeek Boost Gateway/)
  } finally {
    await close(management)
  }
})

test('management WebUI can update isolated profiles and start Anchor jobs without exposing keys', async () => {
  const updates = []
  const jobs = []
  let cleared = 0
  const profiles = [{
    name: 'pro',
    model: 'deepseek-v4-pro',
    enabled: true,
    port: 8643,
    apiKeyConfigured: true,
    anchorPath: 'anchors/pro.json',
  }]
  const management = createGatewayManagementServer({
    profileViews: () => profiles,
    updateProfile: async (name, patch) => {
      updates.push({ name, patch })
      return { ...profiles[0], ...patch }
    },
    anchorJobs: {
      list: () => jobs,
      get: (id) => jobs.find((job) => job.id === id) ?? null,
      start: (input) => {
        const job = { id: '00000000-0000-0000-0000-000000000099', status: 'running', ...input }
        jobs.push(job)
        return job
      },
    },
    clearDiagnostics: async () => {
      cleared += 2
      return 2
    },
  })
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const origin = `http://127.0.0.1:${address.port}`
    const config = await fetch(`${origin}/__gateway/config`).then((response) => response.json())
    assert.deepEqual(config.profiles, profiles)
    assert.equal(JSON.stringify(config).includes('secret'), false)

    const denied = await fetch(`${origin}/__gateway/config/profiles/pro`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9001 }),
    })
    assert.equal(denied.status, 403)

    const updated = await fetch(`${origin}/__gateway/config/profiles/pro`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ port: 9001, apiKey: 'new-secret' }),
    })
    assert.equal(updated.status, 200)
    assert.equal((await updated.text()).includes('new-secret'), false)
    assert.deepEqual(updates, [{
      name: 'pro',
      patch: { port: 9001, apiKey: 'new-secret' },
    }])

    const started = await fetch(`${origin}/__gateway/anchors/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({
        profile: 'pro',
        runs: 3,
        anchorPrompt: 'Inspect the synthetic workstream with both tools before continuing.',
      }),
    })
    assert.equal(started.status, 202)
    const job = await started.json()
    assert.equal(job.job.profile, 'pro')
    assert.equal(job.job.status, 'running')

    const refusedClear = await fetch(`${origin}/__gateway/diagnostics`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ confirmation: 'yes' }),
    })
    assert.equal(refusedClear.status, 400)
    assert.equal(cleared, 0)

    const acceptedClear = await fetch(`${origin}/__gateway/diagnostics`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ confirmation: '清空全部请求' }),
    })
    assert.equal(acceptedClear.status, 200)
    assert.equal((await acceptedClear.json()).deleted, 2)
    assert.equal(cleared, 2)
  } finally {
    await close(management)
  }
})

test('redacts credential-like URL parameters from diagnostics', () => {
  assert.equal(
    redactUrl('/v1/chat/completions?api_key=secret&beta=1'),
    '/v1/chat/completions?api_key=%5BREDACTED%5D&beta=1',
  )
})

test('transparently proxies JSON and records a redacted full exchange', async () => {
  const seen = []
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', reasoning_content: 'We need act.', content: 'done' },
        finish_reason: 'stop',
      }],
      usage: { total_tokens: 7 },
    }))
  })
  const upstreamAddress = await listen(upstream)
  const logDir = await mkdtemp(join(tmpdir(), 'deepseek-gateway-test-'))
  const logFile = join(logDir, 'traffic.jsonl')
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/api/v1`,
    gatewayApiKey: 'gateway-key',
    captureMode: 'full',
    logDir,
    logFile,
  })
  const gatewayAddress = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const payload = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    }
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer caller-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    )
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, 'done')
    assert.equal(seen[0].path, '/api/v1/chat/completions')
    assert.equal(seen[0].authorization, 'Bearer gateway-key')

    const exchange = JSON.parse((await readFile(logFile, 'utf8')).trim())
    assert.equal(exchange.request.credentialSource, 'gateway')
    assert.equal(exchange.request.headers.authorization, '[REDACTED]')
    assert.equal(exchange.request.summary.toolNames[0], 'read')
    assert.equal(exchange.response.summary.reasoningChars, 12)
    assert.equal(exchange.response.summary.contentChars, 4)
    assert.equal(exchange.response.summary.finishReasons[0], 'stop')
    assert.equal(exchange.response.summary.scope, 'current_response')
    assert.equal(exchange.response.summary.reasoning.markers.weNeed, 1)
    assert.equal(exchange.response.summary.reasoning.markers.letMe, 0)

    const diagnosticsResponse = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/__gateway/diagnostics?limit=1`,
    )
    const diagnostics = await diagnosticsResponse.json()
    assert.equal(diagnostics.entries.length, 1)
    assert.equal(diagnostics.entries[0].requestId, exchange.requestId)
    assert.equal(diagnostics.entries[0].response.summary.scope, 'current_response')
    assert.equal(diagnostics.entries[0].request.history.scope, 'request_history')
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('preserves SSE streaming and uses the Gateway-owned key', async () => {
  let authorization
  const upstream = http.createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"We need act. Let "}}]}\n\n')
    response.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"me verify."}}]}\n\n')
    response.write('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    gatewayApiKey: 'gateway-key',
    captureMode: 'off',
    captureLimitBytes: 24,
  })
  const gatewayAddress = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [] }),
      },
    )
    const body = await response.text()
    assert.match(body, /reasoning_content/)
    assert.match(body, /\[DONE\]/)
    assert.equal(authorization, 'Bearer gateway-key')

    const diagnostics = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    const entry = diagnostics.entries[0]
    assert.equal(entry.response.captureTruncated, true)
    assert.equal(entry.response.summary.observationTruncated, false)
    assert.equal(entry.response.summary.reasoning.markers.weNeed, 1)
    assert.equal(entry.response.summary.reasoning.markers.letMe, 1)
    assert.equal(entry.response.summary.complete, true)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('times out an unresponsive upstream and retains an error diagnostic', async () => {
  const upstream = http.createServer(() => {})
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    gatewayApiKey: 'gateway-key',
    upstreamTimeoutMs: 25,
    captureMode: 'off',
  })
  const gatewayAddress = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] }),
      },
    )
    const payload = await response.json()
    assert.equal(response.status, 502)
    assert.equal(payload.error.type, 'gateway_upstream_error')

    const diagnostics = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    assert.equal(diagnostics.entries[0].response.status, 502)
    assert.match(diagnostics.entries[0].response.error, /timed out|timeout|abort/i)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})
