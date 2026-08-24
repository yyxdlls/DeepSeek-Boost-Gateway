// Streaming helpers for the anchor builder. accumulateAssistantMessages
// consumes an OpenAI-compatible SSE body (any async iterable of bytes or
// text), reassembles the assistant message (reasoning, content, tool calls
// with fully joined arguments), and reports text deltas for live display.
// DeltaThrottler coalesces those deltas so the builder emits a bounded
// number of progress lines per generated turn.

function textPart(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .join('')
}

function reasoningPart(message) {
  const value = message?.reasoning_content ?? message?.reasoning
  return typeof value === 'string' ? value : ''
}

export class DeltaThrottler {
  constructor(emit, options = {}) {
    this.emit = emit
    this.maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : 200
    this.intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : 400
    this.pending = new Map()
    this.lastFlush = Date.now()
  }

  push(phase, text) {
    if (!text) return
    this.pending.set(phase, (this.pending.get(phase) ?? '') + text)
    const total = [...this.pending.values()].reduce((sum, value) => sum + value.length, 0)
    if (total >= this.maxChars || Date.now() - this.lastFlush >= this.intervalMs) {
      this.flush()
    }
  }

  flush() {
    if (!this.pending.size) return
    for (const [phase, text] of this.pending) this.emit(phase, text)
    this.pending.clear()
    this.lastFlush = Date.now()
  }
}

export async function accumulateAssistantMessages(body, options = {}) {
  const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null
  const decoder = new TextDecoder()
  const state = {
    reasoning: '',
    content: '',
    calls: new Map(),
    nextCallIndex: 0,
    finishReason: null,
    usage: null,
    model: null,
    systemFingerprint: null,
  }

  const consumeChoice = (rawChoice) => {
    const message = rawChoice?.delta ?? rawChoice?.message ?? {}
    const reasoning = reasoningPart(message)
    const content = textPart(message.content)
    if (reasoning) {
      state.reasoning += reasoning
      onDelta?.('reasoning', reasoning)
    }
    if (content) {
      state.content += content
      onDelta?.('content', content)
    }
    for (const call of message.tool_calls ?? []) {
      const key = call?.index !== undefined
        ? `index:${call.index}`
        : call?.id
          ? `id:${call.id}`
          : `position:${state.nextCallIndex++}`
      if (!state.calls.has(key)) {
        state.calls.set(key, { id: call?.id ?? null, name: '', arguments: '' })
      }
      const accumulated = state.calls.get(key)
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
      }
    }
    if (rawChoice?.finish_reason) state.finishReason = rawChoice.finish_reason
  }

  let lineBuffer = ''
  let dataLines = []
  const dispatchEvent = () => {
    if (!dataLines.length) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    if (payload?.usage) state.usage = payload.usage
    if (payload?.model) state.model = payload.model
    if (payload?.system_fingerprint) state.systemFingerprint = payload.system_fingerprint
    for (const [position, choice] of (payload?.choices ?? []).entries()) {
      consumeChoice(choice?.index === undefined ? { ...choice, index: position } : choice)
    }
  }

  const pushText = (text) => {
    lineBuffer += text
    const lines = lineBuffer.split(/\r?\n/)
    lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        dispatchEvent()
        continue
      }
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
  }

  for await (const chunk of body) {
    pushText(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
  }
  pushText(decoder.decode())
  if (lineBuffer) {
    // The provider may end without a trailing newline.
    if (lineBuffer.startsWith('data:')) dataLines.push(lineBuffer.slice(5).trimStart())
    lineBuffer = ''
  }
  dispatchEvent()

  const message = {
    role: 'assistant',
    content: state.content,
    reasoning_content: state.reasoning,
  }
  const calls = [...state.calls.values()]
  if (calls.length) {
    message.tool_calls = calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return {
    message,
    finishReason: state.finishReason,
    usage: state.usage,
    model: state.model,
    systemFingerprint: state.systemFingerprint,
    reasoningChars: state.reasoning.length,
    contentChars: state.content.length,
  }
}
