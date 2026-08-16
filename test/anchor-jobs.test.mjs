import assert from 'node:assert/strict'
import test from 'node:test'
import { AnchorJobManager } from '../src/gateway/anchor-jobs.mjs'

function profile(overrides = {}) {
  return {
    name: 'pro',
    enabled: true,
    models: ['deepseek-v4-pro'],
    gatewayApiKey: 'gateway-owned-secret',
    upstreamBaseUrl: 'https://provider.example',
    ...overrides,
  }
}

test('Anchor jobs use the selected profile and activate the generated artifact', async () => {
  const observed = []
  const activated = []
  const manager = new AnchorJobManager({
    getProfile: (name) => name === 'pro' ? profile() : null,
    runBuilder: async (job, selectedProfile) => {
      observed.push({ job, selectedProfile })
    },
    activateAnchor: async (name, path) => activated.push({ name, path }),
  })

  const started = manager.start({
    profile: 'pro',
    runs: 2,
    maxSubturns: 4,
    maxTokens: 1000,
    anchorPrompt: 'Inspect the synthetic workstream with both tools and keep the task open.',
  })
  assert.equal(started.maximumUpstreamCalls, 8)
  await new Promise((resolve) => setImmediate(resolve))
  const completed = manager.get(started.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.activated, true)
  assert.equal(observed[0].selectedProfile.gatewayApiKey, 'gateway-owned-secret')
  assert.equal(started.anchorPromptChars, 72)
  assert.equal(JSON.stringify(started).includes('Inspect the synthetic'), false)
  assert.deepEqual(activated, [{ name: 'pro', path: completed.artifactPath }])
  assert.equal(JSON.stringify(completed).includes('gateway-owned-secret'), false)
})

test('Anchor jobs can prepare disabled profiles but still reject missing credentials', async () => {
  const disabled = new AnchorJobManager({
    getProfile: () => profile({ enabled: false }),
    activateAnchor: async () => {},
    runBuilder: async () => {},
  })
  const job = disabled.start({
    profile: 'pro',
    anchorPrompt: 'Inspect the synthetic workstream with both tools before continuing.',
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disabled.get(job.id).status, 'succeeded')

  const noKey = new AnchorJobManager({
    getProfile: () => profile({ gatewayApiKey: '' }),
    activateAnchor: async () => {},
  })
  assert.throws(() => noKey.start({ profile: 'pro' }), /no configured API key/)
})

test('Anchor jobs require a user-supplied anchoring prompt without exposing it', () => {
  const manager = new AnchorJobManager({
    getProfile: () => profile(),
    activateAnchor: async () => {},
  })
  assert.throws(() => manager.start({ profile: 'pro' }), /anchorPrompt/)
  assert.throws(() => manager.start({ profile: 'pro', anchorPrompt: 'too short' }), /anchorPrompt/)
})
