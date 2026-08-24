import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cacheUsageFrom,
  currentInputMessages,
  normalizeTokens,
  tokensFromSummary,
} from '../src/gateway/web/token-utils.js'

test('normalizeTokens unifies provider token fields', () => {
  const tokens = normalizeTokens({
    prompt_tokens: 10,
    completion_tokens: 4,
    completion_tokens_details: { reasoning_tokens: 2 },
    prompt_cache_hit_tokens: 6,
    prompt_cache_miss_tokens: 4,
  })
  assert.deepEqual(tokens, {
    total: 14,
    input: 10,
    output: 4,
    reasoning: 2,
    content: 2,
    cacheInput: 6,
    uncachedInput: 4,
    hitRate: 0.6,
  })
})

test('normalizeTokens accepts the alternative reasoning sources', () => {
  const details = normalizeTokens({
    input_tokens: 42,
    output_tokens: 18,
    output_tokens_details: { reasoning_tokens: 6 },
  })
  assert.deepEqual(details, {
    total: 60,
    input: 42,
    output: 18,
    reasoning: 6,
    content: 12,
    cacheInput: null,
    uncachedInput: null,
    hitRate: null,
  })
  assert.equal(normalizeTokens({ reasoning_tokens: 9 }).reasoning, 9)
})

test('tokensFromSummary prefers summary.tokens and falls back to raw usage', () => {
  const normalized = {
    input: 5,
    output: 2,
    reasoning: 1,
    content: 1,
    cacheInput: 3,
    uncachedInput: 2,
    hitRate: 0.6,
  }
  assert.equal(tokensFromSummary({ tokens: normalized, usage: { nope: 1 } }), normalized)

  const fallback = tokensFromSummary({ usage: { prompt_tokens: 7, completion_tokens: 3 } })
  assert.equal(fallback.input, 7)
  assert.equal(fallback.output, 3)
  assert.equal(fallback.content, null)

  assert.equal(tokensFromSummary({}), null)
  assert.equal(tokensFromSummary(undefined), null)
})

test('cacheUsageFrom derives the missing side from the prompt total', () => {
  assert.deepEqual(cacheUsageFrom({
    prompt_tokens: 200,
    prompt_tokens_details: { cached_tokens: 160 },
  }), {
    hitTokens: 160,
    missTokens: 40,
    totalTokens: 200,
    hitRate: 0.8,
  })
  assert.deepEqual(cacheUsageFrom({
    prompt_tokens: 200,
    cache_read_input_tokens: 50,
    prompt_cache_miss_tokens: 150,
  }), {
    hitTokens: 50,
    missTokens: 150,
    totalTokens: 200,
    hitRate: 0.25,
  })
  assert.equal(cacheUsageFrom({ total_tokens: 12 }), null)
  assert.equal(cacheUsageFrom({ prompt_cache_hit_tokens: 8 }).hitRate, null)
})

test('currentInputMessages mirrors the server fallback for old entries', () => {
  assert.deepEqual(
    currentInputMessages([
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', tool_call_id: 't', content: 'r' },
      { role: 'user', content: 'u' },
    ]),
    [
      { role: 'tool', tool_call_id: 't', content: 'r' },
      { role: 'user', content: 'u' },
    ],
  )
  assert.deepEqual(
    currentInputMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'first' },
    ]),
    [{ role: 'user', content: 'first' }],
  )
  assert.equal(currentInputMessages([{ role: 'assistant' }]), null)
  assert.equal(currentInputMessages(null), null)
})
