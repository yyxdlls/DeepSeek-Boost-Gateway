import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyManagedConfig,
  emptyManagedConfig,
  loadManagedConfig,
  maskApiKey,
  managedProfileSecrets,
  managedProfileViews,
  saveManagedConfig,
  updateManagedProfile,
} from '../src/gateway/managed-config.mjs'

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
  assert.match(text, /"schemaVersion": 1/)
})
