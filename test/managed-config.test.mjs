import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyManagedConfig,
  emptyManagedConfig,
  loadManagedConfig,
  maskApiKey,
  managedDeploymentView,
  managedProfileSecrets,
  managedProfileViews,
  MANAGED_ENV_FIELDS,
  saveManagedConfig,
  updateManagedProfile,
  updateManagedDeployment,
} from '../src/gateway/managed-config.mjs'
import { BUILTIN_MICRO_ANCHOR_ID } from '../src/gateway/micro-anchor.mjs'

const environment = {
  GATEWAY_INSTANCE_MODE: 'split',
  GATEWAY_UPSTREAM_API_KEY: 'shared-key',
  GATEWAY_UPSTREAM_BASE_URL: 'https://shared.example',
  GATEWAY_PRO_ANCHOR_PATH: 'anchors/pro.json',
  GATEWAY_FLASH_ENABLED: 'false',
}

test('managed profiles independently override Pro and Flash without exposing keys', () => {
  let document = emptyManagedConfig()
  document = updateManagedProfile(document, 'pro', {
    port: 9101,
    apiKey: 'pro-secret',
    upstreamBaseUrl: 'https://pro.example',
  })
  document = updateManagedProfile(document, 'flash', {
    enabled: true,
    port: 9102,
    apiKey: 'flash-secret',
    upstreamBaseUrl: 'https://flash.example',
    enhancementMode: 'bypass',
  })

  const effective = applyManagedConfig(environment, document)
  assert.equal(effective.GATEWAY_PRO_PORT, '9101')
  assert.equal(effective.GATEWAY_FLASH_PORT, '9102')
  assert.equal(effective.GATEWAY_PRO_UPSTREAM_API_KEY, 'pro-secret')
  assert.equal(effective.GATEWAY_FLASH_UPSTREAM_API_KEY, 'flash-secret')

  const secrets = managedProfileSecrets(environment, document)
  assert.equal(secrets.find((profile) => profile.name === 'pro').gatewayApiKey, 'pro-secret')
  assert.equal(secrets.find((profile) => profile.name === 'flash').gatewayApiKey, 'flash-secret')

  const views = managedProfileViews(environment, document)
  assert.equal(views.find((profile) => profile.name === 'pro').apiKeyConfigured, true)
  assert.equal(views.find((profile) => profile.name === 'flash').apiKeyConfigured, true)
  assert.equal(views.find((profile) => profile.name === 'pro').apiKeyPreview, 'pro-sec••••cret')
  assert.equal(views.find((profile) => profile.name === 'flash').apiKeyPreview, 'flash-s••••cret')
  assert.equal(JSON.stringify(views).includes('pro-secret'), false)
  assert.equal(JSON.stringify(views).includes('flash-secret'), false)
})

test('API key previews reveal only bounded edges', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-1234••••cdef')
  assert.equal(maskApiKey('secret'), 'se••••et')
  assert.equal(maskApiKey(''), '')
})

test('managed vision profile overrides independently and stays masked in views', () => {
  let document = emptyManagedConfig()
  document = updateManagedProfile(document, 'vision', {
    enabled: true,
    port: 9103,
    apiKey: 'vision-secret',
    upstreamBaseUrl: 'https://vision.example',
    enhancementMode: 'bypass',
  })

  const effective = applyManagedConfig(environment, document)
  assert.equal(effective.GATEWAY_VISION_PORT, '9103')
  assert.equal(effective.GATEWAY_VISION_UPSTREAM_API_KEY, 'vision-secret')
  assert.equal(effective.GATEWAY_VISION_UPSTREAM_BASE_URL, 'https://vision.example')
  assert.equal(effective.GATEWAY_VISION_ENHANCEMENT_MODE, 'bypass')

  const secretView = managedProfileSecrets(environment, document)
    .find((profile) => profile.name === 'vision')
  assert.equal(secretView.gatewayApiKey, 'vision-secret')
  assert.equal(secretView.gatewayApiKeySource, 'profile')

  const views = managedProfileViews(environment, document)
  const view = views.find((profile) => profile.name === 'vision')
  assert.equal(view.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(view.enabled, true)
  assert.equal(view.port, 9103)
  assert.equal(view.apiKeyConfigured, true)
  assert.equal(view.apiKeyPreview, 'vision-••••cret')
  assert.equal(view.enhancementMode, 'bypass')
  assert.equal(view.anchorPath, '')
  assert.equal(JSON.stringify(views).includes('vision-secret'), false)
})

test('profile updates store cwd-absolute Anchor paths as catalog-relative paths', () => {
  const absolute = join(process.cwd(), 'anchors', 'user-generated.json')
  const document = updateManagedProfile(emptyManagedConfig(), 'vision', {
    enhancementMode: 'anchor',
    anchorPath: absolute,
  })
  assert.equal(document.profiles.vision.anchorPath, 'anchors/user-generated.json')

  const view = managedProfileViews({
    ...environment,
    GATEWAY_VISION_ANCHOR_PATH: absolute,
  }, emptyManagedConfig()).find((profile) => profile.name === 'vision')
  assert.equal(view.anchorPath, 'anchors/user-generated.json')
})

test('blank key updates preserve a configured key and explicit clearing removes it', () => {
  const withKey = updateManagedProfile(emptyManagedConfig(), 'pro', { apiKey: 'secret' })
  const preserved = updateManagedProfile(withKey, 'pro', { apiKey: '   ', port: 9201 })
  assert.equal(preserved.profiles.pro.apiKey, 'secret')
  assert.equal(preserved.profiles.pro.port, 9201)

  const cleared = updateManagedProfile(preserved, 'pro', { clearApiKey: true })
  assert.equal(cleared.profiles.pro.apiKey, '')
})

test('managed config persists with schema validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-config-'))
  const path = join(directory, 'gateway.config.json')
  const document = updateManagedProfile(emptyManagedConfig(), 'pro', {
    port: 9301,
    apiKey: 'local-secret',
  })
  await saveManagedConfig(document, path)
  assert.deepEqual(await loadManagedConfig(path), document)
  const text = await readFile(path, 'utf8')
  assert.match(text, /"schemaVersion": 2/)
})

test('empty managed config is schema v2 with baseline micro-anchors', () => {
  const empty = emptyManagedConfig()
  assert.equal(empty.schemaVersion, 2)
  assert.deepEqual(empty.microAnchors, { definitions: {} })
  const migrated = updateManagedProfile(empty, 'pro', { port: 9301 })
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(migrated.profiles.pro.microAnchor, {
    enabled: true,
    selectedId: BUILTIN_MICRO_ANCHOR_ID,
  })
  assert.equal(Object.hasOwn(MANAGED_ENV_FIELDS, 'microAnchor'), false)
})

test('load migrates v1 in memory and the next save writes v2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-gateway-config-v1-'))
  const path = join(directory, 'gateway.config.json')
  const v1 = {
    schemaVersion: 1,
    deployment: { mode: 'split', combinedPort: 8646 },
    profiles: {
      pro: { port: 9401, apiKey: 'legacy-secret', extraLegacy: true },
    },
  }
  await writeFile(path, `${JSON.stringify(v1, null, 2)}\n`, 'utf8')
  const loaded = await loadManagedConfig(path)
  assert.equal(loaded.schemaVersion, 2)
  assert.equal(loaded.profiles.pro.apiKey, 'legacy-secret')
  assert.equal(loaded.profiles.pro.extraLegacy, true)
  assert.equal(loaded.deployment.mode, 'split')
  assert.deepEqual(loaded.profiles.pro.microAnchor, {
    enabled: true,
    selectedId: BUILTIN_MICRO_ANCHOR_ID,
  })
  assert.match(await readFile(path, 'utf8'), /"schemaVersion": 1/)
  await saveManagedConfig(loaded, path)
  assert.match(await readFile(path, 'utf8'), /"schemaVersion": 2/)
  const effective = applyManagedConfig(environment, loaded)
  assert.equal(Object.keys(effective).some((key) => /MICRO_ANCHOR/i.test(key)), false)
})

test('illegal selectedId fails closed and does not fall back to builtin', () => {
  const document = updateManagedProfile(emptyManagedConfig(), 'pro', { port: 9501 })
  assert.throws(
    () => updateManagedProfile(document, 'pro', {
      microAnchor: { selectedId: 'ma_00000000-0000-0000-0000-000000000000' },
    }),
    /Unknown micro-anchor/,
  )
})

test('managed deployment persists split/single/all choices for restart', () => {
  let document = updateManagedDeployment(emptyManagedConfig(), {
    mode: 'all',
    combinedPort: 9864,
  }, environment)
  assert.deepEqual(managedDeploymentView(environment, document), {
    mode: 'all',
    combinedPort: 9864,
    restartRequired: false,
  })
  let effective = applyManagedConfig(environment, document)
  assert.equal(effective.GATEWAY_INSTANCE_MODE, 'all')
  assert.equal(effective.GATEWAY_COMBINED_PORT, '9864')

  document = updateManagedProfile(document, 'pro', { port: 9101 })
  assert.equal(document.deployment.mode, 'all')

  document = updateManagedDeployment(document, { mode: 'single' }, environment)
  effective = applyManagedConfig(environment, document)
  assert.equal(effective.GATEWAY_INSTANCE_MODE, 'single')
  assert.equal(Object.hasOwn(effective, 'GATEWAY_ENHANCEMENT_MODE'), false)
  assert.equal(effective.GATEWAY_MODELS, 'deepseek-v4-pro,deepseek-v4-flash,deepseek-v4-flash-vision-exp')
  assert.throws(
    () => updateManagedDeployment(document, { mode: 'invalid' }, environment),
    /split, single, or all/,
  )
})

test('single mode keeps each model enhancement mode and does not force bypass', () => {
  let document = updateManagedDeployment(emptyManagedConfig(), { mode: 'single' }, environment)
  document = updateManagedProfile(document, 'pro', { enhancementMode: 'anchor' })
  document = updateManagedProfile(document, 'flash', { enhancementMode: 'bypass' })
  document = updateManagedProfile(document, 'vision', { enhancementMode: 'bypass' })
  const effective = applyManagedConfig({ GATEWAY_ENHANCEMENT_MODE: 'anchor' }, document)
  assert.equal(effective.GATEWAY_INSTANCE_MODE, 'single')
  assert.equal(effective.GATEWAY_ENHANCEMENT_MODE, 'anchor')
  assert.equal(effective.GATEWAY_PRO_ENHANCEMENT_MODE, 'anchor')
  assert.equal(effective.GATEWAY_FLASH_ENHANCEMENT_MODE, 'bypass')
  assert.equal(effective.GATEWAY_VISION_ENHANCEMENT_MODE, 'bypass')
  const views = managedProfileViews({}, document)
  assert.equal(views.find((profile) => profile.name === 'pro').enhancementMode, 'anchor')
  assert.equal(views.find((profile) => profile.name === 'flash').enhancementMode, 'bypass')
})
