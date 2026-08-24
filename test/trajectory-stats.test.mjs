import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OpenAiResponseObserver,
  COT_MARKER_PROFILE,
  cotStyleFromCounts,
  summarizeCacheUsage,
  summarizeMessageTrajectory,
  summarizeResponseBody,
  summarizeTextBlocks,
  summarizeTokenUsage,
} from '../src/gateway/trajectory-stats.mjs'

test('counts exactly the four v3 marker groups, English before Chinese', () => {
  const summary = summarizeTextBlocks([
    "I'm checking the fixture. I'm verifying timestamps. We need read the README. Let's continue. Let me double-check.",
  ])

  assert.equal(summary.markers.imIng, 2)
  assert.equal(summary.markers.imIngZh, 0)
  assert.equal(summary.markers.weNeed, 1)
  assert.equal(summary.markers.lets, 1)
  assert.equal(summary.markers.letMe, 1)
  // V3 dropped the purely diagnostic markers.
  assert.equal(summary.markers.iAm, undefined)
  assert.equal(summary.markers.im, undefined)
  assert.equal(summary.openingStyle, 'im')
  assert.equal(summary.openingPreview, "I'm checking the fixture.")
  assert.equal(COT_MARKER_PROFILE.diagnosticOnly, true)
})

test('counts Chinese core markers and keeps 让我 out of 让我们', () => {
  const summary = summarizeTextBlocks([
    '我们需要先检查仓库。让我们开始。让我再看一眼。我正在核对结果。让我们继续。让我想想。',
  ])

  assert.equal(summary.markers.weNeedZh, 1)
  assert.equal(summary.markers.imIngZh, 1)
  assert.equal(summary.markers.letsZh, 2)
  assert.equal(summary.markers.letMeZh, 2)
  assert.equal(summary.openingStyle, 'we-need-zh')
})

test('labels chains of thought with the v3 priority rules', () => {
  // A single progressive I'm …ing marks the gray-test CoT.
  const progressive = summarizeTextBlocks(["I'm checking the fixture list now."])
  assert.equal(progressive.cot.label, 'gray-test')
  assert.equal(progressive.openingStyle, 'im')

  const progressiveZh = summarizeTextBlocks(['我正在核对候选。'])
  assert.equal(progressiveZh.cot.label, 'gray-test')
  assert.equal(progressiveZh.openingStyle, 'im-zh')

  // collective wording with little "let me" marks the formal strong (Minimal) CoT.
  const collective = summarizeTextBlocks([
    'We need inspect the repository. Let us read the README next.',
  ])
  assert.equal(collective.cot.label, 'minimal')

  // A large amount of "let me" marks the formal weak (let me) CoT.
  const interruptive = summarizeTextBlocks([
    'Let me inspect. Let me read. Let me continue. Let me verify.',
  ])
  assert.equal(interruptive.cot.label, 'let-me')

  const interruptiveZh = summarizeTextBlocks(['让我先检查仓库。让我再看看。让我继续。'])
  assert.equal(interruptiveZh.cot.label, 'let-me')

  const mixed = summarizeTextBlocks(['The repository looks fine overall.'])
  assert.equal(mixed.cot.label, 'mixed')
})

test('leaves the produced style unchanged on large interruptive chatter', () => {
  const summary = summarizeTextBlocks([
    'Let me check. Let me verify. Let me confirm. Let me inspect. Let me continue.',
  ])
  assert.equal(summary.cot.label, 'let-me')
})

test('keeps the first sentence or 40 code points for the opening preview', () => {
  assert.equal(
    summarizeTextBlocks(['We need inspect this repository carefully.']).openingPreview,
    'We need inspect this repository carefully.',
  )
  assert.equal(
    summarizeTextBlocks(['我们需要先检查仓库。']).openingPreview,
    '我们需要先检查仓库。',
  )
  // A separator stops the preview, not a word/character limit.
  assert.equal(
    summarizeTextBlocks(['We need inspect. Then we read the README.']).openingPreview,
    'We need inspect.',
  )
  // No separator: keep the first 40 code points, English and Chinese alike.
  assert.equal(
    summarizeTextBlocks(['A'.repeat(55)]).openingPreview,
    'A'.repeat(40),
  )
  assert.equal(
    summarizeTextBlocks(['测'.repeat(55)]).openingPreview,
    '测'.repeat(40),
  )
})

test('keeps an empty or whitespace-only opening preview empty', () => {
  assert.equal(summarizeTextBlocks(['   ']).openingPreview, '')
  assert.equal(summarizeTextBlocks([]).openingPreview, '')
})

test('cotStyleFromCounts applies the documented priority', () => {
  assert.equal(cotStyleFromCounts({ imIng: 1, letMe: 5 }).label, 'gray-test')
  assert.equal(cotStyleFromCounts({ letMe: 3 }).label, 'let-me')
  assert.equal(cotStyleFromCounts({ weNeed: 1, letsZh: 1, letMe: 1 }).label, 'minimal')
  assert.equal(cotStyleFromCounts({ letMe: 2, weNeed: 1 }).label, 'mixed')
  assert.equal(cotStyleFromCounts({}).label, 'mixed')
})

test('normalizes DeepSeek and compatible-provider prompt cache usage', () => {
  assert.deepEqual(summarizeCacheUsage({
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 750,
    prompt_cache_miss_tokens: 250,
  }), {
    hitTokens: 750,
    missTokens: 250,
    totalTokens: 1000,
    hitRate: 0.75,
  })

  assert.deepEqual(summarizeCacheUsage({
    prompt_tokens: 200,
    prompt_tokens_details: { cached_tokens: 160 },
  }), {
    hitTokens: 160,
    missTokens: 40,
    totalTokens: 200,
    hitRate: 0.8,
  })
  assert.equal(summarizeCacheUsage({ total_tokens: 12 }), null)
})

test('never fabricates a hit rate from partial cache data', () => {
  const cache = summarizeCacheUsage({ prompt_cache_hit_tokens: 8 })
  assert.equal(cache.hitRate, null)
  assert.equal(cache.hitTokens, 8)
  assert.equal(cache.missTokens, 0)
  assert.equal(cache.totalTokens, 8)
})

test('normalizes token usage across provider shapes', () => {
  assert.deepEqual(summarizeTokenUsage({
    prompt_tokens: 1000,
    completion_tokens: 500,
    completion_tokens_details: { reasoning_tokens: 300 },
    prompt_cache_hit_tokens: 750,
    prompt_cache_miss_tokens: 250,
  }), {
    total: 1500,
    input: 1000,
    output: 500,
    reasoning: 300,
    content: 200,
    cacheInput: 750,
    uncachedInput: 250,
    hitRate: 0.75,
  })

  assert.deepEqual(summarizeTokenUsage({
    input_tokens: 42,
    output_tokens: 18,
    output_tokens_details: { reasoning_tokens: 6 },
  }), {
    total: 60,
    input: 42,
    output: 18,
    reasoning: 6,
    content: 12,
    cacheInput: null,
    uncachedInput: null,
    hitRate: null,
  })
})

test('accepts usage.reasoning_tokens and derives miss from the prompt total', () => {
  const tokens = summarizeTokenUsage({
    prompt_tokens: 200,
    completion_tokens: 40,
    reasoning_tokens: 25,
    prompt_tokens_details: { cached_tokens: 160 },
  })
  assert.equal(tokens.reasoning, 25)
  assert.equal(tokens.content, 15)
  assert.equal(tokens.cacheInput, 160)
  assert.equal(tokens.uncachedInput, 40)
  assert.equal(tokens.hitRate, 0.8)
})

test('keeps content null when the reasoning split is unknown', () => {
  const tokens = summarizeTokenUsage({ prompt_tokens: 10, completion_tokens: 4 })
  assert.equal(tokens.content, null)
  assert.equal(tokens.reasoning, null)
})

test('summarizes historical assistant messages without mixing tool results', () => {
  const summary = summarizeMessageTrajectory([
    { role: 'user', content: 'Task' },
    {
      role: 'assistant',
      reasoning_content: 'We need inspect.',
      content: '',
      tool_calls: [{ id: 'one', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'one', content: 'Let me appear in a result.' },
  ], 'anchor_history')

  assert.equal(summary.scope, 'anchor_history')
  assert.equal(summary.reasoning.markers.weNeed, 1)
  assert.equal(summary.reasoning.markers.letMe, 0)
  assert.deepEqual(summary.tools.names, ['bash'])
})

test('summarizes a JSON response with current-response scope', () => {
  const summary = summarizeResponseBody(JSON.stringify({
    choices: [{
      index: 0,
      message: {
        reasoning_content: 'Let me inspect.',
        content: 'done',
        tool_calls: [{ id: 'one', function: { name: 'read', arguments: '{"path":"x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      total_tokens: 12,
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 2,
    },
  }), 'application/json')

  assert.equal(summary.scope, 'current_response')
  assert.equal(summary.complete, true)
  assert.equal(summary.reasoning.markers.letMe, 1)
  assert.equal(summary.reasoning.openingStyle, 'let-me')
  assert.equal(summary.content.chars, 4)
  assert.deepEqual(summary.tools.names, ['read'])
  assert.equal(summary.usage.total_tokens, 12)
  assert.equal(summary.cache.hitRate, 0.8)
  assert.equal(summary.tokens.input, 10)
  assert.equal(summary.tokens.output, null)
  assert.equal(summary.tokens.reasoning, null)
  assert.equal(summary.tokens.cacheInput, 8)
  assert.equal(summary.tokens.uncachedInput, 2)
  assert.equal(summary.tokens.hitRate, 0.8)
})

test('reassembles phrases and tool calls split across SSE network chunks', () => {
  const observer = new OpenAiResponseObserver('text/event-stream')
  const source = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"We need inspect. Le"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"t me verify."}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"two","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":20}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  for (let index = 0; index < source.length; index += 7) {
    observer.push(Buffer.from(source.slice(index, index + 7)))
  }
  const summary = observer.finish()

  assert.equal(summary.complete, true)
  assert.equal(summary.reasoning.markers.weNeed, 1)
  assert.equal(summary.reasoning.markers.letMe, 1)
  assert.equal(summary.tools.callCount, 2)
  assert.deepEqual(summary.tools.names, ['bash', 'read'])
  assert.equal(summary.tools.fragments, 3)
  assert.equal(summary.usage.total_tokens, 20)

  // The raw view reassembles tool-call arguments across chunks.
  const raw = observer.assembledMessages()
  assert.equal(raw.length, 1)
  assert.equal(raw[0].tool_calls.length, 2)
  assert.equal(raw[0].tool_calls[0].function.arguments, '{"command":"pwd"}')
  assert.equal(raw[0].reasoning_content, 'We need inspect. Let me verify.')
})

test('reports observation truncation independently from client aborts', () => {
  const observer = new OpenAiResponseObserver('application/json', { maxJsonBytes: 8 })
  observer.push(Buffer.from('{"choices":[{"message":{"content":"long"}}]}'))
  const summary = observer.finish({ abortedByClient: true })

  assert.equal(summary.observationTruncated, true)
  assert.equal(summary.abortedByClient, true)
  assert.equal(summary.complete, false)
})
