import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gatewayManagementConfig,
  gatewayRuntimeProfiles,
} from '../src/gateway/runtime-config.mjs'

test('keeps the existing single-instance configuration compatible', () => {
  const [profile] = gatewayRuntimeProfiles({
    GATEWAY_PORT: '9000',
    GATEWAY_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
    GATEWAY_PRO_ANCHOR_PATH: 'pro.json',
    GATEWAY_FLASH_ANCHOR_PATH: 'flash.json',
  })
  assert.equal(profile.name, 'single')
  assert.equal(profile.port, 9000)
  assert.deepEqual(profile.models, ['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.equal(profile.gatewayApiKey, 'shared-key')
})

test('builds isolated Pro and Flash listeners, keys, anchors, and logs', () => {
  const profiles = gatewayRuntimeProfiles({
    GATEWAY_INSTANCE_MODE: 'split',
    GATEWAY_PRO_ENABLED: 'true',
    GATEWAY_FLASH_ENABLED: 'true',
    GATEWAY_PRO_PORT: '8642',
    GATEWAY_FLASH_PORT: '8743',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    GATEWAY_FLASH_UPSTREAM_API_KEY: 'flash-key',
    GATEWAY_PRO_ANCHOR_PATH: 'pro.json',
    GATEWAY_FLASH_ANCHOR_PATH: 'flash.json',
    GATEWAY_LOG_DIR: 'diagnostics',
  })
  assert.deepEqual(profiles.map((profile) => profile.name), ['pro', 'flash'])
  assert.deepEqual(profiles.map((profile) => profile.port), [8642, 8743])
  assert.deepEqual(profiles.map((profile) => profile.gatewayApiKey), ['pro-key', 'flash-key'])
  assert.deepEqual(profiles.map((profile) => profile.models), [
    ['deepseek-v4-pro'],
    ['deepseek-v4-flash'],
  ])
  assert.notEqual(profiles[0].logDir, profiles[1].logDir)
})

test('rejects split profiles that would bind the same listener', () => {
  assert.throws(
    () => gatewayRuntimeProfiles({
      GATEWAY_INSTANCE_MODE: 'split',
      GATEWAY_PRO_ENABLED: 'true',
      GATEWAY_FLASH_ENABLED: 'true',
      GATEWAY_PRO_PORT: '8642',
      GATEWAY_FLASH_PORT: '8642',
    }),
    /cannot share listener/,
  )
})

test('uses a dedicated management listener in split mode', () => {
  assert.deepEqual(gatewayManagementConfig({}), {
    host: '127.0.0.1',
    port: 8642,
    managementToken: '',
  })
})

test('enables both split profiles in anchor mode with bundled model-specific baselines', () => {
  const profiles = gatewayRuntimeProfiles({ GATEWAY_INSTANCE_MODE: 'split' })
  assert.deepEqual(profiles.map((profile) => profile.name), ['pro', 'flash'])
  assert.deepEqual(profiles.map((profile) => profile.defaultMode), ['anchor', 'anchor'])
  assert.match(profiles[0].anchorPaths['deepseek-v4-pro'], /two-tool-v2\.json$/)
  assert.match(profiles[1].anchorPaths['deepseek-v4-flash'], /flash-copy\.json$/)
})
