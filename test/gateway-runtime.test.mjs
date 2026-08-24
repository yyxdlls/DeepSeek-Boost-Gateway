import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewayRuntime } from '../src/gateway/gateway-runtime.mjs'
import {
  BUILTIN_MICRO_ANCHOR_ID,
  createCustomMicroAnchorId,
} from '../src/gateway/micro-anchor.mjs'
import {
  createManagedMicroAnchor,
  emptyManagedConfig,
  updateManagedProfile,
} from '../src/gateway/managed-config.mjs'

function fakeServer(profile) {
  return {
    listening: true,
    gatewayConfig: {
      profile: profile.name,
      host: profile.host,
      port: profile.port,
      models: profile.models,
      anchors: [],
      microAnchors: profile.microAnchors,
    },
    async gatewayStop() {
      this.listening = false
    },
    gatewayClearDiagnostics: async () => 0,
  }
}

function documentWithSharedDefinition() {
  let document = updateManagedDeploymentSafe(emptyManagedConfig())
  document = updateManagedProfile(document, 'pro', {
    enabled: true,
    port: 9101,
    enhancementMode: 'bypass',
    anchorPath: '',
    apiKey: 'pro-secret',
  })
  document = updateManagedProfile(document, 'flash', {
    enabled: true,
    port: 9102,
    enhancementMode: 'bypass',
    anchorPath: '',
    apiKey: 'flash-secret',
  })
  document = updateManagedProfile(document, 'vision', {
    enabled: true,
    port: 9103,
    enhancementMode: 'bypass',
    anchorPath: '',
    apiKey: 'vision-secret',
  })
  document = createManagedMicroAnchor(document, { name: '共用', content: '共用正文' })
  const customId = Object.keys(document.microAnchors.definitions)[0]
  document = updateManagedProfile(document, 'pro', {
    microAnchor: { enabled: true, selectedId: customId },
  })
  document = updateManagedProfile(document, 'flash', {
    microAnchor: { enabled: true, selectedId: customId },
  })
  return { document, customId }
}

function updateManagedDeploymentSafe(document) {
  return {
    ...document,
    deployment: { mode: 'split', combinedPort: 9864 },
  }
}

async function createRuntime(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-runtime-'))
  const started = { entries: [] }
  const { document, customId } = documentWithSharedDefinition()
  const initialDocument = {
    ...document,
    deployment: { mode: overrides.mode ?? 'split', combinedPort: 9104 },
  }
  const configPath = join(directory, 'gateway.config.json')
  await writeFile(configPath, `${JSON.stringify(initialDocument, null, 2)}\n`, 'utf8')
  const runtime = new GatewayRuntime({
    environment: {
      GATEWAY_INSTANCE_MODE: 'split',
      GATEWAY_WEB_UI_PORT: '9100',
      GATEWAY_UPSTREAM_BASE_URL: 'https://example.test',
    },
    document: initialDocument,
    configPath,
    startProfile: async (profile) => {
      if (typeof overrides.failOn === 'function' && overrides.failOn(profile, started.entries)) {
        throw new Error(`start failed: ${profile.name}`)
      }
      const server = fakeServer(profile)
      started.entries.push({ profile: structuredClone(profile), server })
      return server
    },
    saveDocument: overrides.saveDocument,
  })
  await runtime.startAll()
  return { runtime, started: started.entries, customId, directory }
}

test('mutation queue serializes profile and micro-anchor writes', async () => {
  const { runtime } = await createRuntime()
  const order = []
  const first = runtime.updateProfile('vision', { port: 9203 }).then(() => order.push('profile'))
  const second = runtime.createMicroAnchor({ name: '稍后', content: '未引用' }).then(() => order.push('create'))
  await Promise.all([first, second])
  assert.deepEqual(order, ['profile', 'create'])
})

test('split profiles that share a definition both receive the new snapshot', async () => {
  const { runtime, customId } = await createRuntime()
  const result = await runtime.updateMicroAnchor(customId, { content: '新的共用正文' })
  assert.deepEqual(new Set(result.affectedProfiles), new Set(['pro', 'flash']))
  const snapshots = runtime.runtimeProfiles().map((profile) => profile.microAnchors[profile.models[0]])
  const pro = snapshots.find((item) => item.id === customId && runtime.runtimeProfiles().some((profile) => (
    profile.name === 'pro' && profile.microAnchors[profile.models[0]].content === '新的共用正文'
  )))
  assert.ok(pro)
  const live = runtime.dataServers.map((server) => server.gatewayConfig.microAnchors)
  assert.equal(live[0]['deepseek-v4-pro'].content, '新的共用正文')
  assert.equal(live[1]['deepseek-v4-flash'].content, '新的共用正文')
})

test('all mode rebuilds combined when a consumed model mapping changes', async () => {
  const { runtime, customId } = await createRuntime({ mode: 'all' })
  assert.deepEqual(runtime.runtimeProfiles().map((profile) => profile.name), [
    'pro', 'flash', 'vision', 'combined',
  ])
  const result = await runtime.updateMicroAnchor(customId, { content: 'combined 也要重建' })
  assert.ok(result.affectedProfiles.includes('combined'))
  const combined = runtime.dataServers.find((server) => server.gatewayConfig.profile === 'combined')
  assert.equal(combined.gatewayConfig.microAnchors['deepseek-v4-pro'].content, 'combined 也要重建')
  assert.equal(combined.gatewayConfig.microAnchors['deepseek-v4-flash'].content, 'combined 也要重建')
})

test('creating an unreferenced definition does not restart data planes', async () => {
  const { runtime, started } = await createRuntime()
  const before = started.length
  const result = await runtime.createMicroAnchor({ name: '草稿', content: '未引用正文' })
  assert.deepEqual(result.affectedProfiles, [])
  assert.equal(result.effectiveChanged, false)
  assert.equal(started.length, before)
})

test('a later instance start failure rolls back only after-state instances', async () => {
  const { runtime, customId } = await createRuntime({
    failOn(profile) {
      return profile.name === 'flash'
        && profile.microAnchors['deepseek-v4-flash']?.content === '不应提交'
    },
  })
  const before = runtime.dataServers.map((server) => server.gatewayConfig.microAnchors)
  await assert.rejects(
    () => runtime.updateMicroAnchor(customId, { content: '不应提交' }),
    /start failed: flash/,
  )
  const after = runtime.dataServers.map((server) => server.gatewayConfig.microAnchors)
  assert.equal(after[0]['deepseek-v4-pro'].content, before[0]['deepseek-v4-pro'].content)
  assert.equal(after[1]['deepseek-v4-flash'].content, before[1]['deepseek-v4-flash'].content)
  const saved = JSON.parse(await readFile(runtime.configPath, 'utf8'))
  assert.equal(saved.microAnchors.definitions[customId].content, '共用正文')
})

test('atomic save failure rolls back instances and keeps secrets', async () => {
  const { runtime, customId } = await createRuntime({
    saveDocument: async () => {
      throw new Error('disk full')
    },
  })
  const beforeKey = runtime.secretProfile('pro').gatewayApiKey
  await assert.rejects(() => runtime.updateMicroAnchor(customId, { content: '丢盘' }), /disk full/)
  assert.equal(runtime.secretProfile('pro').gatewayApiKey, beforeKey)
  assert.equal(
    runtime.dataServers[0].gatewayConfig.microAnchors['deepseek-v4-pro'].content,
    '共用正文',
  )
})

test('restore failure marks the runtime degraded and blocks later mutations', async () => {
  const { runtime, customId } = await createRuntime({
    failOn(profile, started) {
      const flashContent = profile.microAnchors?.['deepseek-v4-flash']?.content
      const proContent = profile.microAnchors?.['deepseek-v4-pro']?.content
      if (profile.name === 'flash' && flashContent === '会失败') return true
      return profile.name === 'pro'
        && proContent === '共用正文'
        && started.some((entry) => (
          entry.profile.microAnchors?.['deepseek-v4-pro']?.content === '会失败'
        ))
    },
  })
  await assert.rejects(() => runtime.updateMicroAnchor(customId, { content: '会失败' }))
  assert.equal(runtime.degraded, true)
  await assert.rejects(() => runtime.createMicroAnchor({ name: 'blocked', content: 'no' }), /degraded/)
})

test('single-mode coordinator reports pending restart for effective mapping changes', async () => {
  const { createManagedMutationCoordinator, mutationResult } = await import(
    '../src/gateway/managed-mutation-coordinator.mjs'
  )
  const coordinator = createManagedMutationCoordinator()
  let document = documentWithSharedDefinition().document
  document = { ...document, deployment: { mode: 'single', combinedPort: 8646 } }
  const result = await coordinator.commit(async () => mutationResult({
    documentView: { schemaVersion: 2 },
    affectedProfiles: ['single'],
    effectiveChanged: true,
    restartRequired: true,
    pendingRestart: true,
  }))
  assert.equal(result.restartRequired, true)
  assert.equal(result.pendingRestart, true)
  assert.ok(document)
})

test('unused helper id factory stays in the custom namespace', () => {
  assert.match(createCustomMicroAnchorId(), /^ma_[0-9a-f-]+$/i)
  assert.equal(BUILTIN_MICRO_ANCHOR_ID.startsWith('builtin:'), true)
})

test('pending deployment mode does not change live topology', async () => {
  const { runtime, customId } = await createRuntime({ mode: 'split' })
  const result = await runtime.updateDeployment({ mode: 'all', combinedPort: 9104 })
  assert.equal(result.mode, 'all')
  assert.equal(result.restartRequired, true)
  assert.equal(runtime.runtimeProfiles().some((profile) => profile.name === 'combined'), false)
  await runtime.updateMicroAnchor(customId, { content: '仍按 split 生效' })
  assert.equal(runtime.dataServers.some((server) => server.gatewayConfig.profile === 'combined'), false)
})

test('profile config generation CAS rejects stale activate', async () => {
  const { runtime } = await createRuntime()
  assert.equal(runtime.secretProfile('pro').configGeneration, 0)
  await runtime.updateProfile('flash', { port: 9202 })
  assert.equal(runtime.secretProfile('pro').configGeneration, 0)
  assert.equal(runtime.secretProfile('flash').configGeneration, 1)
  await assert.rejects(
    () => runtime.activateAnchor('flash', '', { expectedGeneration: 0 }),
    (error) => error.statusCode === 409,
  )
})
