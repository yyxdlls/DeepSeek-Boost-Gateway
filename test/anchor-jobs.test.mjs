import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AnchorJobManager, trackBuilderOutput } from '../src/gateway/anchor-jobs.mjs'
import {
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
} from '../src/lab/anchor-profile.mjs'
import {
  buildBuilderEnv,
  CANONICAL_DEFAULT_JOB,
  CANONICAL_DEFAULT_PRESET,
} from '../src/lab/anchor-generation-gates.mjs'

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function savedV2Artifact(job) {
  const core = {
    schemaVersion: 2,
    kind: 'deepseek-v4-anchor-artifact',
    id: job.anchorId,
    displayName: job.displayName,
    createdAt: '2026-08-24T00:00:00.000Z',
    source: { model: job.model },
    trajectory: {
      selectedCandidate: job.selectedCandidate,
      messages: [
        { role: 'user', content: 'Begin.' },
        { role: 'assistant', content: 'Done.', reasoning_content: '' },
      ],
    },
    verification: { eligible: true },
  }
  return { ...core, artifactFingerprint: fingerprint(core) }
}

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

function candidate(index, overrides = {}) {
  return {
    candidateIndex: index,
    eligible: true,
    eligibilityBasis: 'protocol-only',
    stopReason: 'open-after-second-tool-result',
    reasoningChars: 400 + index,
    contentChars: 90,
    finalAnswerChars: 0,
    totalToolCalls: 2,
    acceptedToolSequence: ['bash', 'str_replace_editor'],
    letMeTotal: 0,
    checks: { toolsOrdered: true },
    observations: {},
    usage: {
      promptTokens: 1_000 + index,
      completionTokens: 500 + index,
      cacheHitTokens: 800 + index,
      cacheMissTokens: 200 + index,
      totalTokens: 5_000 + index,
    },
    turns: [{
      subturn: 1,
      reasoning: 'We need locate the readme first. Let me confirm the path.',
      content: '',
      toolNames: ['bash'],
      finishReason: 'tool_calls',
      reasoningFirstLine: 'We need locate the readme first. Let me confirm the path.',
      contentFirstLine: '',
    }],
    ...overrides,
  }
}

function manager(overrides = {}) {
  const calls = []
  const activated = []
  const instance = new AnchorJobManager({
    getProfile: (name) => name === 'pro' ? profile() : null,
    activateAnchor: async (name, path) => activated.push({ name, path }),
    anchorDirectory: join(tmpdir(), `anchor-jobs-${randomUUID()}`),
    runBuilder: async (job, selectedProfile, mode) => {
      calls.push({ job, selectedProfile, mode })
      if (mode?.fromResults) {
        await mkdir(dirname(job.artifactPath), { recursive: true })
        await writeFile(job.artifactPath, `${JSON.stringify(savedV2Artifact(job), null, 2)}\n`)
      }
    },
    loadCandidates: async () => ({
      candidates: [candidate(1), candidate(2, { eligible: false, checks: { toolsOrdered: false } })],
      autoSelectedCandidate: 1,
    }),
    ...overrides,
  })
  return { instance, calls, activated }
}

const samplePrompt = 'Inspect the synthetic workstream with both tools and keep the task open.'

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitForStatus(instance, id, statuses, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let job = instance.get(id)
  while (Date.now() < deadline && !statuses.includes(job.status)) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    job = instance.get(id)
  }
  return job
}

test('Anchor jobs stop at candidate selection until the user picks one', async () => {
  const { instance, calls, activated } = manager()
  const started = instance.start({
    profile: 'pro',
    runs: 2,
    maxSubturns: 4,
    maxTokens: 1000,
    anchorPrompt: samplePrompt,
    reasoningEffort: 'high',
    continuationMessage: 'Continue with the current Harness requirement.',
  })
  assert.equal(started.maximumUpstreamCalls, 8)
  await settle()
  const awaiting = instance.get(started.id)
  assert.equal(awaiting.status, 'awaiting-selection')
  assert.equal(awaiting.activated, false)
  assert.equal(awaiting.candidates.length, 2)
  assert.equal(awaiting.autoSelectedCandidate, 1)
  assert.deepEqual(activated, [])
  assert.equal(calls[0].selectedProfile.gatewayApiKey, 'gateway-owned-secret')
  assert.equal(calls[0].mode, undefined)
  assert.equal(started.anchorPromptChars, samplePrompt.length)
  assert.equal(started.reasoningEffort, 'high')
  assert.equal(started.continuationChars, 'Continue with the current Harness requirement.'.length)
  assert.equal(JSON.stringify(started).includes('Inspect the synthetic'), false)
  assert.equal(JSON.stringify(started).includes('Continue with the current'), false)
  assert.equal(JSON.stringify(awaiting).includes('gateway-owned-secret'), false)
})

test('Selecting a candidate freezes it and activates the artifact', async () => {
  const { instance, calls, activated } = manager()
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()

  const completed = await instance.select(started.id, {
    candidate: 2,
    displayName: '测试保存名称',
  })
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.activated, true)
  assert.equal(completed.selectedCandidate, 2)
  assert.equal(completed.displayName, '测试保存名称')
  assert.match(completed.anchorId, /^deepseek-v4-pro-open-workstream-/)
  assert.equal(completed.artifactPath.endsWith(`${completed.anchorId}.json`), true)
  assert.doesNotMatch(completed.artifactPath, /测试保存名称/)
  assert.deepEqual(activated, [{ name: 'pro', path: completed.artifactPath }])
  assert.deepEqual(calls[1].mode, {
    fromResults: completed.resultsPath,
    candidate: 2,
  })
  assert.equal(calls[1].selectedProfile, null)
})

test('Selection and discard are rejected outside the awaiting state', async () => {
  const { instance } = manager()
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  assert.throws(
    () => instance.select(started.id, { candidate: 99, displayName: '无效候选' }),
    /not part of job/,
  )
  assert.throws(
    () => instance.select('00000000-0000-0000-0000-000000000000', { candidate: 1, displayName: '缺失任务' }),
    /not found/,
  )

  await instance.select(started.id, { candidate: 1, displayName: '第一次保存' })
  assert.throws(
    () => instance.select(started.id, { candidate: 2, displayName: '第二次保存' }),
    /not awaiting a candidate selection/,
  )
  assert.throws(() => instance.discard(started.id), /not awaiting a candidate selection/)
})

test('Discarding a job drops the pending candidates', async () => {
  const { instance, activated } = manager()
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  const discarded = instance.discard(started.id)
  assert.equal(discarded.status, 'discarded')
  await settle()
  assert.equal(instance.get(started.id).status, 'discarded')
  assert.deepEqual(activated, [])
  assert.throws(
    () => instance.select(started.id, { candidate: 1, displayName: '已丢弃' }),
    /not awaiting/,
  )
})

test('Anchor jobs can prepare disabled profiles but still reject missing credentials', async () => {
  const disabled = new AnchorJobManager({
    getProfile: () => profile({ enabled: false }),
    activateAnchor: async () => {},
    runBuilder: async () => {},
    loadCandidates: async () => ({ candidates: [candidate(1)], autoSelectedCandidate: 1 }),
  })
  const job = disabled.start({
    profile: 'pro',
    anchorPrompt: 'Inspect the synthetic workstream with both tools before continuing.',
  })
  await settle()
  assert.equal(disabled.get(job.id).status, 'awaiting-selection')

  const noKey = new AnchorJobManager({
    getProfile: () => profile({ gatewayApiKey: '' }),
    activateAnchor: async () => {},
  })
  assert.throws(() => noKey.start({ profile: 'pro' }), /no configured API key/)
})

test('Anchor jobs require a user-supplied anchoring prompt without exposing it', () => {
  const { instance } = manager()
  assert.throws(() => instance.start({ profile: 'pro' }), /anchorPrompt/)
  assert.throws(() => instance.start({ profile: 'pro', anchorPrompt: 'too short' }), /anchorPrompt/)
  assert.throws(
    () => instance.start({ profile: 'pro', anchorPrompt: samplePrompt, reasoningEffort: 'extreme' }),
    /reasoningEffort/,
  )
  const { instance: emptyMgr } = manager()
  const empty = emptyMgr.start({
    profile: 'pro',
    anchorPrompt: samplePrompt,
    continuationMessage: '',
  })
  assert.equal(empty.continuationChars, 0)

  const { instance: defaultMgr } = manager()
  const usedDefault = defaultMgr.start({ profile: 'pro', anchorPrompt: samplePrompt })
  assert.equal(usedDefault.continuationChars, OPEN_WORKSTREAM_CONTINUATION_MESSAGE.length)

  const { instance: longMgr } = manager()
  assert.throws(
    () => longMgr.start({
      profile: 'pro',
      anchorPrompt: samplePrompt,
      continuationMessage: 'x'.repeat(4001),
    }),
    /continuationMessage/,
  )
  assert.throws(
    () => instance.start({ profile: 'pro', anchorPrompt: samplePrompt, maxSubturns: 2 }),
    /maxSubturns/,
  )
})

test('Default candidate loading reads builder summaries from the results file', async () => {  const activated = []
  const instance = new AnchorJobManager({
    getProfile: () => profile(),
    activateAnchor: async (name, path) => activated.push({ name, path }),
    runBuilder: async (job) => {
      await mkdir(dirname(job.resultsPath), { recursive: true })
      await writeFile(job.resultsPath, JSON.stringify({
        schemaVersion: 1,
        model: job.model,
        anchorId: job.anchorId,
        anchor: { task: job.anchorPrompt, openWorkstream: true, maxTokens: job.maxTokens },
        candidates: [
          {
            candidateIndex: 4,
            messages: [],
            assistantTurns: [
              { subturn: 1, reasoning: 'Locate the readme before reading it.', content: '', finishReason: 'tool_calls', toolNames: ['bash'] },
              { subturn: 2, reasoning: '', content: 'Reading now.', finishReason: 'tool_calls', toolNames: ['str_replace_editor'] },
            ],
            toolEvents: [],
            usage: { totalTokens: 4242 },
            finalAnswer: '',
            stopReason: 'open-after-second-tool-result',
            evaluation: {
              eligible: true,
              eligibilityBasis: 'protocol-only',
              checks: { toolsOrdered: true },
              observations: {},
              letMeTotal: 0,
              acceptedToolSequence: ['bash', 'str_replace_editor'],
              totalToolCalls: 2,
            },
          },
        ],
      }))
    },
  })
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  const awaiting = await waitForStatus(instance, started.id, ['awaiting-selection', 'failed'])
  assert.equal(awaiting.status, 'awaiting-selection')
  assert.equal(awaiting.candidates.length, 1)
  const summary = awaiting.candidates[0]
  assert.equal(summary.candidateIndex, 4)
  assert.equal(summary.reasoningChars, 'Locate the readme before reading it.'.length)
  assert.equal(summary.turns[1].contentFirstLine, 'Reading now.')
  assert.equal(summary.cot.label, 'mixed')
  assert.equal(awaiting.autoSelectedCandidate, null)
  assert.deepEqual(activated, [])
})

test('Builder stdout events are tracked as live job progress', () => {
  const job = { progress: [], progressTail: '', outputBuffer: '', live: null }
  const stdout = new EventEmitter()
  trackBuilderOutput(job, { stdout })
  stdout.emit('data', Buffer.from(JSON.stringify({ type: 'subturn', candidate: 1, subturn: 2, firstLine: 'Locate the readme first.', toolNames: ['bash'], usage: { promptTokens: 900 }, totalToolCalls: 2 }) + '\n'))
  stdout.emit('data', Buffer.from(JSON.stringify({ type: 'candidate', candidate: 1, eligible: true })))
  stdout.emit('data', Buffer.from('\n'))
  stdout.emit('data', Buffer.from('not json at all\n'))
  stdout.emit('end')

  assert.equal(job.progress.length, 2)
  assert.equal(job.progress[0].type, 'subturn')
  assert.equal(job.progress[0].toolNames[0], 'bash')
  assert.equal(job.progress[1].type, 'candidate')
  assert.match(job.progressTail, /not json at all/)
  assert.equal(job.outputBuffer, '')
})

test('Builder delta events stream into the live output view', () => {
  const job = { progress: [], progressTail: '', outputBuffer: '', live: null }
  const stdout = new EventEmitter()
  trackBuilderOutput(job, { stdout })
  const line = (event) => Buffer.from(`${JSON.stringify(event)}\n`)
  stdout.emit('data', line({ type: 'delta', candidate: 1, subturn: 1, phase: 'reasoning', text: 'We need insp', reasoningChars: 11 }))
  stdout.emit('data', line({ type: 'delta', candidate: 1, subturn: 1, phase: 'reasoning', text: 'ect the fixture.', reasoningChars: 26 }))
  stdout.emit('data', line({ type: 'delta', candidate: 1, subturn: 1, phase: 'content', text: 'Done.', contentChars: 5 }))
  stdout.emit('data', line({ type: 'subturn', candidate: 1, subturn: 1, firstLine: 'We need inspect the fixture.', toolNames: ['bash'], usage: { promptTokens: 950 }, totalToolCalls: 1 }))
  stdout.emit('end')

  // Delta events update live instead of flooding the structural progress list.
  assert.deepEqual(job.progress.map((event) => event.type), ['subturn'])
  assert.equal(job.live.candidate, 1)
  assert.equal(job.live.subturn, 1)
  assert.equal(job.live.reasoningTail, 'We need inspect the fixture.')
  assert.equal(job.live.contentTail, 'Done.')
  assert.equal(job.live.reasoningChars, 26)
  assert.equal(job.live.usage.promptTokens, 950)
  assert.equal(job.live.totalToolCalls, 1)
  assert.equal(job.live.completed.length, 1)
  assert.equal(job.live.completed[0].subturn, 1)
  assert.equal(job.live.reasoningTail, 'We need inspect the fixture.')
})

test('candidate summaries carry chain-of-thought markers and preview', async () => {
  const instance = new AnchorJobManager({
    getProfile: () => profile(),
    activateAnchor: async () => {},
    runBuilder: async (job) => {
      await mkdir(dirname(job.resultsPath), { recursive: true })
      await writeFile(job.resultsPath, JSON.stringify({
        schemaVersion: 1,
        model: job.model,
        anchorId: job.anchorId,
        anchor: { task: job.anchorPrompt, openWorkstream: true, maxTokens: job.maxTokens },
        candidates: [{
          candidateIndex: 1,
          messages: [],
          assistantTurns: [
            { subturn: 1, reasoning: 'We need inspect the workstream before reading the README.', content: '', finishReason: 'tool_calls', toolNames: ['bash'] },
            { subturn: 2, reasoning: '', content: 'Reading now.', finishReason: 'tool_calls', toolNames: ['str_replace_editor'] },
          ],
          toolEvents: [],
          usage: { promptTokens: 1200, completionTokens: 600, cacheHitTokens: 1000, cacheMissTokens: 200, totalTokens: 1800 },
          finalAnswer: '',
          stopReason: 'open-after-second-tool-result',
          evaluation: {
            eligible: true,
            eligibilityBasis: 'protocol-only',
            checks: { toolsOrdered: true },
            observations: {},
            letMeTotal: 0,
            acceptedToolSequence: ['bash', 'str_replace_editor'],
            totalToolCalls: 2,
          },
        }],
      }))
    },
  })
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  const awaiting = await waitForStatus(instance, started.id, ['awaiting-selection', 'failed'])
  assert.equal(awaiting.status, 'awaiting-selection')
  const summary = awaiting.candidates[0]
  assert.equal(summary.markers.weNeed, 1)
  assert.equal(summary.cot.label, 'minimal')
  assert.equal(summary.openingPreview, 'We need inspect the workstream before reading the README.')
  assert.equal(summary.usage.promptTokens, 1200)
  assert.equal(summary.usage.cacheHitTokens, 1000)
  assert.deepEqual(summary.toolStatus, { bash: true, strReplaceEditor: true })
  assert.equal(awaiting.autoSelectedCandidate, 1)
})

test('getCandidate returns the full stored conversation for preview', async () => {
  const instance = new AnchorJobManager({
    getProfile: () => profile(),
    activateAnchor: async () => {},
    runBuilder: async (job) => {
      await mkdir(dirname(job.resultsPath), { recursive: true })
      await writeFile(job.resultsPath, JSON.stringify({
        schemaVersion: 1,
        model: job.model,
        anchorId: job.anchorId,
        candidates: [{
          candidateIndex: 1,
          messages: [
            { role: 'user', content: 'Begin the anchored workstream.' },
            {
              role: 'assistant',
              content: '',
              reasoning_content: 'We need locate the readme first.',
              tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: 'repo listing' },
          ],
          assistantTurns: [
            { subturn: 1, reasoning: 'We need locate the readme first.', content: '', toolNames: ['bash'] },
          ],
          toolEvents: [],
          usage: { totalTokens: 100 },
          finalAnswer: '',
          stopReason: 'open-after-second-tool-result',
          evaluation: {
            eligible: true,
            eligibilityBasis: 'protocol-only',
            checks: { toolsOrdered: true },
            observations: {},
            letMeTotal: 0,
            acceptedToolSequence: ['bash'],
            totalToolCalls: 1,
          },
        }],
      }))
    },
    loadCandidates: async () => ({ candidates: [candidate(1)], autoSelectedCandidate: 1 }),
  })
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await waitForStatus(instance, started.id, ['awaiting-selection', 'failed'])
  assert.equal(instance.get(started.id).status, 'awaiting-selection')

  const full = await instance.getCandidate(started.id, 1)
  assert.equal(full.candidateIndex, 1)
  assert.equal(full.messages.length, 3)
  assert.equal(full.messages[1].reasoning_content, 'We need locate the readme first.')
  assert.equal(full.messages[2].content, 'repo listing')

  await assert.rejects(instance.getCandidate(started.id, 9), /not part of job/)
  await assert.rejects(
    instance.getCandidate('00000000-0000-0000-0000-000000000000', 1),
    /not found/,
  )
})

test('select rejects invalid display names before reserving', async () => {
  const { instance } = manager()
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  assert.throws(() => instance.select(started.id, { candidate: 1 }), /displayName/)
  assert.throws(() => instance.select(started.id, { candidate: 1, displayName: '   ' }), /displayName/)
  assert.throws(() => instance.select(started.id, { candidate: 1, displayName: 'x'.repeat(81) }), /displayName/)
  assert.throws(
    () => instance.select(started.id, { candidate: 1, displayName: 'bad\u202eName' }),
    /control or bidirectional/,
  )
  assert.equal(instance.get(started.id).status, 'awaiting-selection')
})

test('select can save without activating and retry activate on the existing file', async () => {
  const { instance, calls, activated } = manager()
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  const saved = await instance.select(started.id, {
    candidate: 1,
    displayName: '仅保存不绑定',
    activate: false,
  })
  assert.equal(saved.status, 'saved')
  assert.equal(saved.activated, false)
  assert.deepEqual(activated, [])
  const builderCalls = calls.length

  const activatedJob = await instance.activate(started.id)
  assert.equal(activatedJob.status, 'succeeded')
  assert.equal(activatedJob.activated, true)
  assert.equal(calls.length, builderCalls)
  assert.deepEqual(activated, [{ name: 'pro', path: saved.artifactPath }])
})

test('save success and bind failure stay saved-not-activated without rewriting', async () => {
  const { instance, calls } = manager({
    activateAnchor: async () => {
      throw new Error('bind failed')
    },
  })
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  const saved = await instance.select(started.id, {
    candidate: 1,
    displayName: '绑定失败保留',
  })
  assert.equal(saved.status, 'saved-not-activated')
  assert.equal(saved.activated, false)
  assert.match(saved.error, /bind failed/)
  const builderCalls = calls.length
  const path = saved.artifactPath

  await assert.rejects(instance.activate(started.id), /bind failed/)
  const retry = instance.get(started.id)
  assert.equal(retry.status, 'saved-not-activated')
  assert.equal(retry.artifactPath, path)
  assert.equal(calls.length, builderCalls)
})

test('automatic activate CAS leaves the artifact saved when generation changes', async () => {
  let generation = 1
  const { instance, activated } = manager({
    getConfigGeneration: () => generation,
  })
  const started = instance.start({ profile: 'pro', anchorPrompt: samplePrompt })
  await settle()
  generation = 2
  await assert.rejects(
    instance.select(started.id, { candidate: 1, displayName: 'CAS 冲突名称' }),
    /configuration changed/,
  )
  const job = instance.get(started.id)
  assert.equal(job.status, 'saved-not-activated')
  assert.equal(job.activated, false)
  assert.ok(job.artifactPath)
  assert.deepEqual(activated, [])
})

test('canonical-default preset fixes generation parameters and rejects overrides', async () => {
  const { instance, calls } = manager()
  const started = instance.start({
    profile: 'pro',
    preset: CANONICAL_DEFAULT_PRESET,
  })
  assert.equal(started.preset, CANONICAL_DEFAULT_PRESET)
  assert.equal(started.runs, CANONICAL_DEFAULT_JOB.runs)
  assert.equal(started.maxSubturns, CANONICAL_DEFAULT_JOB.maxSubturns)
  assert.equal(started.maxTokens, CANONICAL_DEFAULT_JOB.maxTokens)
  assert.equal(started.reasoningEffort, CANONICAL_DEFAULT_JOB.reasoningEffort)
  assert.equal(started.continuationChars, OPEN_WORKSTREAM_CONTINUATION_MESSAGE.length)
  assert.equal(started.anchorPromptChars, OPEN_WORKSTREAM_ANCHOR_TASK.length)
  assert.equal(started.maximumUpstreamCalls, 18)
  assert.equal(started.fixtureId, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId)
  assert.equal(started.fixtureFingerprint, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint)
  assert.equal(started.activated, false)
  await settle()
  assert.equal(calls[0].job.anchorPrompt, OPEN_WORKSTREAM_ANCHOR_TASK)

  const { instance: rejector } = manager()
  assert.throws(
    () => rejector.start({
      profile: 'pro',
      preset: CANONICAL_DEFAULT_PRESET,
      anchorPrompt: samplePrompt,
    }),
    /rejects anchorPrompt/,
  )
  assert.throws(
    () => rejector.start({
      profile: 'pro',
      preset: CANONICAL_DEFAULT_PRESET,
      runs: 3,
    }),
    /rejects runs/,
  )
  assert.throws(
    () => rejector.start({
      profile: 'pro',
      preset: CANONICAL_DEFAULT_PRESET,
      continuationMessage: OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
    }),
    /rejects continuationMessage/,
  )
  assert.throws(
    () => rejector.start({ profile: 'pro', preset: 'not-a-preset', anchorPrompt: samplePrompt }),
    /Unknown Anchor job preset/,
  )
})

test('ordinary custom Builder still requires a prompt and is unaffected by the preset path', () => {
  const { instance } = manager()
  assert.throws(() => instance.start({ profile: 'pro' }), /anchorPrompt/)
  const custom = instance.start({
    profile: 'pro',
    anchorPrompt: samplePrompt,
    runs: 2,
    maxSubturns: 4,
  })
  assert.equal(custom.preset, null)
  assert.equal(custom.runs, 2)
  assert.equal(custom.maxSubturns, 4)
  assert.equal(custom.anchorPromptChars, samplePrompt.length)
})

test('builder child env only inherits process essentials and redacts secrets', () => {
  const env = buildBuilderEnv({
    PATH: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    DEEPSEEK_API_KEY: 'parent-secret',
    ANOTHER_TOKEN: 'should-not-pass',
    SECRET_KEY: 'also-hidden',
  }, {
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'job-secret',
    ANCHOR_USER_PROMPT: 'canonical task',
  })
  assert.equal(env.PATH, 'C:\\Windows\\System32')
  assert.equal(env.DEEPSEEK_MODEL, 'deepseek-v4-flash')
  assert.equal(env.DEEPSEEK_API_KEY, 'job-secret')
  assert.equal(env.ANCHOR_USER_PROMPT, 'canonical task')
  assert.equal(env.ANOTHER_TOKEN, undefined)
  assert.equal(env.SECRET_KEY, undefined)
})
