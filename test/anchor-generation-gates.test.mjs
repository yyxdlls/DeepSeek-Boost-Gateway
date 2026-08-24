import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_CATALOG } from '../src/lab/profile.mjs'
import {
  allowedReportedModels,
  assertCandidateReportedModels,
  assertSubturnReportedModel,
  computeCandidateSetFingerprint,
} from '../src/lab/anchor-generation-gates.mjs'

test('reported model allowlist is only the request model or its servedVersion', () => {
  assert.deepEqual(
    allowedReportedModels('deepseek-v4-flash'),
    ['deepseek-v4-flash', MODEL_CATALOG['deepseek-v4-flash'].servedVersion],
  )
  assert.deepEqual(
    allowedReportedModels('deepseek-v4-flash-vision-exp'),
    [
      'deepseek-v4-flash-vision-exp',
      MODEL_CATALOG['deepseek-v4-flash-vision-exp'].servedVersion,
    ],
  )
  assert.doesNotThrow(() => {
    assertSubturnReportedModel('deepseek-v4-flash', 'deepseek-v4-flash')
    assertSubturnReportedModel('deepseek-v4-flash', 'DeepSeek-V4-Flash-0731')
    assertCandidateReportedModels('deepseek-v4-flash', [
      { subturn: 1, model: 'deepseek-v4-flash' },
      { subturn: 2, model: 'DeepSeek-V4-Flash-0731' },
    ])
  })
})

test('reported model rejects unknown values, missing reports, and incompatible mixes', () => {
  assert.throws(
    () => assertSubturnReportedModel('deepseek-v4-flash', 'deepseek-v4-pro'),
    /not deepseek-v4-flash or DeepSeek-V4-Flash-0731/,
  )
  assert.throws(
    () => assertSubturnReportedModel('deepseek-v4-flash', 'DeepSeek-V4-Flash'),
    /not deepseek-v4-flash or DeepSeek-V4-Flash-0731/,
  )
  assert.throws(
    () => assertCandidateReportedModels('deepseek-v4-flash', [
      { subturn: 1, model: null },
      { subturn: 2, model: '' },
    ]),
    /No reported model was recorded/,
  )
  assert.throws(
    () => assertCandidateReportedModels('deepseek-v4-flash', [
      { subturn: 1, model: 'deepseek-v4-flash' },
      { subturn: 2, model: 'deepseek-v4-flash-vision-exp' },
    ]),
    /not deepseek-v4-flash or DeepSeek-V4-Flash-0731/,
  )
})

test('candidate-set fingerprint changes when identity fields change', () => {
  const base = {
    requestedModel: 'deepseek-v4-flash',
    fixtureId: 'dsh-open-workstream-canonical-v1',
    fixtureFingerprint: 'abc',
    anchor: {
      task: 'task',
      openWorkstream: true,
      maxTokens: 384000,
      reasoningEffort: 'max',
      continuationMessage: 'continue',
    },
    candidates: [{
      candidateIndex: 1,
      requestFingerprints: ['r1'],
      evaluation: { acceptedToolSequence: ['bash', 'str_replace_editor'], unsafeAttempts: 0 },
      stopReason: 'final-answer',
      finalAnswer: 'done',
      reportedModels: [{ subturn: 1, model: 'deepseek-v4-flash' }],
    }],
  }
  const original = computeCandidateSetFingerprint(base)
  const tampered = computeCandidateSetFingerprint({
    ...base,
    requestedModel: 'deepseek-v4-pro',
  })
  assert.match(original, /^[0-9a-f]{64}$/)
  assert.notEqual(original, tampered)
  const editedMessages = computeCandidateSetFingerprint({
    ...base,
    candidates: [{
      ...base.candidates[0],
      messages: [{ role: 'assistant', content: 'tampered final' }],
    }],
  })
  const editedTools = computeCandidateSetFingerprint({
    ...base,
    candidates: [{
      ...base.candidates[0],
      toolEvents: [{ name: 'bash', accepted: false }],
    }],
  })
  assert.notEqual(original, editedMessages)
  assert.notEqual(original, editedTools)
})
