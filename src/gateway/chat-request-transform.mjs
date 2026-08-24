import { applyAnchorToChatRequest } from './anchor.mjs'
import {
  rebuildThirdPartyUserHistory,
  stripInternalMessageFields,
  thirdPartyHistoryFingerprint,
} from './micro-anchor.mjs'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function publicMessages(messages) {
  return Array.isArray(messages) ? messages.map(stripInternalMessageFields) : messages
}

function publicPayload(payload) {
  if (!isRecord(payload)) return payload
  return {
    ...payload,
    messages: publicMessages(payload.messages),
  }
}

export function transformChatCompletionsRequest(payload, options = {}) {
  if (!isRecord(payload)) {
    throw new Error('Chat Completions request must be a JSON object.')
  }
  if (!Array.isArray(payload.messages)) {
    throw new Error('Chat Completions request has no messages array.')
  }

  const mode = options.mode === 'anchor' ? 'anchor' : 'bypass'
  const snapshot = options.microAnchor ?? { enabled: false }
  const clonedPayload = structuredClone(payload)
  const rebuilt = rebuildThirdPartyUserHistory(clonedPayload.messages, snapshot)
  const historyFingerprint = thirdPartyHistoryFingerprint(rebuilt.messages)
  const rebuiltRequest = {
    ...clonedPayload,
    messages: rebuilt.messages,
  }

  let outbound = rebuiltRequest
  let anchorMetrics = null
  let origins = rebuilt.origins

  if (mode === 'anchor') {
    const selectedAnchor = options.anchor
    if (!selectedAnchor) {
      const error = new Error(
        `No Anchor is configured for model ${JSON.stringify(payload.model)}.`,
      )
      error.type = 'gateway_anchor_not_configured'
      throw error
    }
    const transformed = applyAnchorToChatRequest(rebuiltRequest, selectedAnchor)
    outbound = transformed.payload
    anchorMetrics = transformed.metrics
    const conversationCount = rebuilt.messages.filter(
      (message) => message?.role !== 'system' && message?.role !== 'developer',
    ).length
    origins = [
      ...Array.from({ length: transformed.metrics.anchorMessageCount }, () => 'anchor'),
      'bridge',
      ...Array.from({ length: conversationCount }, () => 'third-party'),
    ]
  }

  const sanitized = publicPayload(outbound)
  return {
    payload: sanitized,
    origins,
    metrics: {
      ...(anchorMetrics ?? {}),
      microAnchor: rebuilt.metrics,
      thirdPartyHistoryFingerprint: historyFingerprint,
    },
  }
}
