import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_UPSTREAM_BASE_URL,
  gatewayCombinedProfile,
  gatewayManagementConfig,
  gatewayModelPlanes,
  gatewayRuntimeProfiles,
  resolveAnchorPath,
  validateGatewayDeployment,
  warnIfUnusableGlobalUpstreamKey,
} from '../src/gateway/runtime-config.mjs'

test('keeps the existing single-instance configuration compatible', () => {
  const [profile] = gatewayRuntimeProfiles({
    GATEWAY_PORT: '9000',
    GATEWAY_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    GATEWAY_PRO_ANCHOR_PATH: 'pro.json',
    GATEWAY_FLASH_ANCHOR_PATH: 'flash.json',
  })
  assert.equal(profile.name, 'single')
  assert.equal(profile.port, 9000)
  assert.deepEqual(profile.models, ['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.equal(profile.gatewayApiKey, undefined)
  const planes = Object.fromEntries(profile.planes.map((plane) => [plane.name, plane]))
  assert.equal(planes.pro.gatewayApiKey, 'pro-key')
  assert.equal(planes.flash.gatewayApiKey, '')
  assert.equal(planes.flash.gatewayApiKeySource, 'none')
})

test('builds isolated Pro and Flash listeners, keys, anchors, and logs', () => {
  const profiles = gatewayRuntimeProfiles({
    GATEWAY_INSTANCE_MODE: 'split',
    GATEWAY_PRO_ENABLED: 'true',
    GATEWAY_FLASH_ENABLED: 'true',
    GATEWAY_VISION_ENABLED: 'false',
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
      GATEWAY_VISION_ENABLED: 'false',
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

test('defaults split mode to Pro, Flash, and Vision profiles with built-in modes', () => {
  const profiles = gatewayRuntimeProfiles({ GATEWAY_INSTANCE_MODE: 'split' })
  assert.deepEqual(profiles.map((profile) => profile.name), ['pro', 'flash', 'vision'])
  assert.deepEqual(profiles.map((profile) => profile.models[0]), [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
  ])
  assert.deepEqual(profiles.map((profile) => profile.port), [8643, 8644, 8645])
  // Pro ships a trusted bundled Anchor; Flash and Vision do not, so they start
  // transparent until a model-native Anchor is generated and bound.
  assert.deepEqual(profiles.map((profile) => profile.defaultMode), ['anchor', 'bypass', 'bypass'])
  assert.match(profiles[0].anchorPaths['deepseek-v4-pro'], /deepseek-v4-pro-open-workstream-20260824101411-f2a74161\.json$/)
  assert.equal(profiles[1].anchorPaths['deepseek-v4-flash'], '')
  assert.equal(profiles[2].anchorPaths['deepseek-v4-flash-vision-exp'], '')
  assert.equal(profiles[0].enabled, true)
  assert.equal(profiles[1].enabled, true)
  assert.equal(profiles[2].enabled, true)
})

test('keep Vision credentials, upstream, and logs separate from Pro and Flash', () => {
  const profiles = gatewayRuntimeProfiles({
    GATEWAY_INSTANCE_MODE: 'split',
    GATEWAY_LOG_DIR: 'diagnostics',
    GATEWAY_PRO_UPSTREAM_BASE_URL: 'https://pro.example',
    GATEWAY_FLASH_UPSTREAM_BASE_URL: 'https://flash.example',
    GATEWAY_VISION_UPSTREAM_BASE_URL: 'https://vision.example',
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    GATEWAY_VISION_UPSTREAM_API_KEY: 'vision-key',
  })
  const vision = profiles.find((profile) => profile.name === 'vision')
  assert.equal(vision.port, 8645)
  assert.equal(vision.gatewayApiKey, 'vision-key')
  assert.equal(vision.gatewayApiKeySource, 'profile')
  assert.equal(vision.upstreamBaseUrl, 'https://vision.example')
  assert.equal(profiles.find((profile) => profile.name === 'flash').gatewayApiKeySource, 'none')
  assert.equal(new Set(profiles.map((profile) => profile.logDir)).size, 3)
})

test('single mode is one listener with three independent model planes', () => {
  const [profile] = gatewayRuntimeProfiles({ GATEWAY_INSTANCE_MODE: 'single' })
  assert.equal(profile.name, 'single')
  assert.equal(profile.port, 8642)
  assert.equal(profile.defaultMode, undefined)
  assert.equal(profile.gatewayApiKey, undefined)
  assert.deepEqual(profile.models, [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
  ])
  assert.deepEqual(profile.planes.map((plane) => [plane.name, plane.defaultMode]), [
    ['pro', 'anchor'],
    ['flash', 'bypass'],
    ['vision', 'bypass'],
  ])
})

test('all mode keeps split profiles and adds a separate combined profile', () => {
  const env = {
    GATEWAY_INSTANCE_MODE: 'all',
    GATEWAY_WEB_UI_PORT: '8642',
    GATEWAY_PRO_PORT: '8643',
    GATEWAY_FLASH_PORT: '8644',
    GATEWAY_VISION_PORT: '8645',
    GATEWAY_COMBINED_PORT: '8646',
  }
  assert.deepEqual(gatewayRuntimeProfiles(env).map((profile) => profile.name), [
    'pro', 'flash', 'vision',
  ])
  const combined = gatewayCombinedProfile(env)
  assert.equal(combined.name, 'combined')
  assert.equal(combined.port, 8646)
  assert.equal(combined.defaultMode, undefined)
  assert.equal(combined.gatewayApiKey, undefined)
  assert.equal(combined.models.length, 3)
  assert.equal(combined.planes.length, 3)
  assert.equal(validateGatewayDeployment(env).listeners.length, 5)
})

test('resolveAnchorPath distinguishes missing keys from an explicit empty string', () => {
  assert.equal(
    resolveAnchorPath({}, ['GATEWAY_PRO_ANCHOR_PATH'], 'anchors/default.json'),
    'anchors/default.json',
  )
  assert.equal(
    resolveAnchorPath({ GATEWAY_PRO_ANCHOR_PATH: '' }, ['GATEWAY_PRO_ANCHOR_PATH'], 'anchors/default.json'),
    '',
  )
  assert.equal(
    resolveAnchorPath(
      { GATEWAY_ANCHOR_PATH: 'shared.json' },
      ['GATEWAY_PRO_ANCHOR_PATH', 'GATEWAY_ANCHOR_PATH'],
      'anchors/default.json',
    ),
    'shared.json',
  )
  assert.equal(
    resolveAnchorPath(
      { GATEWAY_PRO_ANCHOR_PATH: '', GATEWAY_ANCHOR_PATH: 'shared.json' },
      ['GATEWAY_PRO_ANCHOR_PATH', 'GATEWAY_ANCHOR_PATH'],
      'anchors/default.json',
    ),
    '',
  )
})

test('explicit empty Anchor paths stay empty in split, single, and combined profiles', () => {
  const env = {
    GATEWAY_INSTANCE_MODE: 'all',
    GATEWAY_PRO_ANCHOR_PATH: '',
    GATEWAY_FLASH_ANCHOR_PATH: '',
    GATEWAY_VISION_ANCHOR_PATH: '',
    GATEWAY_PRO_ENHANCEMENT_MODE: 'bypass',
  }
  const split = gatewayRuntimeProfiles(env)
  assert.equal(split[0].anchorPaths['deepseek-v4-pro'], '')
  assert.equal(split[1].anchorPaths['deepseek-v4-flash'], '')
  assert.equal(split[2].anchorPaths['deepseek-v4-flash-vision-exp'], '')
  const [single] = gatewayRuntimeProfiles({
    GATEWAY_INSTANCE_MODE: 'single',
    GATEWAY_PRO_ANCHOR_PATH: '',
    GATEWAY_FLASH_ANCHOR_PATH: '',
    GATEWAY_VISION_ANCHOR_PATH: '',
  })
  assert.equal(single.anchorPaths['deepseek-v4-pro'], '')
  assert.equal(single.anchorPaths['deepseek-v4-flash'], '')
  const combined = gatewayCombinedProfile(env)
  assert.equal(combined.anchorPaths['deepseek-v4-pro'], '')
  assert.equal(combined.anchorPaths['deepseek-v4-flash'], '')
})

test('planes do not inherit a global upstream key and default an empty upstream URL', () => {
  const planes = Object.fromEntries(gatewayModelPlanes({
    GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-only',
    GATEWAY_UPSTREAM_API_KEY: 'shared-key',
    GATEWAY_UPSTREAM_BASE_URL: 'https://shared.example',
  }).map((plane) => [plane.name, plane]))
  assert.equal(planes.pro.gatewayApiKey, 'pro-only')
  assert.equal(planes.pro.gatewayApiKeySource, 'profile')
  assert.equal(planes.flash.gatewayApiKey, '')
  assert.equal(planes.flash.gatewayApiKeySource, 'none')
  assert.equal(planes.vision.gatewayApiKey, '')
  assert.equal(planes.vision.gatewayApiKeySource, 'none')
  assert.equal(planes.flash.upstreamBaseUrl, DEFAULT_UPSTREAM_BASE_URL)
  assert.equal(planes.vision.upstreamBaseUrl, DEFAULT_UPSTREAM_BASE_URL)
})

test('warns when a multi-model listener has only a global upstream key', () => {
  const lines = []
  assert.equal(
    warnIfUnusableGlobalUpstreamKey({
      GATEWAY_INSTANCE_MODE: 'single',
      GATEWAY_UPSTREAM_API_KEY: 'shared-key',
    }, (line) => lines.push(line)),
    true,
  )
  assert.match(lines[0], /will not share this key/)
  assert.equal(
    warnIfUnusableGlobalUpstreamKey({
      GATEWAY_INSTANCE_MODE: 'single',
      GATEWAY_UPSTREAM_API_KEY: 'shared-key',
      GATEWAY_PRO_UPSTREAM_API_KEY: 'pro-key',
    }, () => {
      throw new Error('should not warn when a model has its own key')
    }),
    false,
  )
})

test('all mode rejects collisions with its combined or management listener', () => {
  assert.throws(
    () => validateGatewayDeployment({
      GATEWAY_INSTANCE_MODE: 'all',
      GATEWAY_WEB_UI_PORT: '8642',
      GATEWAY_PRO_PORT: '8643',
      GATEWAY_FLASH_PORT: '8644',
      GATEWAY_VISION_PORT: '8645',
      GATEWAY_COMBINED_PORT: '8643',
    }),
    /cannot share listener/,
  )
})
