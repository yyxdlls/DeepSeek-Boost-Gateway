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

test('classifies a collective minimal-style chain of thought', () => {
  const result = classifyTrajectory(
    'We need inspect the repository first. We should call bash, then read the README.',
  )

  assert.equal(result.label, 'minimal')
  assert.equal(result.metrics.letMe, 0)
})

test('classifies a first-person weak chain of thought', () => {
  const result = classifyTrajectory(
    'Let me inspect the repository. Let me open the shell. Let me read the file. Let me continue.',
  )

  assert.equal(result.label, 'let-me')
  assert.ok(result.metrics.letMe > 0)
})

test('classifies the observed first-person signature when repeated', () => {
  const result = classifyTrajectory(
    'The user wants me to inspect the repository. Let me start with PowerShell. Let me read the README. Let me verify.',
  )

  assert.equal(result.label, 'let-me')
})

test('treats gray-test progressive first person as the highest-priority signal', () => {
  const progressive = classifyTrajectory("I'm checking the repository layout now.")
  assert.equal(progressive.label, 'gray-test')
  assert.equal(progressive.metrics.imIng, 1)

  const progressiveZh = classifyTrajectory('我正在核对仓库布局。')
  assert.equal(progressiveZh.label, 'gray-test')
  assert.equal(progressiveZh.metrics.imIngZh, 1)
})

test('classifies Chinese collective and interruptive chains of thought', () => {
  const collective = classifyTrajectory('我们需要先检查仓库。让我们从 bash 开始。')
  assert.equal(collective.label, 'minimal')
  assert.equal(collective.metrics.letsZh, 1)

  const interruptive = classifyTrajectory('让我先检查仓库。让我再读一下说明。让我继续。')
  assert.equal(interruptive.label, 'let-me')
  assert.equal(interruptive.metrics.letMeZh, 3)
  assert.equal(interruptive.metrics.letMe, 0)
})

test('treats wording markers as diagnostic rather than proof', () => {
  const summary = summarizeRuns([
    run('We need inspect the repository.', []),
  ])

  assert.equal(summary.diagnosticOnly, true)
  assert.equal(summary.stableMinimal, false)
  assert.equal(summary.toolCallRuns, 0)
})

test('requires every run to be minimal and to call a tool', () => {
  const runs = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )

  const summary = summarizeRuns(runs)
  assert.equal(summary.stableMinimal, true)
  assert.equal(summary.totalRuns, 3)
})

test('reports a strict shift only when both arms are stable and distinct', () => {
  const minimalRuns = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )
  const controlRuns = [1, 2, 3].map(() =>
    run('Let me inspect the repository. Let me use bash. Let me read next. Let me verify.'),
  )

  const comparison = compareArms(minimalRuns, controlRuns)
  assert.equal(comparison.verdict, 'strict-cot-shift-observed')
  assert.equal(comparison.strictCotShiftObserved, true)
})

test('rejects a false positive when both arms look minimal', () => {
  const minimalRuns = [1, 2, 3].map(() =>
    run('We need inspect the repository.'),
  )

  const comparison = compareArms(minimalRuns, minimalRuns)
  assert.equal(comparison.verdict, 'no-arm-separation')
  assert.equal(comparison.strictCotShiftObserved, false)
})
