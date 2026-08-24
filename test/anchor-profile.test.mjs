import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANCHOR_TASK,
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  OPEN_WORKSTREAM_FIXTURE_FINGERPRINT,
  OPEN_WORKSTREAM_FIXTURE_ID,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  SYNTHETIC_REPOSITORY,
  buildInitialAnchorRequest,
  evaluateAnchorCandidate,
  evaluateOpenWorkstreamCandidate,
  normalizeAssistantMessage,
  syntheticToolResult,
} from '../src/lab/anchor-profile.mjs'
import {
  canonicalFixtureIdentity,
  fixtureFingerprint,
} from '../src/lab/anchor-generation-gates.mjs'

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function validCandidate(overrides = {}) {
  return {
    assistantTurns: [
      {
        subturn: 1,
        reasoning: 'We need inspect the synthetic repository first.',
        content: '',
        toolNames: ['bash'],
      },
      {
        subturn: 2,
        reasoning: 'We need read the located README with the editor.',
        content: '',
        toolNames: ['str_replace_editor'],
      },
      {
        subturn: 3,
        reasoning: 'We need now give the concise result.',
        content: 'A deterministic protocol fixture tested with npm test.',
        toolNames: [],
      },
    ],
    toolEvents: [
      {
        subturn: 1,
        name: 'bash',
        args: { command: "pwd && find . -maxdepth 2 -iname 'readme*'" },
        accepted: true,
        unsafeAttempt: false,
      },
      {
        subturn: 2,
        name: 'str_replace_editor',
        args: { command: 'view', path: '/repo/README.md' },
        accepted: true,
        unsafeAttempt: false,
      },
    ],
    finalAnswer: 'A deterministic protocol fixture tested with npm test.',
    stopReason: 'final-answer',
    ...overrides,
  }
}

test('builds a full-capability request that exposes exactly both Minimal tools', () => {
  const request = buildInitialAnchorRequest()

  assert.equal(request.max_tokens, 384_000)
  assert.equal(request.messages[1].content, ANCHOR_TASK)
  assert.deepEqual(
    request.tools.map((tool) => tool.function.name),
    ['bash', 'str_replace_editor'],
  )
  assert.match(request.messages[1].content, /exactly one bash call/)
  assert.match(request.messages[1].content, /later assistant turn/)
})

test('passes the selected reasoning effort into the Anchor request', () => {
  assert.equal(buildInitialAnchorRequest({ reasoningEffort: 'low' }).reasoning_effort, 'low')
  assert.equal(buildInitialAnchorRequest({ reasoningEffort: 'high' }).reasoning_effort, 'high')
  assert.equal(buildInitialAnchorRequest({ reasoningEffort: 'max' }).reasoning_effort, 'max')
})

test('normalizes assistant messages for exact thinking-mode replay', () => {
  const calls = [toolCall('call-1', 'bash', { command: 'pwd' })]
  const normalized = normalizeAssistantMessage({
    content: null,
    reasoning_content: 'We need inspect first.',
    tool_calls: calls,
  })

  calls[0].function.name = 'changed-after-normalization'
  assert.equal(normalized.content, '')
  assert.equal(normalized.reasoning_content, 'We need inspect first.')
  assert.equal(normalized.tool_calls[0].function.name, 'bash')
  assert.equal(
    normalizeAssistantMessage({ content: 'done' }).reasoning_content,
    '',
  )
})

test('builds an open workstream prompt that ends with a final assistant response', () => {
  const request = buildInitialAnchorRequest({
    userPrompt: OPEN_WORKSTREAM_ANCHOR_TASK,
  })
  assert.equal(request.messages[1].content, OPEN_WORKSTREAM_ANCHOR_TASK)
  assert.match(request.messages[1].content, /\/tmp\/qxk_scratch/)
  assert.match(request.messages[1].content, /zzq_9f3k\.tmp/)
  assert.match(request.messages[1].content, /This file will be removed later/)
  assert.match(request.messages[1].content, /cache hit rate drops suddenly/)
  assert.doesNotMatch(request.messages[1].content, /warmup|probe is over|WORKSTREAM|README\.md|热身/)
})

test('returns a deterministic bash result without executing the command', () => {
  const result = syntheticToolResult(
    toolCall('call-1', 'bash', {
      command: "pwd && find . -maxdepth 2 -iname 'readme*'",
    }),
    { bashCompletedBeforeSubturn: false },
    1,
  )

  assert.equal(result.event.accepted, true)
  assert.equal(result.message.content, SYNTHETIC_REPOSITORY.bashResult)
})

test('allows read-only stderr suppression but still rejects file redirects', () => {
  const suppressed = syntheticToolResult(
    toolCall('call-safe', 'bash', {
      command: 'ls -la /tmp/qxk_scratch && find /tmp/qxk_scratch -name zzq_9f3k.tmp 2>/dev/null',
    }),
    { bashCompletedBeforeSubturn: false },
    1,
    OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  )
  const fileWrite = syntheticToolResult(
    toolCall('call-write', 'bash', { command: 'ls -la > listing.txt' }),
    { bashCompletedBeforeSubturn: false },
    1,
    OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  )
  assert.equal(suppressed.event.accepted, true)
  assert.equal(fileWrite.event.accepted, false)
  assert.equal(fileWrite.event.unsafeAttempt, true)
})

test('rejects editor calls before the bash result has completed', () => {
  const result = syntheticToolResult(
    toolCall('call-2', 'str_replace_editor', {
      command: 'view',
      path: '/repo/README.md',
    }),
    { bashCompletedBeforeSubturn: false },
    1,
  )

  assert.equal(result.event.accepted, false)
  assert.equal(result.event.rejection, 'bash-must-complete-first')
})

test('accepts only a later read-only editor view of the fixed README', () => {
  const accepted = syntheticToolResult(
    toolCall('call-2', 'str_replace_editor', {
      command: 'view',
      path: '/repo/README.md',
    }),
    { bashCompletedBeforeSubturn: true },
    2,
  )
  const mutation = syntheticToolResult(
    toolCall('call-3', 'str_replace_editor', {
      command: 'str_replace',
      path: '/repo/README.md',
      old_str: 'fixture',
      new_str: 'changed',
    }),
    { bashCompletedBeforeSubturn: true },
    2,
  )

  assert.equal(accepted.event.accepted, true)
  assert.equal(accepted.message.content, SYNTHETIC_REPOSITORY.readmeResult)
  assert.equal(mutation.event.accepted, false)
  assert.equal(mutation.event.unsafeAttempt, true)
})

test('serves the open-workstream document through the same two-tool protocol', () => {
  const result = syntheticToolResult(
    toolCall('call-open', 'str_replace_editor', {
      command: 'view',
      path: '/tmp/qxk_scratch/zzq_9f3k.tmp',
    }),
    { bashCompletedBeforeSubturn: true },
    2,
    OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  )
  assert.equal(result.event.accepted, true)
  assert.equal(result.message.content, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.readmeResult)
  assert.match(result.message.content, /^ {5}1\tok$/)
})

test('rejects mutating shell commands and shell-based README reads', () => {
  const mutation = syntheticToolResult(
    toolCall('call-1', 'bash', { command: 'touch README.md' }),
    { bashCompletedBeforeSubturn: false },
    1,
  )
  const shellRead = syntheticToolResult(
    toolCall('call-2', 'bash', { command: 'cat README.md' }),
    { bashCompletedBeforeSubturn: false },
    1,
  )

  assert.equal(mutation.event.accepted, false)
  assert.equal(mutation.event.unsafeAttempt, true)
  assert.equal(shellRead.event.accepted, false)
  assert.equal(shellRead.event.rejection, 'readme-must-use-editor')
})

test('accepts only the exact sequential two-tool trajectory', () => {
  const evaluation = evaluateAnchorCandidate(validCandidate())

  assert.equal(evaluation.eligible, true)
  assert.deepEqual(evaluation.acceptedToolSequence, [
    'bash',
    'str_replace_editor',
  ])
  assert.equal(evaluation.totalToolCalls, 2)
  assert.ok(Object.values(evaluation.checks).every(Boolean))
})

test('rejects invalid tool structure but only reports Let me drift', () => {
  const base = validCandidate()
  const duplicate = evaluateAnchorCandidate(
    validCandidate({
      toolEvents: [...base.toolEvents, { ...base.toolEvents[1], subturn: 3 }],
    }),
  )
  const sameTurn = evaluateAnchorCandidate(
    validCandidate({
      toolEvents: base.toolEvents.map((event) => ({ ...event, subturn: 1 })),
    }),
  )
  const drift = evaluateAnchorCandidate(
    validCandidate({
      assistantTurns: base.assistantTurns.map((turn, index) =>
        index === 1
          ? { ...turn, reasoning: 'Let me read the README now.' }
          : turn,
      ),
    }),
  )

  assert.equal(duplicate.eligible, false)
  assert.equal(duplicate.checks.exactTwoToolCalls, false)
  assert.equal(sameTurn.eligible, false)
  assert.equal(sameTurn.checks.editorAfterBash, false)
  assert.equal(drift.eligible, true)
  assert.equal(drift.eligibilityBasis, 'protocol-only')
  assert.equal(drift.observations.letMeFree, false)
  assert.equal(drift.letMeTotal, 1)
})

test('default continuation is a single neutral sentence without behavioral steering', () => {
  assert.equal(
    OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
    "Let's continue our work.",
  )
  assert.doesNotMatch(
    OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
    /inspect-before-act|integrate|never invent/i,
  )
})

test('open-workstream fixture id and fingerprint are stable and model-agnostic', () => {
  assert.equal(OPEN_WORKSTREAM_FIXTURE_ID, 'dsh-open-workstream-canonical-v2')
  assert.equal(OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId, OPEN_WORKSTREAM_FIXTURE_ID)
  assert.equal(OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint, OPEN_WORKSTREAM_FIXTURE_FINGERPRINT)
  assert.match(OPEN_WORKSTREAM_FIXTURE_FINGERPRINT, /^[0-9a-f]{64}$/)
  assert.equal(
    fixtureFingerprint(OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY),
    OPEN_WORKSTREAM_FIXTURE_FINGERPRINT,
  )
  const serialized = JSON.stringify(canonicalFixtureIdentity())
  assert.doesNotMatch(serialized, /call_00_AUeQqHMaETvNM4ff8igG3833/)
  assert.doesNotMatch(serialized, /call_00_qsp9jK74RnKsZ1TEpHtv0927/)
  assert.doesNotMatch(serialized, /We need follow user instructions precisely/)
  assert.doesNotMatch(serialized, /a307abda487cd1b463329ccb945ce396/)
  assert.doesNotMatch(serialized, /reasoning_content/)
  assert.doesNotMatch(serialized, /"role":"assistant"/)
})

test('accepts an open-workstream Anchor only as a complete conversation', () => {
  const candidate = validCandidate()
  const evaluation = evaluateOpenWorkstreamCandidate(candidate)
  assert.equal(evaluation.eligible, true)
  assert.equal(evaluation.checks.hasFinalAnswer, true)
  assert.equal(evaluation.checks.completedWithinTurnLimit, true)
})
