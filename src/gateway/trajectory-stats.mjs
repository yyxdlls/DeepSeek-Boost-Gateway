// Markers implement the v3 chain-of-thought (思维链) semantics. Exactly four
// keyword groups are tracked, English before Chinese within each group, and
// the array order below is the display order (most positive first):
//   strong-positive  "I'm xxxing" / 我正在  -> gray-test CoT signature
//   positive         "we need" / 我们需要   -> formal strong (Minimal) CoT
//   positive         "let's" / 让我们       -> formal strong (Minimal) CoT
//   negative         "let me" / 让我(们除外) -> formal weak (let me) CoT
// English matching is case-insensitive with phrase boundaries; Chinese uses
// literal prefixes. 让我 must not match inside 让我们, hence the lookahead.
// Only reasoning text is counted; visible content is never scanned.
const MARKER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'imIng', label: "I'm …ing", polarity: 'strong-positive', source: '灰度测试思维链特征', pattern: /\bi['\u2019]m\s+[a-z]+ing\b/giu }),
  Object.freeze({ id: 'imIngZh', label: '我正在', polarity: 'strong-positive', source: '灰度测试思维链特征', pattern: /我正在/gu }),
  Object.freeze({ id: 'weNeed', label: 'we need', polarity: 'positive', source: '正式版强思维链（Minimal）', pattern: /\bwe\s+need\b/giu }),
  Object.freeze({ id: 'weNeedZh', label: '我们需要', polarity: 'positive', source: '正式版强思维链（Minimal）', pattern: /我们需要/gu }),
  Object.freeze({ id: 'lets', label: "let's", polarity: 'positive', source: '正式版强思维链（Minimal）', pattern: /\blet['\u2019]s\b/giu }),
  Object.freeze({ id: 'letsZh', label: '让我们', polarity: 'positive', source: '正式版强思维链（Minimal）', pattern: /让我们/gu }),
  Object.freeze({ id: 'letMe', label: 'let me', polarity: 'negative', source: '正式版弱思维链（let me）', pattern: /\blet\s+me\b/giu }),
  Object.freeze({ id: 'letMeZh', label: '让我', polarity: 'negative', source: '正式版弱思维链（let me）', pattern: /让我(?!们)/gu }),
])

export const COT_MARKER_PROFILE = Object.freeze({
  id: 'deepseek-cot-markers-v3',
  diagnosticOnly: true,
  matching: 'case-insensitive English phrase boundaries plus literal Chinese markers; 让我 excludes 让我们; I\'m …ing requires a progressive verb',
  blockStats: ['chars', 'utf8Bytes', 'min', 'p50', 'p90', 'max'],
  openingMarkers: ['good', 'great', 'excellent'],
  markers: MARKER_DEFINITIONS.map(({ id, label, polarity, source }) => ({ id, label, polarity, source })),
})

function occurrences(text, pattern) {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].length
}

function markerCounts(text) {
  return Object.fromEntries(
    MARKER_DEFINITIONS.map(({ id, pattern }) => [id, occurrences(text, pattern)]),
  )
}

function addCounts(target, counts) {
  for (const [name, count] of Object.entries(counts)) {
    target[name] = (target[name] ?? 0) + count
  }
}

function openingStyle(text) {
  const trimmed = text.trimStart()
  if (!trimmed) return 'empty'
  if (/^we\s+need\b/iu.test(trimmed)) return 'we-need'
  if (/^i['\u2019]m\b/iu.test(trimmed)) return 'im'
  if (/^let\s+me\b/iu.test(trimmed)) return 'let-me'
  if (/^let['\u2019]s\b/iu.test(trimmed)) return 'lets'
  if (/^the\s+user\s+wants\b/iu.test(trimmed)) return 'the-user-wants'
  if (/^i\s+(need|should|will)\b/iu.test(trimmed)) return 'i-personal'
  if (/^i\s+am\b/iu.test(trimmed)) return 'i-am'
  if (/^我们需要/u.test(trimmed)) return 'we-need-zh'
  if (/^让我们/u.test(trimmed)) return 'lets-zh'
  if (/^我正在/u.test(trimmed)) return 'im-zh'
  if (/^让我(?!们)/u.test(trimmed)) return 'let-me-zh'
  if (/^(我需要|我应该|我会|我将)/u.test(trimmed)) return 'i-personal-zh'
  const marker = trimmed.match(/^(good|great|excellent)\.(?:\s|$)/iu)
  if (marker) return `marker-${marker[1].toLowerCase()}`
  return 'other'
}

// Opening preview keeps the first sentence (up to and including the first
// sentence separator), or the first 40 code points when the text has no
// separator. Both English and Chinese count code points, so the preview is
// neither four words nor four characters.
const OPENING_SENTENCE_SEPARATORS = /[。．.！!？?]/u

function cotOpeningPreview(text) {
  const trimmed = text.trimStart().replace(/\s+/gu, ' ')
  if (!trimmed) return ''
  const end = trimmed.search(OPENING_SENTENCE_SEPARATORS)
  if (end !== -1) return trimmed.slice(0, end + 1)
  return [...trimmed].slice(0, 40).join('')
}

export const openingPreview = cotOpeningPreview

// v3 chain-of-thought style. Priority per product decision:
//   1. A single "I'm xxxing" / 我正在 occurrence -> gray-test CoT.
//   2. A large amount of "let me" / 让我 (>= 3)    -> formal weak (let me) CoT.
//   3. collective (we need / 我们需要 / let's / 让我们) present and at least
//      twice the interruptive count -> formal strong (Minimal) CoT.
//   4. Anything else -> mixed.
export function cotStyleFromCounts(markers) {
  const count = (id) => Number(markers?.[id] ?? 0)
  const progressive = count('imIng') + count('imIngZh')
  const collective = count('weNeed') + count('weNeedZh') + count('lets') + count('letsZh')
  const interruptive = count('letMe') + count('letMeZh')
  let label = 'mixed'
  if (progressive >= 1) label = 'gray-test'
  else if (interruptive >= 3) label = 'let-me'
  else if (collective >= 1 && collective >= interruptive * 2) label = 'minimal'
  return {
    label,
    counts: { progressive, collective, interruptive },
    diagnosticOnly: true,
  }
}

function cotStyle(markers) {
  return cotStyleFromCounts(markers)
}

function emptyMarkerCounts() {
  return Object.fromEntries(MARKER_DEFINITIONS.map(({ id }) => [id, 0]))
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor((ordered.length - 1) * fraction)]
}

export function summarizeTextBlocks(blocks) {
  const normalized = blocks.filter((block) => typeof block === 'string')
  const markers = emptyMarkerCounts()
  let chars = 0
  let utf8Bytes = 0
  let nonEmptyBlocks = 0
  let primaryText = ''
  let markerStarts = 0
  let exactMarkerFirstLines = 0
  const lengths = []

  for (const text of normalized) {
    chars += text.length
    utf8Bytes += Buffer.byteLength(text, 'utf8')
    addCounts(markers, markerCounts(text))
    if (text.length > 0) {
      nonEmptyBlocks += 1
      lengths.push(text.length)
      if (!primaryText) primaryText = text
      const trimmed = text.trimStart()
      const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
      markerStarts += /^(good|great|excellent)\.(?:\s|$)/iu.test(trimmed) ? 1 : 0
      exactMarkerFirstLines += /^(good|great|excellent)\.?$/iu.test(firstLine) ? 1 : 0
    }
  }

  const opening = openingStyle(primaryText)
  return {
    chars,
    utf8Bytes,
    blocks: normalized.length,
    nonEmptyBlocks,
    blockChars: {
      min: lengths.length ? Math.min(...lengths) : 0,
      p50: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
      max: lengths.length ? Math.max(...lengths) : 0,
    },
    markerStarts,
    exactMarkerFirstLines,
    markerProfile: COT_MARKER_PROFILE.id,
    markers,
    openingStyle: opening,
    openingPreview: cotOpeningPreview(primaryText),
    cot: cotStyle(markers),
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .join('')
}

function messageReasoning(message) {
  const value = message?.reasoning_content ?? message?.reasoning
  return typeof value === 'string' ? value : ''
}

function callName(call) {
  return typeof call?.function?.name === 'string' ? call.function.name : ''
}

function summarizeCalls(calls) {
  const names = calls.map(callName).filter(Boolean)
  return {
    callCount: calls.length,
    names,
    distinctNames: [...new Set(names)],
  }
}

export function summarizeMessageTrajectory(messages, scope = 'conversation_history') {
  const assistantMessages = Array.isArray(messages)
    ? messages.filter((message) => message?.role === 'assistant')
    : []
  const reasoningBlocks = assistantMessages.map(messageReasoning)
  const contentBlocks = assistantMessages.map((message) => contentText(message.content))
  const calls = assistantMessages.flatMap((message) => message.tool_calls ?? [])

  return {
    schemaVersion: 1,
    scope,
    assistantMessages: assistantMessages.length,
    reasoning: summarizeTextBlocks(reasoningBlocks),
    content: summarizeTextBlocks(contentBlocks),
    tools: summarizeCalls(calls),
  }
}

function responseState() {
  return {
    choices: new Map(),
    toolCallFragments: 0,
    finishReasons: new Set(),
    usage: null,
    parseErrors: 0,
  }
}

function nonNegativeNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function firstNumber(...values) {
  for (const value of values) {
    const number = nonNegativeNumber(value)
    if (number !== null) return number
  }
  return null
}

// Unified prompt-cache normalization. cacheInput prefers the three
// compatible-provider fields (DeepSeek prompt_cache_hit_tokens, OpenAI-style
// prompt_tokens_details.cached_tokens, others' cache_read_input_tokens);
// uncachedInput prefers prompt_cache_miss_tokens and is derived from
// input - cacheInput when the upstream omits it. hitRate is only reported
// when both sides are known (directly or derived from the prompt total),
// so partial usage is never presented as a fabricated hit rate.
export function summarizeCacheUsage(usage) {
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

// Stable token normalization across provider usage shapes. input/output use
// the prompt/completion aliases; reasoning prefers the details sub-objects
// (DeepSeek-style completion_tokens_details / OpenAI-style
// output_tokens_details) and falls back to usage.reasoning_tokens; content is
// derived as output - reasoning only when both are known. Raw usage stays on
// summary.usage untouched; this object is the stable display contract.
export function summarizeTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = firstNumber(usage.prompt_tokens, usage.input_tokens)
  const output = firstNumber(usage.completion_tokens, usage.output_tokens)
  const reasoning = firstNumber(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
  )
  const cache = summarizeCacheUsage(usage)
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

function choiceState(state, index) {
  const key = String(index ?? 0)
  if (!state.choices.has(key)) {
    state.choices.set(key, {
      index: index ?? 0,
      reasoning: '',
      content: '',
      calls: new Map(),
      nextCallIndex: 0,
    })
  }
  return state.choices.get(key)
}

function appendToolCalls(state, choice, calls) {
  for (const call of calls ?? []) {
    const key = call?.index !== undefined
      ? `index:${call.index}`
      : call?.id
        ? `id:${call.id}`
        : `position:${choice.nextCallIndex++}`
    if (!choice.calls.has(key)) {
      choice.calls.set(key, { id: call?.id ?? null, name: '', arguments: '', argumentsChars: 0 })
    }
    const accumulated = choice.calls.get(key)
    if (call?.id) accumulated.id = call.id
    if (typeof call?.function?.name === 'string') {
      const fragment = call.function.name
      if (!accumulated.name) accumulated.name = fragment
      else if (fragment === accumulated.name) {
        // Some compatible providers repeat the full name in every delta.
      } else if (fragment.startsWith(accumulated.name)) accumulated.name = fragment
      else accumulated.name += fragment
    }
    if (typeof call?.function?.arguments === 'string') {
      accumulated.arguments += call.function.arguments
      accumulated.argumentsChars += call.function.arguments.length
    }
    state.toolCallFragments += 1
  }
}

function accumulateChoice(state, rawChoice) {
  const choice = choiceState(state, rawChoice?.index)
  const message = rawChoice?.delta ?? rawChoice?.message ?? {}
  const reasoning = messageReasoning(message)
  const content = contentText(message.content)
  choice.reasoning += reasoning
  choice.content += content
  appendToolCalls(state, choice, message.tool_calls)
  if (rawChoice?.finish_reason) state.finishReasons.add(rawChoice.finish_reason)
}

function accumulatePayload(state, payload) {
  for (const [position, choice] of (payload?.choices ?? []).entries()) {
    accumulateChoice(
      state,
      choice?.index === undefined ? { ...choice, index: position } : choice,
    )
  }
  if (payload?.usage) state.usage = payload.usage
}

function finishResponseState(state, format, options = {}) {
  const choices = [...state.choices.values()].sort((left, right) => left.index - right.index)
  const calls = choices.flatMap((choice) => [...choice.calls.values()])
  const names = calls.map((call) => call.name).filter(Boolean)
  const reasoning = summarizeTextBlocks(choices.map((choice) => choice.reasoning))
  const content = summarizeTextBlocks(choices.map((choice) => choice.content))
  const finishReasons = [...state.finishReasons]
  const abortedByClient = Boolean(options.abortedByClient)
  const transportError = options.transportError ?? null
  const observationTruncated = Boolean(options.observationTruncated)

  return {
    schemaVersion: 2,
    scope: 'current_response',
    format,
    complete:
      !abortedByClient &&
      !transportError &&
      finishReasons.length > 0,
    abortedByClient,
    transportError,
    observationComplete: !observationTruncated && state.parseErrors === 0,
    observationTruncated,
    parseErrors: state.parseErrors,
    reasoning,
    content,
    tools: {
      callCount: calls.length,
      fragments: state.toolCallFragments,
      names,
      distinctNames: [...new Set(names)],
      argumentChars: calls.reduce((sum, call) => sum + call.argumentsChars, 0),
    },
    finishReasons,
    usage: state.usage,
    tokens: summarizeTokenUsage(state.usage),
    cache: summarizeCacheUsage(state.usage),
    markerProfile: COT_MARKER_PROFILE.id,
    diagnosticOnly: true,
    reasoningChars: reasoning.chars,
    contentChars: content.chars,
    toolCallCount: calls.length,
    toolCallFragments: state.toolCallFragments,
    toolNames: [...new Set(names)],
  }
}

// Reassembles the accumulated assistant messages (reasoning, content, and
// fully joined tool-call arguments) for local diagnostic display. The summary
// above stays statistical; this raw view is only used by the WebUI dialog.
function assembledAssistantMessages(state) {
  const choices = [...state.choices.values()].sort((left, right) => left.index - right.index)
  return choices.map((choice) => {
    const message = {
      role: 'assistant',
      content: choice.content,
      reasoning_content: choice.reasoning,
    }
    const calls = [...choice.calls.values()]
    if (calls.length) {
      message.tool_calls = calls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments ?? '' },
      }))
    }
    return message
  })
}

function responseFormat(contentType, initialText = '') {
  if (/text\/event-stream/i.test(contentType) || /^data:/m.test(initialText)) return 'sse'
  if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(initialText)) return 'json'
  return 'other'
}

export class OpenAiResponseObserver {
  constructor(contentType = '', options = {}) {
    this.contentType = contentType
    this.format = responseFormat(contentType)
    this.maxJsonBytes = Number.isSafeInteger(options.maxJsonBytes) && options.maxJsonBytes > 0
      ? options.maxJsonBytes
      : 64 * 1024 * 1024
    this.decoder = new TextDecoder()
    this.state = responseState()
    this.textBuffer = ''
    this.textBufferBytes = 0
    this.sseLineBuffer = ''
    this.sseDataLines = []
    this.observedBytes = 0
    this.observationTruncated = false
  }

  push(chunk) {
    const bytes = Buffer.from(chunk)
    this.observedBytes += bytes.length
    const text = this.decoder.decode(bytes, { stream: true })
    if (this.format === 'sse') {
      this.#pushSseText(text)
      return
    }
    if (this.textBuffer.length === 0 && this.format === 'other') {
      this.format = responseFormat(this.contentType, text)
      if (this.format === 'sse') {
        this.#pushSseText(text)
        return
      }
    }
    const textBytes = Buffer.byteLength(text, 'utf8')
    if (this.textBufferBytes + textBytes <= this.maxJsonBytes) {
      this.textBuffer += text
      this.textBufferBytes += textBytes
    } else {
      this.observationTruncated = true
    }
  }

  #pushSseText(text) {
    this.sseLineBuffer += text
    const lines = this.sseLineBuffer.split(/\r?\n/)
    this.sseLineBuffer = lines.pop() ?? ''
    for (const line of lines) this.#consumeSseLine(line)
  }

  #consumeSseLine(line) {
    if (line === '') {
      this.#dispatchSseEvent()
      return
    }
    if (line.startsWith('data:')) this.sseDataLines.push(line.slice(5).trimStart())
  }

  #dispatchSseEvent() {
    if (this.sseDataLines.length === 0) return
    const data = this.sseDataLines.join('\n').trim()
    this.sseDataLines = []
    if (!data || data === '[DONE]') return
    try {
      accumulatePayload(this.state, JSON.parse(data))
    } catch {
      this.state.parseErrors += 1
    }
  }

  finish(options = {}) {
    const tail = this.decoder.decode()
    if (this.format === 'sse') {
      this.#pushSseText(tail)
      if (this.sseLineBuffer) this.#consumeSseLine(this.sseLineBuffer)
      this.#dispatchSseEvent()
    } else if (!this.observationTruncated) {
      this.textBuffer += tail
      try {
        accumulatePayload(this.state, JSON.parse(this.textBuffer))
      } catch {
        if (this.format !== 'other' || this.textBuffer.length > 0) this.state.parseErrors += 1
      }
    }
    return finishResponseState(this.state, this.format, {
      ...options,
      observationTruncated: this.observationTruncated,
    })
  }

  assembledMessages() {
    return assembledAssistantMessages(this.state)
  }
}

export function summarizeResponseBody(text, contentType = '', options = {}) {
  const observer = new OpenAiResponseObserver(contentType, {
    maxJsonBytes: Math.max(Buffer.byteLength(text, 'utf8'), 1),
  })
  observer.push(Buffer.from(text, 'utf8'))
  return observer.finish(options)
}
