import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANCHOR_TASK,
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  SYNTHETIC_REPOSITORY,
  buildInitialAnchorRequest,
  evaluateAnchorCandidate,
  evaluateOpenWorkstreamCandidate,
  normalizeAssistantMessage,
  syntheticToolResult,
} from '../src/lab/anchor-profile.mjs'

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

test('builds an open workstream prompt without a terminal answer step', () => {
  const request = buildInitialAnchorRequest({
    userPrompt: OPEN_WORKSTREAM_ANCHOR_TASK,
  })
  assert.equal(request.messages[1].content, OPEN_WORKSTREAM_ANCHOR_TASK)
  assert.match(request.messages[1].content, /long, interconnected/)
  assert.match(request.messages[1].content, /test your ability to investigate/)
  assert.match(request.messages[1].content, /continuing work/)
  assert.doesNotMatch(request.messages[1].content, /phase|next stage|environment/i)
  assert.doesNotMatch(request.messages[1].content, /summarize the repository/i)
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
      command: 'ls -la /repo && find /repo -name WORKSTREAM.md 2>/dev/null',
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
      path: '/repo/WORKSTREAM.md',
    }),
    { bashCompletedBeforeSubturn: true },
    2,
    OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  )
  assert.equal(result.event.accepted, true)
  assert.match(result.message.content, /Interconnected Engineering Problem/)
  assert.match(result.message.content, /instead of restarting the analysis/)
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

test('accepts an open anchor that stops on the second tool result', () => {
  const candidate = validCandidate({
    assistantTurns: validCandidate().assistantTurns.slice(0, 2),
    finalAnswer: '',
    stopReason: 'open-after-second-tool-result',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'orientation' },
      { role: 'assistant', content: '', reasoning_content: 'We need inspect.', tool_calls: [] },
      { role: 'tool', tool_call_id: 'call-1', content: 'repo' },
      { role: 'assistant', content: '', reasoning_content: 'We need read.', tool_calls: [] },
      { role: 'tool', tool_call_id: 'call-2', content: 'brief' },
    ],
  })
  const evaluation = evaluateOpenWorkstreamCandidate(candidate)
  assert.equal(evaluation.eligible, true)
  assert.equal(evaluation.checks.noFinalAnswer, true)
  assert.equal(evaluation.checks.remainsOpenAfterSecondToolResult, true)
})
