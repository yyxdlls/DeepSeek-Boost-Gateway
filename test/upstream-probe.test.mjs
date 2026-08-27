import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { createGatewayManagementServer } from '../src/gateway/management-server.mjs'
import {
  chatCompletionsUrl,
  probeManagedProfile,
  probeUpstream,
} from '../src/gateway/upstream-probe.mjs'

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

function completionServer(handler) {
  return http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      handler({
        request,
        response,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
    })
  })
}

test('chatCompletionsUrl appends the chat completions path', () => {
  assert.equal(
    chatCompletionsUrl('https://api.example/v1'),
    'https://api.example/v1/chat/completions',
  )
  assert.equal(
    chatCompletionsUrl('https://api.example/v1/chat/completions'),
    'https://api.example/v1/chat/completions',
  )
})

test('probeUpstream fails fast without an API key', async () => {
  const result = await probeUpstream({
    baseUrl: 'https://api.example',
    model: 'deepseek-v4-pro',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /API Key/)
})

test('probeUpstream treats a 你好 reply as success', async () => {
  const upstream = completionServer(({ request, response, body }) => {
    assert.equal(request.headers.authorization, 'Bearer secret-key')
    assert.equal(body.model, 'provider-pro-slug')
    assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])
    assert.equal(body.stream, false)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '你好，我是测试模型。' } }],
    }))
  })
  const address = await listen(upstream)
  try {
    const result = await probeUpstream({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'secret-key',
      model: 'deepseek-v4-pro',
      upstreamModel: 'provider-pro-slug',
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.model, 'deepseek-v4-pro')
    assert.equal(result.upstreamModel, 'provider-pro-slug')
    assert.match(result.reply, /你好，我是测试模型/)
  } finally {
    await close(upstream)
  }
})

test('probeUpstream accepts reasoning-only replies', async () => {
  const upstream = completionServer(({ response }) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '先打个招呼。' } }],
    }))
  })
  const address = await listen(upstream)
  try {
    const result = await probeUpstream({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'k',
      model: 'deepseek-v4-pro',
    })
    assert.equal(result.ok, true)
    assert.equal(result.reply, '先打个招呼。')
  } finally {
    await close(upstream)
  }
})

test('probeUpstream reports HTTP and empty-reply failures without leaking the key', async () => {
  const upstream = completionServer(({ response }) => {
    response.statusCode = 401
    response.end(JSON.stringify({ error: { message: 'invalid secret-key' } }))
  })
  const address = await listen(upstream)
  try {
    const result = await probeUpstream({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'secret-key',
      model: 'deepseek-v4-flash',
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
    assert.match(result.error, /invalid/)
    assert.equal(result.error.includes('secret-key'), false)
  } finally {
    await close(upstream)
  }
})

test('probeManagedProfile 404s for a missing profile', async () => {
  await assert.rejects(
    () => probeManagedProfile(null),
    (error) => error.statusCode === 404,
  )
})

test('management probe route returns the 你好 reply', async () => {
  const upstream = completionServer(({ response, body }) => {
    assert.equal(body.messages[0].content, '你好')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '收到。' } }],
    }))
  })
  const upstreamAddress = await listen(upstream)
  const management = createGatewayManagementServer({
    probeProfile: (name) => probeManagedProfile({
      name,
      models: ['deepseek-v4-pro'],
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      gatewayApiKey: 'probe-key',
      upstreamModel: '',
    }),
  })
  const address = await listen(management)
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/__gateway/config/profiles/pro/probe`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-management-request': '1',
        },
        body: '{}',
      },
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.profile, 'pro')
    assert.equal(payload.reply, '收到。')
  } finally {
    await close(management)
    await close(upstream)
  }
})
