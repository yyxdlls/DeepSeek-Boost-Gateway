import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyTrajectory,
  compareArms,
  summarizeRuns,
} from '../src/lab/classifier.mjs'

function run(reasoning, toolNames = ['bash']) {
  return {
    classification: classifyTrajectory(reasoning),
    toolNames,
  }
}

test('classifies a collective minimal-style trajectory', () => {
  const result = classifyTrajectory(
    'We need inspect the repository first. We should call bash, then read the README.',
  )

  assert.equal(result.label, 'minimal-like')
  assert.equal(result.metrics.letMe, 0)
  assert.ok(result.score >= 4)
})

test('classifies a first-person standard-style trajectory', () => {
  const result = classifyTrajectory(
    'Let me inspect the repository. I will start with the shell.',
  )

  assert.equal(result.label, 'standard-like')
  assert.ok(result.metrics.letMe > 0)
  assert.ok(result.score <= -4)
})

test('classifies the observed DSH Standard trajectory signature', () => {
  const result = classifyTrajectory(
    'The user wants me to inspect the repository. Let me start with PowerShell.',
  )

  assert.equal(result.label, 'standard-like')
  assert.ok(result.score <= -4)
})

test('treats wording markers as diagnostic rather than proof', () => {
  const summary = summarizeRuns([
    run('We need inspect the repository.', []),
  ])

  assert.equal(summary.diagnosticOnly, true)
  assert.equal(summary.stableMinimalLike, false)
  assert.equal(summary.toolCallRuns, 0)
})

test('requires every run to be minimal-like and to call a tool', () => {
  const runs = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )

  const summary = summarizeRuns(runs)
  assert.equal(summary.stableMinimalLike, true)
  assert.equal(summary.totalRuns, 3)
})

test('reports a strict shift only when both arms are stable and distinct', () => {
  const minimalRuns = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )
  const controlRuns = [1, 2, 3].map(() =>
    run('Let me inspect the repository. I will use bash.'),
  )

  const comparison = compareArms(minimalRuns, controlRuns)
  assert.equal(comparison.verdict, 'strict-trajectory-shift-observed')
  assert.equal(comparison.strictTrajectoryShiftObserved, true)
})

test('rejects a false positive when both arms look minimal-like', () => {
  const minimalRuns = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )

  const comparison = compareArms(minimalRuns, minimalRuns)
  assert.equal(comparison.verdict, 'no-arm-separation')
  assert.equal(comparison.strictTrajectoryShiftObserved, false)
})
