import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  summarizeRequest,
} from '../src/gateway/proxy.mjs'
import { createGatewayManagementServer } from '../src/gateway/management-server.mjs'
import {
  listAnchorArtifacts,
  readAnchorArtifactContent,
} from '../src/gateway/anchor-catalog.mjs'

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

function testAnchor(id, marker) {
  const artifact = {
    kind: 'deepseek-v4-anchor-artifact',
    id,
    trajectory: {
      messages: [
        { role: 'user', content: marker },
        { role: 'assistant', content: 'ok' },
      ],
    },
  }
  const core = structuredClone(artifact)
  artifact.artifactFingerprint = createHash('sha256').update(JSON.stringify(core)).digest('hex')
  return { id, fingerprint: artifact.artifactFingerprint, artifact, path: `${id}.json` }
}

function createCapturingUpstream() {
  const seen = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    seen.push({
      host: request.headers.host,
      path: request.url,
      authorization: request.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    })
    response.setHeader('content-type', 'application/json')
    response.end('{}')
  })
  return { server, seen }
}

function userContents(body) {
  return (body?.messages ?? [])
    .filter((message) => message?.role === 'user')
    .map((message) => message.content)
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

test('clears diagnostics through the data-plane DELETE route', async () => {
  const gateway = createGatewayServer({ captureMode: 'off' })
  const address = await listenGateway(gateway, '127.0.0.1', 0)
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const failing = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }] }),
    })
    assert.equal(failing.status, 503)

    const before = await fetch(`${origin}/__gateway/diagnostics`)
      .then((response) => response.json())
    assert.ok(before.entries.length > 0)

    const missingMarker = await fetch(`${origin}/__gateway/diagnostics`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: '清空全部请求' }),
    })
    assert.equal(missingMarker.status, 403)

    const wrongConfirmation = await fetch(`${origin}/__gateway/diagnostics`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-gateway-management-request': '1' },
      body: JSON.stringify({ confirmation: 'yes' }),
    })
    assert.equal(wrongConfirmation.status, 400)

    const accepted = await fetch(`${origin}/__gateway/diagnostics`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-gateway-management-request': '1' },
      body: JSON.stringify({ confirmation: '清空全部请求' }),
    })
    assert.equal(accepted.status, 200)
    const cleared = await accepted.json()
    assert.equal(cleared.schemaVersion, 1)
    assert.ok(cleared.deleted >= 1)

    const after = await fetch(`${origin}/__gateway/diagnostics`)
      .then((response) => response.json())
    assert.equal(after.retained, 0)
    assert.deepEqual(after.entries, [])
  } finally {
    await close(gateway)
  }
})

test('records rawMessages for failure exchanges when the chat body parses', async () => {
  // 无 Key：请求被本地拒绝，但仍应保留 parse 出的原文。
  const noKey = createGatewayServer({ captureMode: 'off' })
  const noKeyAddress = await listenGateway(noKey, '127.0.0.1', 0)
  try {
    const response = await fetch(`http://127.0.0.1:${noKeyAddress.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: 'You are Kilo.' },
          { role: 'user', content: 'hello' },
        ],
      }),
    })
    assert.equal(response.status, 503)
    const diagnostics = await fetch(
      `http://127.0.0.1:${noKeyAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    const entry = diagnostics.entries[0]
    assert.equal(entry.response.status, 503)
    assert.deepEqual(entry.messages.request, [
      { role: 'system', content: 'You are Kilo.' },
      { role: 'user', content: 'hello' },
    ])
    assert.deepEqual(entry.messages.currentInput, [{ role: 'user', content: 'hello' }])
  } finally {
    await close(noKey)
  }

  // 模型不允许。
  const isolated = createGatewayServer({
    gatewayApiKey: 'gateway-key',
    allowedModels: ['deepseek-v4-pro'],
    captureMode: 'off',
  })
  const isolatedAddress = await listenGateway(isolated, '127.0.0.1', 0)
  try {
    const response = await fetch(`http://127.0.0.1:${isolatedAddress.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi flash' }],
      }),
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.error.type, 'gateway_model_not_allowed')
    const diagnostics = await fetch(
      `http://127.0.0.1:${isolatedAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    assert.deepEqual(diagnostics.entries[0].messages.request, [
      { role: 'user', content: 'hi flash' },
    ])
  } finally {
    await close(isolated)
  }

  // transform 失败：头部切到 anchor 但没有对应 Anchor。
  const transformFailed = createGatewayServer({
    gatewayApiKey: 'gateway-key',
    allowedModels: ['deepseek-v4-pro'],
    captureMode: 'off',
  })
  const transformAddress = await listenGateway(transformFailed, '127.0.0.1', 0)
  try {
    const response = await fetch(`http://127.0.0.1:${transformAddress.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-deepseek-boost-mode': 'anchor',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'anchor me' }],
      }),
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.error.type, 'gateway_anchor_not_configured')
    const diagnostics = await fetch(
      `http://127.0.0.1:${transformAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    assert.deepEqual(diagnostics.entries[0].messages.request, [
      { role: 'user', content: 'anchor me' },
    ])
  } finally {
    await close(transformFailed)
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
    const pageHtml = await page.text()
    assert.match(pageHtml, /DeepSeek Boost Gateway/)
    assert.match(pageHtml, /id="anchor-dialog"/)
    assert.match(pageHtml, /id="deployment-form"/)
    assert.match(pageHtml, /多模型路由口/)
    assert.match(pageHtml, /三端口 · 每端口一个模型/)
    assert.match(pageHtml, /按 request\.model 路由/)
    assert.match(pageHtml, /只读查看/)
    // The read-only viewer must not offer any edit/delete/overwrite controls.
    assert.equal(/data-edit-anchor|data-delete-anchor|data-overwrite-anchor/.test(pageHtml), false)

    const script = await fetch(`http://127.0.0.1:${address.port}/__gateway/app.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /^text\/javascript/)
    assert.match(await script.text(), /openAnchorView/)

    const missing = await fetch(`http://127.0.0.1:${address.port}/__gateway/missing.js`)
    assert.equal(missing.status, 404)
    assert.equal(upstreamCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('single listener can save a deployment mode for the next restart', async () => {
  let saved = null
  const upstream = http.createServer((_request, response) => response.end('{}'))
  const upstreamAddress = await listen(upstream)
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    deploymentMode: 'single',
    allowedModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    deploymentView: () => ({ mode: 'single', combinedPort: 8646 }),
    updateDeployment: async (patch) => {
      saved = patch
      return { ...patch, restartRequired: true }
    },
    listAnchors: async () => [],
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)
  try {
    const origin = `http://127.0.0.1:${address.port}`
    const config = await fetch(`${origin}/__gateway/config`).then((response) => response.json())
    assert.deepEqual(config.deployment, { mode: 'single', combinedPort: 8646 })
    const response = await fetch(`${origin}/__gateway/config/deployment`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ mode: 'split', combinedPort: 8646 }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(saved, { mode: 'split', combinedPort: 8646 })
    assert.equal((await response.json()).deployment.restartRequired, true)
    const anchors = await fetch(`${origin}/__gateway/anchors`).then((result) => result.json())
    assert.deepEqual(anchors.anchors, [])
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
  const deploymentUpdates = []
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
    deploymentView: () => ({ mode: 'split', combinedPort: 8646 }),
    updateDeployment: async (patch) => {
      deploymentUpdates.push(patch)
      return { ...patch, restartRequired: true }
    },
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
      getCandidate: async (id, index) => {
        if (id !== '00000000-0000-0000-0000-000000000099') throw Object.assign(
          new Error('Anchor job not found.'),
          { statusCode: 404 },
        )
        if (Number(index) !== 1) throw Object.assign(
          new Error(`Candidate ${index} is not part of job ${id}.`),
          { statusCode: 400 },
        )
        return {
          candidateIndex: 1,
          messages: [{ role: 'user', content: 'Begin.' }],
          assistantTurns: [],
        }
      },
      select: async (id, input) => {
        const job = jobs.find((item) => item.id === id)
        if (!job) throw Object.assign(new Error('Anchor job not found.'), { statusCode: 404 })
        const candidate = input && typeof input === 'object' ? input.candidate : input
        return { ...job, status: 'freezing', selectedCandidate: candidate }
      },
      discard: (id) => {
        const job = jobs.find((item) => item.id === id)
        if (!job) throw Object.assign(new Error('Anchor job not found.'), { statusCode: 404 })
        return { ...job, status: 'discarded' }
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
    assert.deepEqual(config.deployment, { mode: 'split', combinedPort: 8646 })
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

    const visionUpdated = await fetch(`${origin}/__gateway/config/profiles/vision`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ port: 9002, enhancementMode: 'bypass' }),
    })
    assert.equal(visionUpdated.status, 200)
    assert.deepEqual(updates.at(-1), {
      name: 'vision',
      patch: { port: 9002, enhancementMode: 'bypass' },
    })

    const deployment = await fetch(`${origin}/__gateway/config/deployment`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ mode: 'all', combinedPort: 8646 }),
    })
    assert.equal(deployment.status, 200)
    assert.deepEqual(deploymentUpdates, [{ mode: 'all', combinedPort: 8646 }])
    assert.equal((await deployment.json()).deployment.restartRequired, true)

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

    const conversation = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-000000000099/candidates/1`)
    assert.equal(conversation.status, 200)
    const payload = await conversation.json()
    assert.equal(payload.candidate.candidateIndex, 1)
    assert.equal(payload.candidate.messages[0].content, 'Begin.')

    const missingCandidate = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-000000000099/candidates/4`)
    assert.equal(missingCandidate.status, 400)
    const missingJob = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-0000000000ff/candidates/1`)
    assert.equal(missingJob.status, 404)

    const selected = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-000000000099/select`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ candidate: 2 }),
    })
    assert.equal(selected.status, 202)
    const selectedJob = await selected.json()
    assert.equal(selectedJob.job.status, 'freezing')
    assert.equal(selectedJob.job.selectedCandidate, 2)

    const discarded = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-000000000099/discard`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({}),
    })
    assert.equal(discarded.status, 202)
    assert.equal((await discarded.json()).job.status, 'discarded')

    const unauthorizedAction = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-000000000099/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidate: 1 }),
    })
    assert.equal(unauthorizedAction.status, 403)

    const unknownAction = await fetch(`${origin}/__gateway/anchors/jobs/00000000-0000-0000-0000-0000000000ff/select`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ candidate: 1 }),
    })
    assert.equal(unknownAction.status, 404)

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

test('serves read-only Anchor content without leaking files outside the catalog', async () => {
  const management = createGatewayManagementServer({
    listAnchors: () => listAnchorArtifacts(),
    readAnchorContent: (input) => readAnchorArtifactContent(input),
  })
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const origin = `http://127.0.0.1:${address.port}`
    const catalog = await listAnchorArtifacts()
    const pro = catalog.find((entry) => (
      entry.bundledDefault && entry.model === 'deepseek-v4-pro'
    ))
    assert.ok(pro)

    const content = await fetch(
      `${origin}/__gateway/anchors/content?path=${encodeURIComponent(pro.path)}`,
    )
    assert.equal(content.status, 200)
    const payload = await content.json()
    assert.equal(payload.schemaVersion, 1)
    assert.equal(payload.anchor.id, pro.id)
    assert.equal(payload.anchor.model, pro.model)
    assert.equal(payload.anchor.fingerprint, pro.fingerprint)
    assert.equal(payload.anchor.bundledDefault, true)
    assert.ok(Array.isArray(payload.anchor.messages))
    assert.equal(payload.anchor.messages.at(-1).role, 'assistant')
    // The content API serves the same v3 trajectory summary as request details:
    // reasoning.cot + markers for the read-only viewer.
    assert.equal(payload.anchor.trajectoryStats.scope, 'anchor_trajectory')
    assert.equal(typeof payload.anchor.trajectoryStats.reasoning.cot.label, 'string')
    assert.ok(payload.anchor.trajectoryStats.reasoning.markers)
    assert.equal(JSON.stringify(payload).includes('apiKey'), false)

    const traversal = await fetch(
      `${origin}/__gateway/anchors/content?path=${encodeURIComponent('..\\package.json')}`,
    )
    assert.equal(traversal.status, 400)
    assert.equal((await traversal.json()).error.type, 'gateway_anchor_content_rejected')

    const missing = await fetch(
      `${origin}/__gateway/anchors/content?path=${encodeURIComponent('anchors/does-not-exist.json')}`,
    )
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.type, 'gateway_anchor_not_found')

    const noParams = await fetch(`${origin}/__gateway/anchors/content`)
    assert.equal(noParams.status, 400)

    const bothParams = await fetch(
      `${origin}/__gateway/anchors/content?path=${encodeURIComponent(pro.path)}&id=${encodeURIComponent(pro.id)}`,
    )
    assert.equal(bothParams.status, 400)

    const byId = await fetch(
      `${origin}/__gateway/anchors/content?id=${encodeURIComponent(pro.id)}`,
    )
    assert.equal(byId.status, 200)
    assert.equal((await byId.json()).anchor.id, pro.id)
  } finally {
    await close(management)
  }
})

test('reports 501 when the management node has no read-only Anchor callback', async () => {
  const management = createGatewayManagementServer({})
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/__gateway/anchors/content?path=anchors/x.json`,
    )
    assert.equal(response.status, 501)
  } finally {
    await close(management)
  }
})

test('deletes a user Anchor through the management route when not referenced', async () => {
  const received = []
  const management = createGatewayManagementServer({
    deleteAnchor: async (input) => {
      received.push(input)
      return {
        id: 'user-a',
        path: 'anchors/user-a.json',
        displayName: 'user-a',
        model: 'deepseek-v4-flash',
      }
    },
  })
  const address = await listenGateway(management, '127.0.0.1', 0)
  const origin = `http://127.0.0.1:${address.port}`
  const mutationHeaders = {
    'content-type': 'application/json',
    'x-gateway-management-request': '1',
  }

  try {
    const byPath = await fetch(`${origin}/__gateway/anchors`, {
      method: 'DELETE',
      headers: mutationHeaders,
      body: JSON.stringify({ path: 'anchors/user-a.json' }),
    })
    assert.equal(byPath.status, 200)
    const payload = await byPath.json()
    assert.equal(payload.schemaVersion, 1)
    assert.deepEqual(payload.deleted, { id: 'user-a', path: 'anchors/user-a.json' })
    assert.deepEqual(received, [{ path: 'anchors/user-a.json' }])

    // Query-string fallback with an empty JSON body.
    const byQuery = await fetch(`${origin}/__gateway/anchors?id=user-b`, {
      method: 'DELETE',
      headers: mutationHeaders,
      body: '{}',
    })
    assert.equal(byQuery.status, 200)
    assert.deepEqual(received.at(-1), { id: 'user-b' })

    // Mutations without the same-app marker are refused.
    const unmarked = await fetch(`${origin}/__gateway/anchors`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'anchors/user-a.json' }),
    })
    assert.equal(unmarked.status, 403)
    assert.equal((await unmarked.json()).error.type, 'gateway_management_mutation_forbidden')
  } finally {
    await close(management)
  }
})

test('reports 409 with referencedBy when deleting a bound Anchor', async () => {
  const management = createGatewayManagementServer({
    deleteAnchor: async () => {
      const error = new Error('Anchor is referenced by: pro, flash.')
      error.statusCode = 409
      error.type = 'gateway_anchor_in_use'
      error.referencedBy = ['pro', 'flash']
      throw error
    },
  })
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/__gateway/anchors`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ path: 'anchors/user-a.json' }),
    })
    assert.equal(response.status, 409)
    const payload = await response.json()
    assert.equal(payload.error.type, 'gateway_anchor_in_use')
    assert.deepEqual(payload.error.referencedBy, ['pro', 'flash'])
    assert.equal(typeof payload.error.message, 'string')
  } finally {
    await close(management)
  }
})

test('reports 501 when the management node has no Anchor delete callback', async () => {
  const management = createGatewayManagementServer({})
  const address = await listenGateway(management, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/__gateway/anchors`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ path: 'anchors/x.json' }),
    })
    assert.equal(response.status, 501)
    assert.equal((await response.json()).error.type, 'gateway_anchor_delete_unavailable')
  } finally {
    await close(management)
  }
})

test('combined listener deletes an unbound user Anchor through the same route', async () => {
  const received = []
  const gateway = createGatewayServer({
    deploymentMode: 'single',
    allowedModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    listAnchors: async () => [],
    deleteAnchor: async (input) => {
      received.push(input)
      return {
        id: 'user-a',
        path: 'anchors/user-a.json',
        displayName: 'user-a',
        model: 'deepseek-v4-flash',
      }
    },
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/__gateway/anchors`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ id: 'user-a' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.schemaVersion, 1)
    assert.deepEqual(payload.deleted, { id: 'user-a', path: 'anchors/user-a.json' })
    assert.deepEqual(received, [{ id: 'user-a' }])
  } finally {
    await close(gateway)
  }
})

test('redacts credential-like URL parameters from diagnostics', () => {
  assert.equal(
    redactUrl('/v1/chat/completions?api_key=secret&beta=1'),
    '/v1/chat/completions?api_key=%5BREDACTED%5D&beta=1',
  )
})

test('summarizeRequest breaks input characters down by role', () => {
  const summary = summarizeRequest(JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'You are precise.' },
      { role: 'user', content: '检查仓库。' },
      { role: 'assistant', content: 'We need inspect.', tool_calls: [] },
      { role: 'tool', tool_call_id: 'c1', content: 'repo listing' },
    ],
    tools: [{ type: 'function', function: { name: 'bash' } }],
  }))

  assert.equal(summary.json, true)
  assert.equal(summary.messageCount, 4)
  assert.equal(summary.chars.system, 'You are precise.'.length)
  assert.equal(summary.chars.user, '检查仓库。'.length)
  assert.equal(summary.chars.assistant, 'We need inspect.'.length)
  assert.equal(summary.chars.tool, 'repo listing'.length)
  assert.equal(
    summary.chars.total,
    'You are precise.'.length + '检查仓库。'.length + 'We need inspect.'.length + 'repo listing'.length,
  )
  assert.equal(summarizeRequest('not json').json, false)
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
    // usage carries only total_tokens; the normalized tokens stay all-null.
    assert.equal(exchange.response.summary.tokens.input, null)
    assert.equal(exchange.response.summary.tokens.output, null)
    assert.equal(exchange.response.summary.tokens.cacheInput, null)

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
    // Interrupted observation without a terminal usage chunk: no tokens field.
    assert.equal(entry.response.summary.tokens, null)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('injects stream_options.include_usage and stores raw messages for local viewing', async () => {
  let receivedBody = null
  const upstream = http.createServer((request, response) => {
    request.on('data', (chunk) => { receivedBody = (receivedBody ?? '') + chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          index: 0,
          message: { role: 'assistant', reasoning_content: 'We need check.', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_cache_hit_tokens: 6,
          prompt_cache_miss_tokens: 4,
        },
      }))
    })
  })
  const upstreamAddress = await listen(upstream)
  const logDir = await mkdtemp(join(tmpdir(), 'deepseek-gateway-streamusage-'))
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    gatewayApiKey: 'gateway-key',
    captureMode: 'off',
    logDir,
  })
  const gatewayAddress = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: true,
          messages: [{ role: 'user', content: 'look' }],
        }),
      },
    )
    assert.equal(response.status, 200)
    const parsed = JSON.parse(receivedBody)
    assert.equal(parsed.stream, true)
    assert.deepEqual(parsed.stream_options, { include_usage: true })

    const diagnostics = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/__gateway/diagnostics?limit=1`,
    ).then((result) => result.json())
    const entry = diagnostics.entries[0]
    assert.deepEqual(entry.messages.request[0], { role: 'user', content: 'look' })
    assert.deepEqual(entry.messages.currentInput, [{ role: 'user', content: 'look' }])
    assert.equal(entry.messages.response[0].reasoning_content, 'We need check.')
    assert.equal(entry.messages.response[0].content, 'ok')
    assert.equal(entry.response.summary.usage.prompt_cache_hit_tokens, 6)
    assert.equal(entry.response.summary.cache.hitRate, 0.6)
    assert.equal(entry.response.summary.tokens.input, 10)
    assert.equal(entry.response.summary.tokens.output, 4)
    assert.equal(entry.response.summary.tokens.reasoning, null)
    assert.equal(entry.response.summary.tokens.content, null)
    assert.equal(entry.response.summary.tokens.cacheInput, 6)
    assert.equal(entry.response.summary.tokens.uncachedInput, 4)
    assert.equal(entry.response.summary.tokens.hitRate, 0.6)
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

test('multi-model listener routes host, key, mode, Anchor, and micro-anchor per plane', async () => {
  const proUpstream = createCapturingUpstream()
  const flashUpstream = createCapturingUpstream()
  const nextFlashUpstream = createCapturingUpstream()
  const proAddress = await listen(proUpstream.server)
  const flashAddress = await listen(flashUpstream.server)
  const nextFlashAddress = await listen(nextFlashUpstream.server)
  const proAnchor = testAnchor('pro-plane-anchor', 'PRO-ANCHOR-MARKER')
  const proUrl = `http://127.0.0.1:${proAddress.port}`
  const flashUrl = `http://127.0.0.1:${flashAddress.port}`
  const nextFlashUrl = `http://127.0.0.1:${nextFlashAddress.port}`
  const planes = () => ([
    {
      name: 'pro',
      model: 'deepseek-v4-pro',
      enabled: true,
      upstreamBaseUrl: proUrl,
      gatewayApiKey: 'pro-key',
      defaultMode: 'anchor',
      anchors: { 'deepseek-v4-pro': proAnchor },
      microAnchors: { 'deepseek-v4-pro': { enabled: true, content: 'PRO-MICRO' } },
    },
    {
      name: 'flash',
      model: 'deepseek-v4-flash',
      enabled: true,
      upstreamBaseUrl: flashUrl,
      gatewayApiKey: 'flash-key',
      defaultMode: 'bypass',
      microAnchors: { 'deepseek-v4-flash': { enabled: true, content: 'FLASH-MICRO' } },
    },
    {
      name: 'vision',
      model: 'deepseek-v4-flash-vision-exp',
      enabled: false,
      upstreamBaseUrl: proUrl,
      gatewayApiKey: 'vision-key',
      defaultMode: 'bypass',
    },
  ])
  const gateway = createGatewayServer({
    profileName: 'single',
    deploymentMode: 'single',
    allowedModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    modelPlanes: planes(),
    captureMode: 'off',
    webUiEnabled: false,
    updateProfile: async (name, patch) => {
      assert.equal(name, 'flash')
      gateway.replacePlane({
        ...planes()[1],
        upstreamBaseUrl: patch.upstreamBaseUrl,
      })
      return {
        profile: { name: 'flash' },
        documentView: { schemaVersion: 1 },
        restartRequired: false,
        pendingRestart: false,
      }
    },
    anchorJobs: { list: () => [] },
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const health = await fetch(`${origin}/__gateway/health`).then((response) => response.json())
    assert.equal(health.mode, undefined)
    assert.equal(health.upstreamBaseUrl, undefined)
    assert.equal(health.planes.length, 3)
    assert.equal(health.gatewayApiKeyConfigured, true)
    assert.equal(health.allGatewayApiKeysConfigured, true)
    assert.equal(health.gatewayApiKeyConfiguredCount, 3)

    const config = await fetch(`${origin}/__gateway/config`).then((response) => response.json())
    assert.equal(config.profiles.length, 3)
    assert.deepEqual(config.profiles.map((profile) => profile.name), ['pro', 'flash', 'vision'])

    const models = await fetch(`${origin}/v1/models`).then((response) => response.json())
    assert.deepEqual(models.data.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-v4-flash'])

    const jobs = await fetch(`${origin}/__gateway/anchors/jobs`).then((response) => response.json())
    assert.equal(jobs.schemaVersion, 1)
    assert.deepEqual(jobs.jobs, [])

    const missingModel = await fetch(`${origin}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x' }),
    }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    assert.equal(missingModel.status, 400)
    assert.equal(missingModel.payload.error.type, 'gateway_model_required')

    const proResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-must-not-win',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hello-pro' }],
      }),
    })
    assert.equal(proResponse.status, 200)
    assert.equal(proUpstream.seen.length, 1)
    assert.equal(proUpstream.seen[0].authorization, 'Bearer pro-key')
    assert.equal(proUpstream.seen[0].host, `127.0.0.1:${proAddress.port}`)
    assert.equal(userContents(proUpstream.seen[0].body).includes('PRO-ANCHOR-MARKER'), true)
    assert.match(userContents(proUpstream.seen[0].body).at(-1), /hello-pro\n\nPRO-MICRO$/)
    assert.equal(JSON.stringify(proUpstream.seen[0].body).includes('FLASH-MICRO'), false)

    const flashResponse = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-must-not-win',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello-flash' }],
      }),
    })
    assert.equal(flashResponse.status, 200)
    assert.equal(flashUpstream.seen.length, 1)
    assert.equal(flashUpstream.seen[0].authorization, 'Bearer flash-key')
    assert.equal(flashUpstream.seen[0].host, `127.0.0.1:${flashAddress.port}`)
    assert.equal(userContents(flashUpstream.seen[0].body).includes('PRO-ANCHOR-MARKER'), false)
    assert.deepEqual(userContents(flashUpstream.seen[0].body), ['hello-flash\n\nFLASH-MICRO'])
    assert.equal(JSON.stringify(flashUpstream.seen[0].body).includes('PRO-MICRO'), false)

    const diagnostics = await fetch(`${origin}/__gateway/diagnostics?limit=2`)
      .then((response) => response.json())
    const modes = Object.fromEntries(
      diagnostics.entries.map((entry) => [entry.request.model, entry.mode]),
    )
    assert.equal(modes['deepseek-v4-pro'], 'anchor')
    assert.equal(modes['deepseek-v4-flash'], 'bypass')

    const unknown = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [] }),
    }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    assert.equal(unknown.status, 400)
    assert.equal(unknown.payload.error.type, 'gateway_model_not_allowed')

    const disabled = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-vision-exp',
        messages: [{ role: 'user', content: 'vision' }],
      }),
    }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    assert.equal(disabled.status, 400)
    assert.equal(disabled.payload.error.type, 'gateway_model_not_allowed')
    assert.match(disabled.payload.error.message, /not enabled/)

    gateway.replacePlane({
      name: 'vision',
      model: 'deepseek-v4-flash-vision-exp',
      enabled: true,
      upstreamBaseUrl: proUrl,
      gatewayApiKey: '',
      defaultMode: 'bypass',
    })
    const missingKey = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-must-not-win',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-vision-exp',
        messages: [{ role: 'user', content: 'vision' }],
      }),
    }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    assert.equal(missingKey.status, 503)
    assert.equal(missingKey.payload.error.type, 'gateway_upstream_api_key_not_configured')

    const stillPro = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'still-pro' }],
      }),
    })
    assert.equal(stillPro.status, 200)
    assert.equal(proUpstream.seen.length, 2)
    assert.equal(proUpstream.seen[1].authorization, 'Bearer pro-key')

    const forwarded = await fetch(`${origin}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'x' }),
    })
    assert.equal(forwarded.status, 200)
    assert.equal(flashUpstream.seen.length, 2)
    assert.equal(flashUpstream.seen[1].authorization, 'Bearer flash-key')
    assert.equal(flashUpstream.seen[1].body.input, 'x')

    const patched = await fetch(`${origin}/__gateway/config/profiles/flash`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ upstreamBaseUrl: nextFlashUrl }),
    }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    assert.equal(patched.status, 200)
    assert.equal(patched.payload.restartRequired, false)

    const afterSwap = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello-flash-2' }],
      }),
    })
    assert.equal(afterSwap.status, 200)
    assert.equal(flashUpstream.seen.length, 2)
    assert.equal(nextFlashUpstream.seen.length, 1)
    assert.equal(nextFlashUpstream.seen[0].authorization, 'Bearer flash-key')
    assert.equal(nextFlashUpstream.seen[0].host, `127.0.0.1:${nextFlashAddress.port}`)
    assert.deepEqual(userContents(nextFlashUpstream.seen[0].body), ['hello-flash-2\n\nFLASH-MICRO'])

    const proAfterSwap = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'after-swap' }],
      }),
    })
    assert.equal(proAfterSwap.status, 200)
    assert.equal(proUpstream.seen.length, 3)
    assert.equal(proUpstream.seen[2].host, `127.0.0.1:${proAddress.port}`)
    assert.equal(proUpstream.seen[2].authorization, 'Bearer pro-key')
  } finally {
    await close(gateway)
    await close(proUpstream.server)
    await close(flashUpstream.server)
    await close(nextFlashUpstream.server)
  }
})
