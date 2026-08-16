const MARKER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'we', label: 'we', source: 'modeltest trajectory_evidence analyzer', pattern: /\bwe\b/giu }),
  Object.freeze({ id: 'letMe', label: 'let me', source: 'modeltest trajectory_evidence analyzer', pattern: /\blet\s+me\b/giu }),
  Object.freeze({ id: 'lets', label: "let's", source: 'modeltest trajectory_evidence analyzer', pattern: /\blet['\u2019]s\b/giu }),
  Object.freeze({ id: 'i', label: 'i', source: 'modeltest trajectory_evidence analyzer', pattern: /\bi\b/giu }),
  Object.freeze({ id: 'weNeed', label: 'We need', source: 'dsh-anchored-standard first-line signature', pattern: /\bwe\s+need\b/giu }),
  Object.freeze({ id: 'theUserWants', label: 'The user wants', source: 'observed DSH Standard trajectory', pattern: /\bthe\s+user\s+wants\b/giu }),
  Object.freeze({ id: 'iNeed', label: 'I need', source: 'trajectory classifier control signature', pattern: /\bi\s+need\b/giu }),
  Object.freeze({ id: 'iShould', label: 'I should', source: 'trajectory classifier control signature', pattern: /\bi\s+should\b/giu }),
  Object.freeze({ id: 'iWill', label: 'I will', source: 'trajectory classifier control signature', pattern: /\bi\s+will\b/giu }),
  Object.freeze({ id: 'iAm', label: 'I am', source: 'gray-test observation', pattern: /\bi\s+am\b/giu }),
  Object.freeze({ id: 'im', label: "I'm", source: 'gray-test observation', pattern: /\bi['\u2019]m\b/giu }),
  Object.freeze({ id: 'iApostropheAm', label: "I'am", source: 'gray-test observation', pattern: /\bi['\u2019]am\b/giu }),
])

export const TRAJECTORY_MARKER_PROFILE = Object.freeze({
  id: 'deepseek-trajectory-markers-v1',
  diagnosticOnly: true,
  matching: 'case-insensitive English phrase boundaries; internal whitespace may vary; apostrophe variants are explicit',
  referenceAnalyzer: 'xiaobright/modeltest evaluator/trajectory_evidence/analyze_trajectory_exports.py',
  blockStats: ['chars', 'utf8Bytes', 'min', 'p50', 'p90', 'max'],
  openingMarkers: ['good', 'great', 'excellent'],
  markers: MARKER_DEFINITIONS.map(({ id, label, source }) => ({ id, label, source })),
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
  if (/^let\s+me\b/iu.test(trimmed)) return 'let-me'
  if (/^the\s+user\s+wants\b/iu.test(trimmed)) return 'the-user-wants'
  if (/^i\s+need\b/iu.test(trimmed)) return 'i-need'
  if (/^i\s+should\b/iu.test(trimmed)) return 'i-should'
  if (/^i\s+will\b/iu.test(trimmed)) return 'i-will'
  if (/^i\s+am\b/iu.test(trimmed)) return 'i-am'
  if (/^i['\u2019]m\b/iu.test(trimmed)) return 'im'
  if (/^i['\u2019]am\b/iu.test(trimmed)) return 'i-apostrophe-am'
  const marker = trimmed.match(/^(good|great|excellent)\.(?:\s|$)/iu)
  if (marker) return `marker-${marker[1].toLowerCase()}`
  return 'other'
}

function openingPreview(text) {
  const trimmed = text.trimStart().replace(/\s+/gu, ' ')
  if (!trimmed) return ''
  if (/^\p{Script=Han}/u.test(trimmed)) return [...trimmed].slice(0, 4).join('')
  return trimmed.split(' ').slice(0, 4).join(' ')
}

function trajectoryLabel(text, markers, opening) {
  let score = 0
  if (opening === 'we-need') score += 3
  if (['let-me', 'the-user-wants', 'i-need', 'i-should', 'i-will', 'i-am', 'im', 'i-apostrophe-am'].includes(opening)) score -= 3
  if (markers.weNeed > 0 && markers.letMe === 0) score += 2
  if (markers.letMe > 0) score -= 2
  return {
    label: score >= 4 ? 'minimal-like' : score <= -4 ? 'standard-like' : 'ambiguous',
    score,
    diagnosticOnly: true,
  }
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
    markerProfile: TRAJECTORY_MARKER_PROFILE.id,
    markers,
    openingStyle: opening,
    openingPreview: openingPreview(primaryText),
    trajectory: trajectoryLabel(primaryText, markers, opening),
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

export function summarizeCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') return null

  let hitTokens = firstNumber(
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
  )
  let missTokens = firstNumber(
    usage.prompt_cache_miss_tokens,
  )
  const promptTokens = firstNumber(usage.prompt_tokens, usage.input_tokens)

  if (hitTokens === null && missTokens === null) return null
  if (hitTokens === null && promptTokens !== null && missTokens !== null) {
    hitTokens = Math.max(0, promptTokens - missTokens)
  }
  if (missTokens === null && promptTokens !== null && hitTokens !== null) {
    missTokens = Math.max(0, promptTokens - hitTokens)
  }
  if (hitTokens === null) hitTokens = 0
  if (missTokens === null) {
    missTokens = firstNumber(usage.input_tokens, usage.cache_creation_input_tokens) ?? 0
  }

  const totalTokens = hitTokens + missTokens
  return {
    hitTokens,
    missTokens,
    totalTokens,
    hitRate: totalTokens > 0 ? hitTokens / totalTokens : null,
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
      choice.calls.set(key, { id: call?.id ?? null, name: '', argumentsChars: 0 })
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
    cache: summarizeCacheUsage(state.usage),
    markerProfile: TRAJECTORY_MARKER_PROFILE.id,
    diagnosticOnly: true,
    reasoningChars: reasoning.chars,
    contentChars: content.chars,
    toolCallCount: calls.length,
    toolCallFragments: state.toolCallFragments,
    toolNames: [...new Set(names)],
  }
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
}

export function summarizeResponseBody(text, contentType = '', options = {}) {
  const observer = new OpenAiResponseObserver(contentType, {
    maxJsonBytes: Math.max(Buffer.byteLength(text, 'utf8'), 1),
  })
  observer.push(Buffer.from(text, 'utf8'))
  return observer.finish(options)
}
