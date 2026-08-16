import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ANCHOR_ID,
  ANCHOR_TASK,
  OPEN_WORKSTREAM_ANCHOR_ID,
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
  SYNTHETIC_REPOSITORY,
  buildInitialAnchorRequest,
  evaluateAnchorCandidate,
  evaluateOpenWorkstreamCandidate,
  initialAnchorMessages,
  normalizeAssistantMessage,
  syntheticToolResult,
} from './anchor-profile.mjs'
import {
  ARM_NAMES,
  DEFAULT_PROFILE,
  capabilitiesForModel,
  makeChatCompletionsUrl,
  toolsForArm,
} from './profile.mjs'

function anchorSpec(openWorkstream) {
  return openWorkstream
    ? {
        id: OPEN_WORKSTREAM_ANCHOR_ID,
        task: OPEN_WORKSTREAM_ANCHOR_TASK,
        fixture: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
        experiment: 'dsh-minimal-open-workstream-two-tool-anchor-builder',
        continuationMessage: OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
        openWorkstream: true,
      }
    : {
        id: ANCHOR_ID,
        task: ANCHOR_TASK,
        fixture: SYNTHETIC_REPOSITORY,
        experiment: 'dsh-minimal-two-tool-anchor-builder',
        continuationMessage: null,
        openWorkstream: false,
      }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function configurationFromEnvironment(environment = process.env) {
  return {
    apiKey: environment.DEEPSEEK_API_KEY?.trim(),
    baseUrl: environment.DEEPSEEK_BASE_URL?.trim() || DEFAULT_PROFILE.baseUrl,
    model: environment.DEEPSEEK_MODEL?.trim() || DEFAULT_PROFILE.model,
    runs: positiveInteger(environment.ANCHOR_RUNS, 3, 'ANCHOR_RUNS'),
    maxSubturns: positiveInteger(
      environment.ANCHOR_MAX_SUBTURNS,
      6,
      'ANCHOR_MAX_SUBTURNS',
    ),
    timeoutMs: positiveInteger(
      environment.ANCHOR_TIMEOUT_MS,
      300_000,
      'ANCHOR_TIMEOUT_MS',
    ),
    maxTokens: positiveInteger(
      environment.ANCHOR_MAX_TOKENS,
      DEFAULT_PROFILE.maxTokens,
      'ANCHOR_MAX_TOKENS',
    ),
  }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeErrorBody(body, apiKey) {
  const truncated = body.slice(0, 2_000)
  return apiKey ? truncated.replaceAll(apiKey, '[REDACTED]') : truncated
}

function requestFor(configuration, messages) {
  const initial = buildInitialAnchorRequest({
    model: configuration.model,
    maxTokens: configuration.maxTokens,
    userPrompt: configuration.anchor.task,
  })
  return {
    ...initial,
    messages: structuredClone(messages),
  }
}

function addUsage(total, usage) {
  if (!usage) return
  total.promptTokens += usage.prompt_tokens ?? 0
  total.completionTokens += usage.completion_tokens ?? 0
  total.totalTokens += usage.total_tokens ?? 0
  total.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0
  total.cacheHitTokens += usage.prompt_cache_hit_tokens ?? 0
  total.cacheMissTokens += usage.prompt_cache_miss_tokens ?? 0
}

async function requestAssistant(configuration, request, label) {
  const response = await fetch(configuration.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(configuration.timeoutMs),
  })

  if (!response.ok) {
    const body = safeErrorBody(await response.text(), configuration.apiKey)
    throw new Error(`${label}: upstream HTTP ${response.status}: ${body}`)
  }

  const payload = await response.json()
  const message = payload.choices?.[0]?.message
  if (!message || typeof message !== 'object') {
    throw new Error(`${label}: response has no assistant message.`)
  }
  return { payload, message }
}

async function runCandidate(configuration, candidateIndex) {
  const messages = initialAnchorMessages({
    model: configuration.model,
    maxTokens: configuration.maxTokens,
    userPrompt: configuration.anchor.task,
  })
  const candidate = {
    candidateIndex,
    messages,
    assistantTurns: [],
    toolEvents: [],
    requestFingerprints: [],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    },
    finalAnswer: '',
    stopReason: 'turn-limit',
    model: null,
    systemFingerprint: null,
  }
  let bashCompleted = false

  for (let subturn = 1; subturn <= configuration.maxSubturns; subturn += 1) {
    const request = requestFor(configuration, messages)
    candidate.requestFingerprints.push(fingerprint(request))
    const { payload, message } = await requestAssistant(
      configuration,
      request,
      `candidate ${candidateIndex} subturn ${subturn}`,
    )
    addUsage(candidate.usage, payload.usage)
    candidate.model = payload.model ?? candidate.model
    candidate.systemFingerprint =
      payload.system_fingerprint ?? candidate.systemFingerprint

    const normalized = normalizeAssistantMessage(message)
    messages.push(normalized)
    const toolCalls = normalized.tool_calls ?? []
    const reasoning = normalized.reasoning_content ?? ''
    const turn = {
      subturn,
      reasoning,
      content: normalized.content,
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
      toolNames: toolCalls
        .map((call) => call.function?.name)
        .filter(Boolean),
    }
    candidate.assistantTurns.push(turn)
    process.stdout.write(`${JSON.stringify({
      candidate: candidateIndex,
      subturn,
      firstLine: String(reasoning).trim().split(/\r?\n/, 1)[0] ?? '',
      toolNames: turn.toolNames,
      hasVisibleContent: Boolean(String(turn.content ?? '').trim()),
      finishReason: turn.finishReason,
    }, null, 2)}\n`)

    if (toolCalls.length === 0) {
      candidate.finalAnswer = normalized.content
      candidate.stopReason = 'final-answer'
      break
    }

    const stateForSubturn = {
      bashCompletedBeforeSubturn: bashCompleted,
    }
    let bashAcceptedThisSubturn = false
    for (const call of toolCalls) {
      if (!call.id) {
        throw new Error(
          `candidate ${candidateIndex} subturn ${subturn}: tool call has no id.`,
        )
      }
      const result = syntheticToolResult(
        call,
        stateForSubturn,
        subturn,
        configuration.anchor.fixture,
      )
      candidate.toolEvents.push(result.event)
      messages.push(result.message)
      if (result.event.accepted && result.event.name === 'bash') {
        bashAcceptedThisSubturn = true
      }
    }
    if (bashAcceptedThisSubturn) bashCompleted = true
    if (
      configuration.anchor.openWorkstream &&
      candidate.toolEvents.length === 2 &&
      candidate.toolEvents.every((event) => event.accepted) &&
      candidate.toolEvents[0].name === 'bash' &&
      candidate.toolEvents[1].name === 'str_replace_editor'
    ) {
      candidate.stopReason = 'open-after-second-tool-result'
      break
    }
  }

  candidate.evaluation = configuration.anchor.openWorkstream
    ? evaluateOpenWorkstreamCandidate(candidate)
    : evaluateAnchorCandidate(candidate)
  return candidate
}

function reasoningChars(candidate) {
  return candidate.assistantTurns.reduce(
    (sum, turn) => sum + String(turn.reasoning ?? '').length,
    0,
  )
}

function selectBestCandidate(candidates, openWorkstream) {
  return candidates
    .filter((candidate) => candidate.evaluation.eligible)
    .sort(
      openWorkstream
        ? (left, right) =>
            reasoningChars(right) - reasoningChars(left) ||
            left.candidateIndex - right.candidateIndex
        : (left, right) =>
            left.evaluation.totalToolCalls - right.evaluation.totalToolCalls ||
            left.usage.totalTokens - right.usage.totalTokens ||
            left.candidateIndex - right.candidateIndex,
    )[0]
}

function buildArtifact(configuration, selected, createdAt) {
  const core = {
    schemaVersion: 1,
    kind: 'deepseek-v4-anchor-artifact',
    id: configuration.anchor.id,
    createdAt,
    source: {
      endpoint: configuration.endpoint,
      model: configuration.model,
      modelCapabilities: capabilitiesForModel(configuration.model),
      systemFingerprint: selected.systemFingerprint,
      requestSettings: {
        thinking: structuredClone(DEFAULT_PROFILE.thinking),
        reasoningEffort: DEFAULT_PROFILE.reasoningEffort,
        maxTokens: configuration.maxTokens,
      },
    },
    bootstrap: {
      system: DEFAULT_PROFILE.system,
      task: configuration.anchor.task,
      tools: toolsForArm(ARM_NAMES.dshMinimal),
      syntheticRepository: structuredClone(configuration.anchor.fixture),
      executesHostTools: false,
    },
    trajectory: {
      selectedCandidate: selected.candidateIndex,
      messages: selected.messages,
      assistantTurns: selected.assistantTurns,
      toolEvents: selected.toolEvents,
      usage: selected.usage,
    },
    verification: selected.evaluation,
  }
  if (configuration.anchor.continuationMessage) {
    core.continuation = {
      mode: 'same-active-workstream',
      message: configuration.anchor.continuationMessage,
    }
  }
  return {
    ...core,
    artifactFingerprint: fingerprint(core),
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function main() {
  const configuration = configurationFromEnvironment()
  configuration.anchor = anchorSpec(process.argv.includes('--open-workstream'))
  const configuredUserPrompt = process.env.ANCHOR_USER_PROMPT?.trim()
  if (configuredUserPrompt) configuration.anchor.task = configuredUserPrompt
  const configuredArtifactId = process.env.ANCHOR_ARTIFACT_ID?.trim()
  if (configuredArtifactId) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(configuredArtifactId)) {
      throw new Error('ANCHOR_ARTIFACT_ID may contain only letters, digits, dot, underscore, and hyphen.')
    }
    configuration.anchor.id = configuredArtifactId
  }
  configuration.endpoint = makeChatCompletionsUrl(configuration.baseUrl)
  const dryRun = process.argv.includes('--dry-run')
  const freeze = process.argv.includes('--freeze')
  const plannedArtifactPath = resolve(
    process.env.ANCHOR_OUTPUT_PATH?.trim() ||
      resolve('anchors', `${configuration.anchor.id}.json`),
  )
  const targetArtifactPath = freeze ? plannedArtifactPath : null

  if (dryRun) {
    const request = buildInitialAnchorRequest({
      model: configuration.model,
      maxTokens: configuration.maxTokens,
      userPrompt: configuration.anchor.task,
    })
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      paidRequestsSent: 0,
      anchorId: configuration.anchor.id,
      targetArtifactPath: plannedArtifactPath,
      plannedCandidates: configuration.runs,
      maxSubturnsPerCandidate: configuration.maxSubturns,
      modelCapabilities: capabilitiesForModel(configuration.model),
      requestFingerprint: fingerprint(request),
      initialRequest: request,
      syntheticRepository: configuration.anchor.fixture,
      executesHostTools: false,
    }, null, 2)}\n`)
    return
  }

  if (targetArtifactPath && (await pathExists(targetArtifactPath))) {
    throw new Error(
      `Refusing to overwrite immutable anchor before sending any API requests: ${targetArtifactPath}`,
    )
  }

  if (!configuration.apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. On Windows, use .\\scripts\\run-anchor-candidate.ps1 for hidden input.',
    )
  }

  const candidates = []
  for (let index = 1; index <= configuration.runs; index += 1) {
    const candidate = await runCandidate(configuration, index)
    candidates.push(candidate)
    process.stdout.write(`${JSON.stringify({
      candidate: index,
      eligible: candidate.evaluation.eligible,
      eligibilityBasis: candidate.evaluation.eligibilityBasis,
      checks: candidate.evaluation.checks,
      observations: candidate.evaluation.observations,
      letMeTotal: candidate.evaluation.letMeTotal,
      acceptedToolSequence: candidate.evaluation.acceptedToolSequence,
      totalToolCalls: candidate.evaluation.totalToolCalls,
      usage: candidate.usage,
    }, null, 2)}\n`)
  }

  const createdAt = new Date().toISOString()
  const selected = selectBestCandidate(
    candidates,
    configuration.anchor.openWorkstream,
  )
  const result = {
    schemaVersion: 1,
    experiment: configuration.anchor.experiment,
    createdAt,
    endpoint: configuration.endpoint,
    model: configuration.model,
    anchorId: configuration.anchor.id,
    selectedCandidate: selected?.candidateIndex ?? null,
    candidates,
  }

  const resultDirectory = resolve('results')
  await mkdir(resultDirectory, { recursive: true })
  const timestamp = createdAt.replaceAll(':', '-')
  const resultPath = resolve(
    resultDirectory,
    `anchor-candidates-${timestamp}.json`,
  )
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })

  let artifactPath = null
  let artifactFingerprint = null
  if (freeze) {
    if (!selected) {
      throw new Error(
        `No eligible anchor candidate was produced. Raw results: ${resultPath}`,
      )
    }
    const artifact = buildArtifact(configuration, selected, createdAt)
    await mkdir(dirname(targetArtifactPath), { recursive: true })
    artifactPath = targetArtifactPath
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    artifactFingerprint = artifact.artifactFingerprint
  }

  process.stdout.write(`${JSON.stringify({
    savedResults: resultPath,
    eligibleCandidates: candidates.filter(
      (candidate) => candidate.evaluation.eligible,
    ).length,
    selectedCandidate: selected?.candidateIndex ?? null,
    frozenArtifact: artifactPath,
    artifactFingerprint,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
