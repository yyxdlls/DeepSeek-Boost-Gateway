// Shared token / current-input helpers for the WebUI. This file runs as an
// ES module both in Node (named-export unit tests without any frontend test
// framework) and in the browser, where app.js imports it directly.
// The algorithms mirror the server-side normalization in trajectory-stats.mjs
// and diagnostic-history.mjs so old diagnostic entries (saved before those
// fields existed) are rendered with the same numbers.

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number) && number >= 0) return number
  }
  return null
}

export function cacheUsageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null
  let hitTokens = firstNumber(
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
  )
  let missTokens = firstNumber(usage.prompt_cache_miss_tokens)
  const promptTokens = firstNumber(usage.prompt_tokens, usage.input_tokens)

  let hitKnown = hitTokens !== null
  let missKnown = missTokens !== null
  if (!hitKnown && !missKnown) return null
  if (!missKnown && hitKnown && promptTokens !== null) {
    missTokens = Math.max(0, promptTokens - hitTokens)
    missKnown = true
  }
  if (!hitKnown && missKnown && promptTokens !== null) {
    hitTokens = Math.max(0, promptTokens - missTokens)
    hitKnown = true
  }
  const hit = hitTokens ?? 0
  const miss = missTokens ?? 0
  const totalTokens = hit + miss
  return {
    hitTokens: hit,
    missTokens: miss,
    totalTokens,
    hitRate: hitKnown && missKnown && totalTokens > 0 ? hit / totalTokens : null,
  }
}

export function normalizeTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = firstNumber(usage.prompt_tokens, usage.input_tokens)
  const output = firstNumber(usage.completion_tokens, usage.output_tokens)
  const reasoning = firstNumber(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
  )
  const cache = cacheUsageFrom(usage)
  const total = firstNumber(usage.total_tokens)
    ?? (input !== null && output !== null ? input + output : null)
  return {
    total,
    input,
    output,
    reasoning,
    content: output !== null && reasoning !== null ? Math.max(0, output - reasoning) : null,
    cacheInput: cache?.hitTokens ?? null,
    uncachedInput: cache?.missTokens ?? null,
    hitRate: cache?.hitRate ?? null,
  }
}

// Prefers the server-normalized summary.tokens field; falls back to
// normalizing the raw usage so entries written before the field existed
// display consistently.
export function tokensFromSummary(summary) {
  if (summary && typeof summary === 'object'
    && summary.tokens && typeof summary.tokens === 'object') {
    return summary.tokens
  }
  return normalizeTokens(summary?.usage)
}

// Mirrors currentInputMessages in diagnostic-history.mjs for old entries
// that only saved the full request message list.
export function currentInputMessages(messages) {
  if (!Array.isArray(messages)) return null
  let lastAssistant = -1
  messages.forEach((message, index) => {
    if (message?.role === 'assistant') lastAssistant = index
  })
  const tail = lastAssistant >= 0
    ? messages.slice(lastAssistant + 1)
    : messages
  const input = tail.filter((message) => ['user', 'tool'].includes(message?.role))
  return input.length ? input : null
}
