import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { accumulateAssistantMessages, DeltaThrottler } from './assistant-stream.mjs'
import { loadAnchorArtifact } from '../gateway/anchor.mjs'
import { normalizeAnchorDisplayName } from '../gateway/anchor-manifest.mjs'
import {
  assertCandidateReportedModels,
  assertSubturnReportedModel,
  attachCandidateSetFingerprint,
  fixtureFingerprint,
  plannedResultsPath,
  validateResultsForFreeze,
} from './anchor-generation-gates.mjs'

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

function reasoningEffort(value = DEFAULT_PROFILE.reasoningEffort) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!['low', 'high', 'max'].includes(normalized)) {
    throw new Error('DEEPSEEK_REASONING_EFFORT must be low, high, or max.')
  }
  return normalized
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
    reasoningEffort: reasoningEffort(environment.DEEPSEEK_REASONING_EFFORT),
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
    reasoningEffort: configuration.reasoningEffort,
    userPrompt: configuration.anchor.task,
  })
  return {
    ...initial,
    messages: structuredClone(messages),
    // Streaming keeps the builder aware of partial output in real time; the
    // usage summary still arrives through the include_usage terminal chunk.
    stream: true,
    stream_options: { include_usage: true },
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

async function requestAssistant(configuration, request, label, onDelta) {
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
  if (!response.body) {
    throw new Error(`${label}: upstream response has no stream body.`)
  }

  const { message, finishReason, usage, model, systemFingerprint } =
    await accumulateAssistantMessages(response.body, {
      onDelta: onDelta ? (phase, text) => onDelta(phase, text) : undefined,
    })
  if (!message || typeof message !== 'object') {
    throw new Error(`${label}: response has no assistant message.`)
  }
  return {
    payload: {
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usage ?? undefined,
      model: model ?? undefined,
      system_fingerprint: systemFingerprint ?? undefined,
    },
    message,
  }
}

async function runCandidate(configuration, candidateIndex) {
  const messages = initialAnchorMessages({
    model: configuration.model,
    maxTokens: configuration.maxTokens,
    userPrompt: configuration.anchor.task,
    reasoningEffort: configuration.reasoningEffort,
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
    requestedModel: configuration.model,
    model: null,
    systemFingerprint: null,
    reportedModels: [],
  }
  let bashCompleted = false

  for (let subturn = 1; subturn <= configuration.maxSubturns; subturn += 1) {
    const request = requestFor(configuration, messages)
    candidate.requestFingerprints.push(fingerprint(request))
    let streamedReasoningChars = 0
    let streamedContentChars = 0
    const emitDelta = (phase, text) => {
      if (phase === 'reasoning') streamedReasoningChars += text.length
      else streamedContentChars += text.length
      process.stdout.write(`${JSON.stringify({
        type: 'delta',
        candidate: candidateIndex,
        subturn,
        phase,
        text,
        reasoningChars: streamedReasoningChars,
        contentChars: streamedContentChars,
      })}\n`)
    }
    const throttler = new DeltaThrottler(emitDelta)
    const { payload, message } = await requestAssistant(
      configuration,
      request,
      `candidate ${candidateIndex} subturn ${subturn}`,
      (phase, text) => throttler.push(phase, text),
    )
    throttler.flush()
    addUsage(candidate.usage, payload.usage)
    const reportedModel = payload.model ?? null
    const reportedFingerprint = payload.system_fingerprint ?? null
    assertSubturnReportedModel(configuration.model, reportedModel)
    candidate.reportedModels.push({
      subturn,
      model: reportedModel,
      systemFingerprint: reportedFingerprint,
    })
    candidate.model = reportedModel ?? candidate.model
    candidate.systemFingerprint =
      reportedFingerprint ?? candidate.systemFingerprint

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
      reportedModel,
      systemFingerprint: reportedFingerprint,
    }
    candidate.assistantTurns.push(turn)
    process.stdout.write(`${JSON.stringify({
      type: 'subturn',
      candidate: candidateIndex,
      subturn,
      firstLine: String(reasoning).trim().split(/\r?\n/, 1)[0] ?? '',
      toolNames: turn.toolNames,
      hasVisibleContent: Boolean(String(turn.content ?? '').trim()),
      finishReason: turn.finishReason,
      usage: candidate.usage,
      totalToolCalls: candidate.toolEvents.length + toolCalls.length,
    })}\n`)

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
  }

  assertCandidateReportedModels(configuration.model, candidate.reportedModels)
  candidate.evaluation = configuration.anchor.openWorkstream
    ? evaluateOpenWorkstreamCandidate(candidate)
    : evaluateAnchorCandidate(candidate)
  return candidate
}

function totalTokensOf(candidate) {
  return Number(candidate?.usage?.totalTokens ?? 0)
}

function selectBestCandidate(candidates, openWorkstream) {
  return candidates
    .filter((candidate) => candidate.evaluation.eligible)
    .sort(
      openWorkstream
        ? (left, right) =>
            totalTokensOf(right) - totalTokensOf(left) ||
            left.candidateIndex - right.candidateIndex
        : (left, right) =>
            left.evaluation.totalToolCalls - right.evaluation.totalToolCalls ||
            totalTokensOf(left) - totalTokensOf(right) ||
            left.candidateIndex - right.candidateIndex,
    )[0]
}

function buildArtifact(configuration, selected, createdAt) {
  const displayName = normalizeAnchorDisplayName(configuration.anchor.displayName)
  const core = {
    schemaVersion: 2,
    kind: 'deepseek-v4-anchor-artifact',
    id: configuration.anchor.id,
    displayName,
    createdAt,
    source: {
      endpoint: configuration.endpoint,
      model: configuration.model,
      modelCapabilities: capabilitiesForModel(configuration.model),
      systemFingerprint: selected.systemFingerprint,
      requestSettings: {
        thinking: structuredClone(DEFAULT_PROFILE.thinking),
        reasoningEffort: configuration.reasoningEffort,
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

function parseFlagValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`)
  }
  return value
}

export async function freezeFromResults(resultsPath, candidateArgument, plannedArtifactPath) {
  const stored = JSON.parse(await readFile(resolve(resultsPath), 'utf8'))
  if (!stored || !Array.isArray(stored.candidates) || stored.candidates.length === 0) {
    throw new Error(`Results file has no candidates: ${resultsPath}`)
  }
  const candidateIndex = Number.parseInt(candidateArgument, 10)
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 1) {
    throw new Error('--candidate must be a positive integer candidate index.')
  }
  const selected = stored.candidates.find(
    (candidate) => candidate.candidateIndex === candidateIndex,
  )
  if (!selected) {
    throw new Error(
      `Candidate ${candidateIndex} was not found in ${resultsPath}. Available: ${stored.candidates.map((candidate) => candidate.candidateIndex).join(', ')}.`,
    )
  }
  validateResultsForFreeze(stored, selected, {
    expectedModel: process.env.DEEPSEEK_MODEL?.trim() || stored.requestedModel || stored.model,
    expectedFixtureId: process.env.ANCHOR_EXPECTED_FIXTURE_ID?.trim() || undefined,
    expectedFixtureFingerprint: process.env.ANCHOR_EXPECTED_FIXTURE_FINGERPRINT?.trim() || undefined,
    expectedCandidateSetFingerprint: process.env.ANCHOR_EXPECTED_CANDIDATE_SET_FINGERPRINT?.trim() || undefined,
  })
  const openWorkstream = Boolean(stored.anchor?.openWorkstream)
  const anchor = anchorSpec(openWorkstream)
  anchor.task = String(stored.anchor?.task ?? anchor.task).trim() || anchor.task
  const configuration = {
    apiKey: null,
    baseUrl: stored.endpoint,
    endpoint: stored.endpoint,
    model: stored.requestedModel ?? stored.model,
    runs: stored.candidates.length,
    maxSubturns: 0,
    timeoutMs: 0,
    maxTokens: positiveInteger(stored.anchor?.maxTokens, DEFAULT_PROFILE.maxTokens, 'anchor.maxTokens'),
    reasoningEffort: reasoningEffort(stored.anchor?.reasoningEffort),
    anchor,
  }
  anchor.continuationMessage = String(
    stored.anchor?.continuationMessage ?? anchor.continuationMessage ?? '',
  ).trim() || null
  anchor.displayName = normalizeAnchorDisplayName(process.env.ANCHOR_DISPLAY_NAME)
  const configuredId = process.env.ANCHOR_ARTIFACT_ID?.trim()
  if (configuredId) anchor.id = configuredId
  const artifact = buildArtifact(configuration, selected, new Date().toISOString())
  await mkdir(dirname(plannedArtifactPath), { recursive: true })
  await writeFile(plannedArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  const loaded = await loadAnchorArtifact(plannedArtifactPath)
  if (configuredId && loaded.id !== configuredId) {
    throw new Error(
      `Frozen artifact id ${loaded.id} does not match ANCHOR_ARTIFACT_ID ${configuredId}.`,
    )
  }
  if (loaded.artifact.displayName !== anchor.displayName) {
    throw new Error('Frozen artifact displayName does not match ANCHOR_DISPLAY_NAME.')
  }
  process.stdout.write(`${JSON.stringify({
    type: 'frozen',
    paidRequestsSent: 0,
    frozenFromResults: resolve(resultsPath),
    selectedCandidate: selected.candidateIndex,
    frozenArtifact: plannedArtifactPath,
    artifactId: artifact.id,
    artifactFingerprint: artifact.artifactFingerprint,
  })}\n`)
}

async function main() {
  const fromResults = parseFlagValue(process.argv, '--from-results')
  if (fromResults) {
    const candidateArgument = parseFlagValue(process.argv, '--candidate')
    if (!candidateArgument) throw new Error('--from-results requires --candidate.')
    const freezeArtifactId = process.env.ANCHOR_ARTIFACT_ID?.trim()
    if (freezeArtifactId && !/^[a-z0-9][a-z0-9._-]*$/i.test(freezeArtifactId)) {
      throw new Error('ANCHOR_ARTIFACT_ID may contain only letters, digits, dot, underscore, and hyphen.')
    }
    const freezePath = process.env.ANCHOR_OUTPUT_PATH?.trim() ||
      (freezeArtifactId ? resolve('anchors', `${freezeArtifactId}.json`) : null)
    if (!freezePath) {
      throw new Error('--from-results requires ANCHOR_OUTPUT_PATH or ANCHOR_ARTIFACT_ID.')
    }
    const freezeArtifactPath = resolve(freezePath)
    if (await pathExists(freezeArtifactPath)) {
      throw new Error(
        `Refusing to overwrite immutable anchor: ${freezeArtifactPath}`,
      )
    }
    await freezeFromResults(fromResults, candidateArgument, freezeArtifactPath)
    return
  }

  const configuration = configurationFromEnvironment()
  configuration.anchor = anchorSpec(process.argv.includes('--open-workstream'))
  const configuredUserPrompt = process.env.ANCHOR_USER_PROMPT?.trim()
  if (configuredUserPrompt) configuration.anchor.task = configuredUserPrompt
  if (process.env.ANCHOR_CONTINUATION_MESSAGE !== undefined) {
    configuration.anchor.continuationMessage =
      process.env.ANCHOR_CONTINUATION_MESSAGE.trim() || null
  }
  if (process.env.ANCHOR_DISPLAY_NAME !== undefined) {
    configuration.anchor.displayName = normalizeAnchorDisplayName(
      process.env.ANCHOR_DISPLAY_NAME,
    )
  }
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
      reasoningEffort: configuration.reasoningEffort,
      userPrompt: configuration.anchor.task,
    })
    const resultsPath = resolve(plannedResultsPath(configuration))
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      paidRequestsSent: 0,
      model: configuration.model,
      fixtureId: configuration.anchor.fixture.fixtureId ?? null,
      fixtureFingerprint: configuration.anchor.fixture.fingerprint
        ?? fixtureFingerprint(configuration.anchor.fixture),
      resultsPath,
      maximumUpstreamCalls: configuration.runs * configuration.maxSubturns,
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
      type: 'candidate',
      candidate: index,
      eligible: candidate.evaluation.eligible,
      eligibilityBasis: candidate.evaluation.eligibilityBasis,
      checks: candidate.evaluation.checks,
      observations: candidate.evaluation.observations,
      letMeTotal: candidate.evaluation.letMeTotal,
      acceptedToolSequence: candidate.evaluation.acceptedToolSequence,
      totalToolCalls: candidate.evaluation.totalToolCalls,
      usage: candidate.usage,
    })}\n`)
  }

  const createdAt = new Date().toISOString()
  const selected = selectBestCandidate(
    candidates,
    configuration.anchor.openWorkstream,
  )
  const result = attachCandidateSetFingerprint({
    schemaVersion: 1,
    experiment: configuration.anchor.experiment,
    createdAt,
    endpoint: configuration.endpoint,
    requestedModel: configuration.model,
    model: configuration.model,
    fixtureId: configuration.anchor.fixture.fixtureId ?? null,
    fixtureFingerprint: configuration.anchor.fixture.fingerprint
      ?? fixtureFingerprint(configuration.anchor.fixture),
    anchorId: configuration.anchor.id,
    anchor: {
      task: configuration.anchor.task,
      openWorkstream: configuration.anchor.openWorkstream,
      maxTokens: configuration.maxTokens,
      reasoningEffort: configuration.reasoningEffort,
      continuationMessage: configuration.anchor.continuationMessage,
      fixtureId: configuration.anchor.fixture.fixtureId ?? null,
      fixtureFingerprint: configuration.anchor.fixture.fingerprint
        ?? fixtureFingerprint(configuration.anchor.fixture),
      tools: toolsForArm(ARM_NAMES.dshMinimal),
    },
    selectedCandidate: selected?.candidateIndex ?? null,
    candidates,
  })

  await mkdir(resolve('results'), { recursive: true })
  const timestamp = createdAt.replaceAll(':', '-')
  const resultPath = resolve(
    process.env.ANCHOR_RESULTS_PATH?.trim() ||
      resolve('results', `anchor-candidates-${timestamp}.json`),
  )
  await mkdir(dirname(resultPath), { recursive: true })
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
    type: 'done',
    savedResults: resultPath,
    eligibleCandidates: candidates.filter(
      (candidate) => candidate.evaluation.eligible,
    ).length,
    selectedCandidate: selected?.candidateIndex ?? null,
    frozenArtifact: artifactPath,
    artifactFingerprint,
  })}\n`)
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
