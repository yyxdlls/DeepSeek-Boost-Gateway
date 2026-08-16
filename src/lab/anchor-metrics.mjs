import { createHash } from 'node:crypto'

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor((ordered.length - 1) * fraction)]
}

function textLength(value) {
  return typeof value === 'string' ? value.length : 0
}

function toolCallsFrom(messages) {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? [])
}

function computedArtifactFingerprint(artifact) {
  const core = structuredClone(artifact)
  delete core.artifactFingerprint
  return createHash('sha256').update(JSON.stringify(core)).digest('hex')
}

export function measureAnchorArtifact(artifact, serialized = null) {
  if (!artifact || typeof artifact !== 'object') {
    throw new TypeError('Anchor artifact must be an object.')
  }
  const messages = artifact.trajectory?.messages
  const bootstrapTools = artifact.bootstrap?.tools
  if (!Array.isArray(messages) || !Array.isArray(bootstrapTools)) {
    throw new TypeError(
      'Anchor artifact must contain trajectory.messages and bootstrap.tools arrays.',
    )
  }

  const compactArtifactJson = JSON.stringify(artifact)
  const artifactFileText = serialized ?? compactArtifactJson
  const historyJson = JSON.stringify(messages)
  const bootstrapToolsJson = JSON.stringify(bootstrapTools)
  const canonicalBundleJson = JSON.stringify({
    messages,
    bootstrapTools,
  })
  const assistantMessages = messages.filter(
    (message) => message.role === 'assistant',
  )
  const toolResults = messages.filter((message) => message.role === 'tool')
  const toolCalls = toolCallsFrom(messages)
  const reasoningLengths = assistantMessages.map((message) =>
    textLength(message.reasoning_content),
  )
  const toolCallArgumentLengths = toolCalls.map((call) =>
    textLength(call.function?.arguments),
  )
  const roleContentChars = Object.fromEntries(
    ['system', 'user', 'assistant', 'tool'].map((role) => [
      role,
      messages
        .filter((message) => message.role === role)
        .reduce((sum, message) => sum + textLength(message.content), 0),
    ]),
  )
  const subturns = assistantMessages.map((message, index) => {
    const calls = message.tool_calls ?? []
    const callIds = new Set(calls.map((call) => call.id))
    const matchingResults = toolResults.filter((result) =>
      callIds.has(result.tool_call_id),
    )
    return {
      subturn: index + 1,
      reasoningChars: textLength(message.reasoning_content),
      visibleChars: textLength(message.content),
      toolCallNames: calls
        .map((call) => call.function?.name)
        .filter(Boolean),
      toolArgumentChars: calls.reduce(
        (sum, call) => sum + textLength(call.function?.arguments),
        0,
      ),
      toolResultChars: matchingResults.reduce(
        (sum, result) => sum + textLength(result.content),
        0,
      ),
    }
  })
  const computedFingerprint = computedArtifactFingerprint(artifact)
  const storedFingerprint = artifact.artifactFingerprint ?? null

  return {
    schemaVersion: 1,
    anchorId: artifact.id ?? null,
    integrity: {
      storedFingerprint,
      computedFingerprint,
      matches:
        typeof storedFingerprint === 'string' &&
        storedFingerprint === computedFingerprint,
    },
    file: {
      formattedJsonChars: artifactFileText.length,
      formattedJsonBytes: utf8Bytes(artifactFileText),
      compactJsonChars: compactArtifactJson.length,
      compactJsonBytes: utf8Bytes(compactArtifactJson),
    },
    replayBundle: {
      historyMessagesJsonChars: historyJson.length,
      historyMessagesJsonBytes: utf8Bytes(historyJson),
      bootstrapToolsJsonChars: bootstrapToolsJson.length,
      bootstrapToolsJsonBytes: utf8Bytes(bootstrapToolsJson),
      canonicalBundleJsonChars: canonicalBundleJson.length,
      canonicalBundleJsonBytes: utf8Bytes(canonicalBundleJson),
      exactProviderReplayTokens: null,
      tokenCountStatus:
        'not-measured: exact replay tokens depend on the provider tokenizer and the current request tool catalog',
    },
    trajectory: {
      messages: messages.length,
      assistantSubturns: assistantMessages.length,
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
      distinctTools: [
        ...new Set(
          toolCalls
            .map((call) => call.function?.name)
            .filter(Boolean),
        ),
      ],
      reasoningChars: reasoningLengths.reduce(
        (sum, length) => sum + length,
        0,
      ),
      reasoningBlockChars: {
        min: reasoningLengths.length ? Math.min(...reasoningLengths) : 0,
        p50: percentile(reasoningLengths, 0.5),
        p90: percentile(reasoningLengths, 0.9),
        max: reasoningLengths.length ? Math.max(...reasoningLengths) : 0,
      },
      visibleAssistantChars: roleContentChars.assistant,
      toolResultChars: roleContentChars.tool,
      toolArgumentChars: toolCallArgumentLengths.reduce(
        (sum, length) => sum + length,
        0,
      ),
      roleContentChars,
      subturns,
    },
    providerReportedBuildUsage: structuredClone(
      artifact.trajectory?.usage ?? null,
    ),
    interpretation: {
      providerReportedBuildUsageIsReplayLength: false,
      note:
        'Build usage is cumulative across the requests that generated the anchor; use replayBundle for exact byte/character size and a provider measurement for exact replay tokens.',
    },
  }
}
