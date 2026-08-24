import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ARM_NAMES, toolsForArm } from '../src/lab/profile.mjs'
import {
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  evaluateOpenWorkstreamCandidate,
} from '../src/lab/anchor-profile.mjs'
import { attachCandidateSetFingerprint } from '../src/lab/anchor-generation-gates.mjs'
import { freezeFromResults } from '../src/lab/run-anchor-candidate.mjs'

const run = promisify(execFile)

const BUILDER = fileURLToPath(new URL('../src/lab/run-anchor-candidate.mjs', import.meta.url))

function storedCandidate(index, overrides = {}) {
  const bashId = `c-bash-${index}`
  const editorId = `c-ed-${index}`
  const candidate = {
    candidateIndex: index,
    requestedModel: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'You are a helpful software engineer assistant.' },
      { role: 'user', content: 'Begin the anchored workstream.' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Inspect structure.',
        tool_calls: [{
          id: bashId,
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls /repo"}' },
        }],
      },
      { role: 'tool', tool_call_id: bashId, content: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.bashResult },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Read the document.',
        tool_calls: [{
          id: editorId,
          type: 'function',
          function: {
            name: 'str_replace_editor',
             arguments: '{"command":"view","path":"/tmp/qxk_scratch/zzq_9f3k.tmp"}',
          },
        }],
      },
      { role: 'tool', tool_call_id: editorId, content: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.readmeResult },
      { role: 'assistant', content: 'Synthetic workstream inspected.', reasoning_content: 'We need conclude.' },
    ],
    assistantTurns: [
      {
        subturn: 1,
        reasoning: 'Inspect structure.',
        content: '',
        finishReason: 'tool_calls',
        toolNames: ['bash'],
        reportedModel: 'deepseek-v4-pro',
        systemFingerprint: 'fp-test',
      },
      {
        subturn: 2,
        reasoning: 'Read the document.',
        content: '',
        finishReason: 'tool_calls',
        toolNames: ['str_replace_editor'],
        reportedModel: 'deepseek-v4-pro',
        systemFingerprint: 'fp-test',
      },
      {
        subturn: 3,
        reasoning: 'We need conclude.',
        content: 'Synthetic workstream inspected.',
        finishReason: 'stop',
        toolNames: [],
        reportedModel: 'deepseek-v4-pro',
        systemFingerprint: 'fp-test',
      },
    ],
    toolEvents: [
      { name: 'bash', accepted: true, unsafeAttempt: false, subturn: 1, args: { command: 'ls /repo' } },
      {
        name: 'str_replace_editor',
        accepted: true,
        unsafeAttempt: false,
        subturn: 2,
        args: { command: 'view', path: '/tmp/qxk_scratch/zzq_9f3k.tmp' },
      },
    ],
    reportedModels: [
      { subturn: 1, model: 'deepseek-v4-pro', systemFingerprint: 'fp-test' },
      { subturn: 2, model: 'deepseek-v4-pro', systemFingerprint: 'fp-test' },
      { subturn: 3, model: 'deepseek-v4-pro', systemFingerprint: 'fp-test' },
    ],
    requestFingerprints: [`req-${index}-1`, `req-${index}-2`, `req-${index}-3`],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finalAnswer: 'Synthetic workstream inspected.',
    stopReason: 'final-answer',
    model: 'deepseek-v4-pro',
    systemFingerprint: 'fp-test',
    ...overrides,
  }
  candidate.evaluation = overrides.evaluation ?? evaluateOpenWorkstreamCandidate(candidate)
  return candidate
}

function storedResults(overrides = {}) {
  const stored = {
    schemaVersion: 1,
    experiment: 'test',
    createdAt: '2026-08-19T00:00:00.000Z',
    endpoint: 'https://provider.example/chat/completions',
    requestedModel: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
    fixtureId: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId,
    fixtureFingerprint: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint,
    anchorId: 'fixture-anchor',
    anchor: {
      task: 'Inspect the synthetic repository with both tools and keep the task open.',
      openWorkstream: true,
      maxTokens: 4096,
      reasoningEffort: 'high',
      continuationMessage: 'Continue with the current Harness task.',
      fixtureId: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId,
      fixtureFingerprint: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint,
      tools: toolsForArm(ARM_NAMES.dshMinimal),
    },
    selectedCandidate: 1,
    candidates: [storedCandidate(1), storedCandidate(2)],
    ...overrides,
  }
  if (!stored.candidates) stored.candidates = [storedCandidate(1), storedCandidate(2)]
  return attachCandidateSetFingerprint(stored)
}

async function workspace(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-freeze-'))
  const resultsPath = join(directory, 'results.json')
  await writeFile(resultsPath, JSON.stringify(storedResults(overrides)))
  return { directory, resultsPath }
}

async function freeze(resultsPath, candidate, outputPath, extraEnv = {}) {
  return run(process.execPath, [
    BUILDER,
    '--from-results', resultsPath,
    '--candidate', String(candidate),
  ], {
    cwd: process.cwd(),
    windowsHide: true,
        env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      DEEPSEEK_MODEL: extraEnv.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
      ANCHOR_OUTPUT_PATH: outputPath,
      ANCHOR_DISPLAY_NAME: extraEnv.ANCHOR_DISPLAY_NAME ?? 'Freeze Test Anchor',
      ...extraEnv,
    },
  })
}

test('freezing from stored results writes the chosen candidate without paid requests', async () => {
  const { directory, resultsPath } = await workspace()
  const outputPath = join(directory, 'anchors', 'frozen.json')
  const { stdout } = await freeze(resultsPath, 2, outputPath)

  const report = JSON.parse(stdout.slice(stdout.indexOf('{')))
  assert.equal(report.selectedCandidate, 2)
  assert.equal(report.frozenArtifact, outputPath)
  assert.match(report.artifactFingerprint, /^[0-9a-f]{64}$/)

  const artifact = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(artifact.kind, 'deepseek-v4-anchor-artifact')
  assert.equal(artifact.schemaVersion, 2)
  assert.equal(artifact.displayName, 'Freeze Test Anchor')
  assert.equal(artifact.trajectory.selectedCandidate, 2)
  assert.equal(artifact.continuation.mode, 'same-active-workstream')
  assert.equal(artifact.continuation.message, 'Continue with the current Harness task.')
  assert.equal(artifact.bootstrap.task, 'Inspect the synthetic repository with both tools and keep the task open.')
  assert.equal(artifact.source.requestSettings.maxTokens, 4096)
  assert.equal(artifact.source.requestSettings.reasoningEffort, 'high')
})

test('freezing refuses unknown candidates and existing immutable files', async () => {
  const { directory, resultsPath } = await workspace()
  await assert.rejects(
    freeze(resultsPath, 7, join(directory, 'never.json')),
    /Candidate 7 was not found/,
  )

  const outputPath = join(directory, 'existing.json')
  await writeFile(outputPath, '{}')
  await assert.rejects(
    freeze(resultsPath, 1, outputPath),
    /Refusing to overwrite immutable anchor/,
  )
})

test('freezing saves the explicitly chosen candidate without pass/fail warnings', async () => {
  const { directory, resultsPath } = await workspace()
  const ineligiblePath = join(directory, 'ineligible.json')
  const stored = JSON.parse(await readFile(resultsPath, 'utf8'))
  stored.candidates[1].evaluation.eligible = false
  await writeFile(resultsPath, JSON.stringify(attachCandidateSetFingerprint(stored)))
  const { stderr } = await freeze(resultsPath, 2, ineligiblePath)
  assert.equal(stderr, '')
  const artifact = JSON.parse(await readFile(ineligiblePath, 'utf8'))
  assert.equal(artifact.verification.eligible, false)
})

test('from-results writes the select-stage artifact id and sends zero fetch calls', async () => {
  const { directory, resultsPath } = await workspace()
  const outputPath = join(directory, 'anchors', 'named.json')
  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('from-results must not call fetch')
  }
  try {
    process.env.ANCHOR_DISPLAY_NAME = 'Freeze Test Anchor'
    process.env.ANCHOR_ARTIFACT_ID = 'deepseek-v4-flash-open-workstream-selectid'
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro'
    await freezeFromResults(resultsPath, '1', outputPath)
  } finally {
    globalThis.fetch = previousFetch
    delete process.env.ANCHOR_DISPLAY_NAME
    delete process.env.ANCHOR_ARTIFACT_ID
    delete process.env.DEEPSEEK_MODEL
  }
  assert.equal(fetchCalls, 0)
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(artifact.id, 'deepseek-v4-flash-open-workstream-selectid')
})

test('from-results rejects tampered candidate-set fingerprint before writing', async () => {
  const { directory, resultsPath } = await workspace()
  const stored = JSON.parse(await readFile(resultsPath, 'utf8'))
  stored.candidateSetFingerprint = '0'.repeat(64)
  await writeFile(resultsPath, JSON.stringify(stored))
  await assert.rejects(
    freeze(resultsPath, 1, join(directory, 'tampered.json')),
    /Candidate-set fingerprint mismatch/,
  )
})

test('from-results rejects a model mismatch before writing', async () => {
  const { directory, resultsPath } = await workspace()
  await assert.rejects(
    freeze(resultsPath, 1, join(directory, 'wrong-model.json'), {
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
    }),
    /does not match target deepseek-v4-flash/,
  )
})

test('from-results rejects a missing final assistant before writing', async () => {
  const { directory, resultsPath } = await workspace({
    candidates: [storedCandidate(1, {
      messages: [
        { role: 'user', content: 'Begin the anchored workstream.' },
        { role: 'assistant', content: '', reasoning_content: 'still working' },
      ],
      finalAnswer: '',
      stopReason: 'turn-limit',
    })],
  })
  await assert.rejects(
    freeze(resultsPath, 1, join(directory, 'no-final.json')),
    /complete final assistant/,
  )
})

test('from-results rejects an unsafe attempt before writing', async () => {
  const { directory, resultsPath } = await workspace({
    candidates: [storedCandidate(1, {
      toolEvents: [
        { name: 'bash', accepted: true, unsafeAttempt: true, subturn: 1, args: { command: 'rm -rf /' } },
        {
          name: 'str_replace_editor',
          accepted: true,
          unsafeAttempt: false,
          subturn: 2,
          args: { command: 'view', path: '/tmp/qxk_scratch/zzq_9f3k.tmp' },
        },
      ],
    })],
  })
  await assert.rejects(
    freeze(resultsPath, 1, join(directory, 'unsafe.json')),
    /unsafe tool attempt/,
  )
})

test('from-results saves a candidate that missed the bash-then-editor protocol', async () => {
  // Tools are no longer a save gate: only unsafe attempts, a missing final
  // assistant, mismatched models/fixtures, and tampered candidate sets block.
  const { directory, resultsPath } = await workspace({
    candidates: [storedCandidate(1, {
      toolEvents: [
        { name: 'bash', accepted: true, unsafeAttempt: false, subturn: 1, args: { command: 'ls /repo' } },
      ],
      finalAnswer: 'Synthetic workstream inspected.',
      stopReason: 'final-answer',
    })],
  })
  const outputPath = join(directory, 'missing-tool.json')
  const { stderr } = await freeze(resultsPath, 1, outputPath)
  assert.equal(stderr, '')
  const artifact = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(artifact.verification.checks.exactAcceptedSequence, false)
  assert.equal(artifact.verification.checks.editorAfterBash, false)
  assert.equal(artifact.verification.checks.exactTwoToolCalls, false)
  assert.equal(artifact.verification.eligible, false)
})

test('open-workstream dry-run reports zero paid requests and no key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-dry-run-'))
  const resultsPath = join(directory, 'planned-results.json')
  const { stdout } = await run(process.execPath, [BUILDER, '--open-workstream', '--dry-run'], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'sk-should-never-appear',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      ANCHOR_RESULTS_PATH: resultsPath,
      ANCHOR_RUNS: '3',
      ANCHOR_MAX_SUBTURNS: '6',
    },
  })
  const report = JSON.parse(stdout.slice(stdout.indexOf('{')))
  assert.equal(report.paidRequestsSent, 0)
  assert.equal(report.dryRun, true)
  assert.equal(report.model, 'deepseek-v4-flash')
  assert.equal(report.fixtureId, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId)
  assert.equal(report.fixtureFingerprint, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint)
  assert.equal(report.maximumUpstreamCalls, 18)
  assert.equal(report.resultsPath, resultsPath)
  assert.equal(JSON.stringify(report).includes('sk-should-never-appear'), false)
})
