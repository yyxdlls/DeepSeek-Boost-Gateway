import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadProfileAnchors, startGatewayProfile } from '../src/gateway/gateway-instance.mjs'

function profile(overrides = {}) {
  return {
    name: 'flash',
    models: ['deepseek-v4-flash'],
    anchorPaths: { 'deepseek-v4-flash': '' },
    defaultMode: 'bypass',
    ...overrides,
  }
}

function visionProfile(overrides = {}) {
  return profile({
    name: 'vision',
    models: ['deepseek-v4-flash-vision-exp'],
    anchorPaths: { 'deepseek-v4-flash-vision-exp': '' },
    ...overrides,
  })
}

test('Flash and Vision load an empty anchor set when bypassing without a path', async () => {
  const flash = await loadProfileAnchors(profile())
  const vision = await loadProfileAnchors(visionProfile())
  assert.deepEqual(flash, {})
  assert.deepEqual(vision, {})
})

test('Flash and Vision anchor mode without a model-native path fails clearly', async () => {
  await assert.rejects(
    () => loadProfileAnchors(profile({ defaultMode: 'anchor' })),
    /GATEWAY_FLASH_ANCHOR_PATH is required when deepseek-v4-flash uses anchor mode/,
  )
  await assert.rejects(
    () => loadProfileAnchors(visionProfile({ defaultMode: 'anchor' })),
    /GATEWAY_VISION_ANCHOR_PATH is required when deepseek-v4-flash-vision-exp uses anchor mode/,
  )
})

test('Pro explicit empty path plus bypass does not inherit the bundled default', async () => {
  const anchors = await loadProfileAnchors({
    name: 'pro',
    models: ['deepseek-v4-pro'],
    anchorPaths: { 'deepseek-v4-pro': '' },
    defaultMode: 'bypass',
  })
  assert.deepEqual(anchors, {})
})

test('Pro explicit empty path plus anchor mode fails closed', async () => {
  await assert.rejects(
    () => loadProfileAnchors({
      name: 'pro',
      models: ['deepseek-v4-pro'],
      anchorPaths: { 'deepseek-v4-pro': '' },
      defaultMode: 'anchor',
    }),
    /GATEWAY_PRO_ANCHOR_PATH is required when deepseek-v4-pro uses anchor mode/,
  )
})

test('multi-model listeners load a path even when that plane defaults to bypass', async () => {
  const source = JSON.parse(await readFile(
    new URL('../anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json', import.meta.url),
    'utf8',
  ))
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-anchor-'))
  const path = join(directory, 'pro-for-header-switch.json')
  await writeFile(path, JSON.stringify(source), 'utf8')
  const anchors = await loadProfileAnchors({
    name: 'single',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    planes: [
      {
        name: 'pro',
        model: 'deepseek-v4-pro',
        enabled: true,
        defaultMode: 'bypass',
        gatewayApiKey: 'pro-key',
        anchorPath: path,
      },
      {
        name: 'flash',
        model: 'deepseek-v4-flash',
        enabled: true,
        defaultMode: 'bypass',
        gatewayApiKey: 'flash-key',
        anchorPath: '',
      },
    ],
    anchorPaths: {
      'deepseek-v4-pro': path,
      'deepseek-v4-flash': '',
    },
  })
  assert.equal(anchors['deepseek-v4-pro'].id, source.id)
  assert.equal(anchors['deepseek-v4-flash'], undefined)
})

test('rejects copied baselines instead of treating them as model-native Anchors', async () => {
  const source = JSON.parse(await readFile(
    new URL('../anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json', import.meta.url),
    'utf8',
  ))
  // Reproduces the removed Pro->Flash pattern: a Pro-generated artifact copied
  // to a Flash filename without a Flash-native regeneration.
  const tampered = structuredClone(source)
  delete tampered.artifactFingerprint
  tampered.verification = {
    ...(tampered.verification ?? {}),
    copiedBaseline: true,
  }
  tampered.artifactFingerprint = createHash('sha256')
    .update(JSON.stringify(tampered))
    .digest('hex')

  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-anchor-'))
  const path = join(directory, 'copied-baseline.json')
  await writeFile(path, JSON.stringify(tampered), 'utf8')

  await assert.rejects(
    () => loadProfileAnchors(profile({
      name: 'pro',
      models: ['deepseek-v4-pro'],
      anchorPaths: { 'deepseek-v4-pro': path },
      defaultMode: 'anchor',
    })),
    /copied baseline/i,
  )
})

test('startGatewayProfile forwards deleteAnchor so combined listeners do not 501', async () => {
  const received = []
  const logDir = await mkdtemp(join(tmpdir(), 'deepseek-gateway-delete-'))
  const server = await startGatewayProfile({
    name: 'single',
    host: '127.0.0.1',
    port: 0,
    models: ['deepseek-v4-flash'],
    defaultMode: 'bypass',
    anchorPaths: { 'deepseek-v4-flash': '' },
    logDir,
  }, {
    webUiEnabled: true,
    managementEnabled: true,
    deleteAnchor: async (input) => {
      received.push(input)
      return { id: 'user-a', path: 'anchors/user-a.json' }
    },
  })
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}/__gateway/anchors`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-gateway-management-request': '1',
      },
      body: JSON.stringify({ path: 'anchors/user-a.json' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).deleted, {
      id: 'user-a',
      path: 'anchors/user-a.json',
    })
    assert.deepEqual(received, [{ path: 'anchors/user-a.json' }])
  } finally {
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  }
})
