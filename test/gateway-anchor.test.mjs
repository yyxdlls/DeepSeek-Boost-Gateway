import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import {
  ENVIRONMENT_SWITCH_MESSAGE,
  applyAnchorToChatRequest,
  loadAnchorArtifact,
} from '../src/gateway/anchor.mjs'
import { buildDshMinimalTools } from '../src/lab/profile.mjs'
import { createGatewayServer, listenGateway } from '../src/gateway/proxy.mjs'

async function close(server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

test('loads the frozen anchor only after fingerprint verification', async () => {
  const loaded = await loadAnchorArtifact()
  assert.equal(loaded.id, 'deepseek-v4-pro-open-workstream-20260824101411-f2a74161')
  assert.equal(
    loaded.fingerprint,
    'ce8cd1288feed85d2e0e087b3f45334c5c63bd308961de537d3734abc349d212',
  )
  assert.equal(loaded.artifact.trajectory.messages.length, 10)
})

test('prepends the immutable trajectory and keeps only current Harness tools', async () => {
  const loaded = await loadAnchorArtifact()
  const currentTools = [{
    type: 'function',
    function: { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
  }]
  const source = {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'You are Kilo.' },
      { role: 'user', content: 'Build a welcome page.' },
    ],
    tools: currentTools,
    stream: true,
  }
  const transformed = applyAnchorToChatRequest(source, loaded)
  const anchorLength = loaded.artifact.trajectory.messages.length

  assert.deepEqual(
    transformed.payload.messages.slice(0, anchorLength),
    loaded.artifact.trajectory.messages,
  )
  assert.match(transformed.payload.messages[anchorLength].content, new RegExp(loaded.artifact.continuation.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(transformed.payload.messages[anchorLength].content, /You are Kilo\./)
  assert.deepEqual(transformed.payload.messages[anchorLength + 1], source.messages[1])
  assert.deepEqual(transformed.payload.tools, currentTools)
  assert.deepEqual(
    transformed.payload.tools.map((tool) => tool.function.name),
    ['read'],
  )
  assert.notDeepEqual(
    transformed.payload.tools.map((tool) => tool.function.name),
    buildDshMinimalTools().map((tool) => tool.function.name),
  )
  assert.equal(transformed.metrics.anchorMessageCount, anchorLength)
  assert.ok(Number(transformed.metrics.anchorMessageBytes) > 0)
  assert.equal(transformed.metrics.bootstrapToolsAddedToCurrentRequest, 0)
  assert.equal(transformed.metrics.originalSystemChars, 13)
  assert.equal(transformed.metrics.anchorHistory.scope, 'anchor_history')
  assert.deepEqual(
    transformed.metrics.anchorHistory.tools.names,
    ['bash', 'str_replace_editor'],
  )
  assert.equal(transformed.metrics.anchorHistory.reasoning.markers.letMe, 0)
})

test('does not mutate the caller request while transforming it', async () => {
  const loaded = await loadAnchorArtifact()
  const source = {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  }
  const before = structuredClone(source)
  applyAnchorToChatRequest(source, loaded)
  assert.deepEqual(source, before)
})

test('uses an artifact-specific active-workstream continuation', async () => {
  const loaded = await loadAnchorArtifact()
  const artifact = structuredClone(loaded.artifact)
  delete artifact.artifactFingerprint
  artifact.id = 'open-test'
  artifact.continuation = {
    mode: 'same-active-workstream',
    message: 'Continue the same active workstream with the next requirement.',
  }
  artifact.artifactFingerprint = createHash('sha256')
    .update(JSON.stringify(artifact))
    .digest('hex')

  const transformed = applyAnchorToChatRequest({
    messages: [{ role: 'user', content: 'Next requirement.' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
  }, artifact)

  const anchorLength = artifact.trajectory.messages.length
  assert.equal(artifact.trajectory.messages.at(-1).role, 'assistant')
  assert.equal(
    transformed.payload.messages[anchorLength].content,
    `${artifact.continuation.message}\n\nHarness instructions to follow as we continue working:\n\n(none supplied)`,
  )
  assert.match(
    transformed.payload.messages[anchorLength].content,
    /Harness instructions to follow as we continue working/,
  )
  assert.doesNotMatch(
    transformed.payload.messages[anchorLength].content,
    /current task/i,
  )
  assert.deepEqual(
    transformed.payload.messages[anchorLength + 1],
    { role: 'user', content: 'Next requirement.' },
  )
  assert.equal(transformed.metrics.continuationMode, 'same-active-workstream')
  assert.deepEqual(transformed.payload.tools.map((tool) => tool.function.name), ['read'])
})

test('v2 artifacts without continuation only build the current Harness bridge', () => {
  const artifact = {
    schemaVersion: 2,
    kind: 'deepseek-v4-anchor-artifact',
    id: 'v2-empty-continuation',
    displayName: 'V2 空 continuation',
    trajectory: {
      messages: [
        { role: 'user', content: 'Begin.' },
        { role: 'assistant', content: 'Ready.', reasoning_content: '' },
      ],
    },
  }
  delete artifact.artifactFingerprint
  artifact.artifactFingerprint = createHash('sha256')
    .update(JSON.stringify(artifact))
    .digest('hex')

  const transformed = applyAnchorToChatRequest({
    messages: [{ role: 'user', content: 'Task.' }],
  }, artifact)

  assert.equal(
    transformed.payload.messages[2].content,
    'Current Harness instructions (authoritative for the current task):\n\n(none supplied)',
  )
  assert.doesNotMatch(
    transformed.payload.messages[2].content,
    new RegExp(ENVIRONMENT_SWITCH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  assert.equal(transformed.metrics.environmentSwitchChars, 0)
})

test('keeps the completed-bootstrap transition for the v1 control artifact', async () => {
  const loaded = await loadAnchorArtifact('anchors/dsh-minimal-two-tool-v1.json')
  const transformed = applyAnchorToChatRequest({
    messages: [{ role: 'user', content: 'Task.' }],
  }, loaded)
  assert.match(
    transformed.payload.messages[loaded.artifact.trajectory.messages.length].content,
    new RegExp(ENVIRONMENT_SWITCH_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )
  assert.equal(transformed.metrics.continuationMode, 'completed-bootstrap')
})

test('sends the anchored body to an upstream while preserving current tools', async () => {
  const loaded = await loadAnchorArtifact()
  let received
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    gatewayApiKey: 'gateway-key',
    defaultMode: 'anchor',
    anchor: loaded,
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'system', content: 'Harness system.' }, { role: 'user', content: 'Task.' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      }),
    })
    assert.equal(response.status, 200)
    const anchorLength = loaded.artifact.trajectory.messages.length
    assert.equal(received.messages.length, anchorLength + 2)
    assert.deepEqual(received.messages.slice(0, anchorLength), loaded.artifact.trajectory.messages)
    assert.match(received.messages[anchorLength].content, /Harness system\./)
    assert.deepEqual(received.tools.map((tool) => tool.function.name), ['read'])
  } finally {
    await close(gateway)
    await close(upstream)
  }
})

test('refuses to replay a Pro anchor into a Flash request', async () => {
  const loaded = await loadAnchorArtifact()
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    response.end('{}')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    gatewayApiKey: 'gateway-key',
    defaultMode: 'anchor',
    anchor: loaded,
    captureMode: 'off',
  })
  const address = await listenGateway(gateway, '127.0.0.1', 0)

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'Task.' }],
      }),
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.error.type, 'gateway_anchor_not_configured')
    assert.equal(upstreamCalls, 0)
  } finally {
    await close(gateway)
    await close(upstream)
  }
})
