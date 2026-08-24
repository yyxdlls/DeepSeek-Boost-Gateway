import { createHash } from 'node:crypto'
import { hasCompleteFinalAssistant } from '../gateway/anchor.mjs'
import {
  evaluateAnchorCandidate,
  evaluateOpenWorkstreamCandidate,
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
} from './anchor-profile.mjs'
import { ARM_NAMES, MODEL_CATALOG, toolsForArm } from './profile.mjs'

export const CANONICAL_DEFAULT_PRESET = 'canonical-default'

export const CANONICAL_DEFAULT_JOB = Object.freeze({
  runs: 3,
  maxSubturns: 6,
  reasoningEffort: 'max',
  maxTokens: 384_000,
})

const CANONICAL_OVERRIDE_KEYS = Object.freeze([
  'anchorPrompt',
  'runs',
  'maxSubturns',
  'maxTokens',
  'reasoningEffort',
  'continuationMessage',
])

const INHERITED_BUILDER_ENV_KEYS = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'LANG',
  'LC_ALL',
  'TZ',
])

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function canonicalFixtureIdentity(fixture = OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY) {
  return {
    fixtureId: fixture.fixtureId,
    root: fixture.root,
    documentPath: fixture.documentPath,
    bashResult: fixture.bashResult,
    readmeResult: fixture.readmeResult,
  }
}

export function fixtureFingerprint(fixture = OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY) {
  return fixture.fingerprint ?? fingerprint(canonicalFixtureIdentity(fixture))
}

export function allowedReportedModels(requestedModel) {
  const entry = MODEL_CATALOG[requestedModel]
  if (!entry) {
    throw new Error(`Unknown official DeepSeek V4 model: ${requestedModel}`)
  }
  return Object.freeze([requestedModel, entry.servedVersion])
}

export function collectReportedModels(candidate) {
  if (Array.isArray(candidate?.reportedModels) && candidate.reportedModels.length) {
    return candidate.reportedModels.map((report) => ({
      subturn: report.subturn,
      model: report.model ?? report.reportedModel ?? null,
      systemFingerprint: report.systemFingerprint ?? null,
    }))
  }
  return (candidate?.assistantTurns ?? []).map((turn) => ({
    subturn: turn.subturn,
    model: turn.reportedModel ?? turn.model ?? null,
    systemFingerprint: turn.systemFingerprint ?? null,
  }))
}

export function assertCandidateReportedModels(requestedModel, reports) {
  const allowed = new Set(allowedReportedModels(requestedModel))
  const seen = []
  for (const report of reports ?? []) {
    const model = report?.model
    if (model === undefined || model === null || model === '') continue
    if (!allowed.has(model)) {
      throw new Error(
        `Reported model ${model} is not ${requestedModel} or ${MODEL_CATALOG[requestedModel].servedVersion}.`,
      )
    }
    if (!seen.includes(model)) seen.push(model)
  }
  if (seen.length === 0) {
    throw new Error(`No reported model was recorded for ${requestedModel}.`)
  }
}

export function assertSubturnReportedModel(requestedModel, reportedModel) {
  if (reportedModel === undefined || reportedModel === null || reportedModel === '') {
    return
  }
  assertCandidateReportedModels(requestedModel, [{ model: reportedModel }])
}

function candidateSetIdentity(stored) {
  const requestedModel = stored.requestedModel ?? stored.model
  return {
    requestedModel,
    fixtureId: stored.fixtureId,
    fixtureFingerprint: stored.fixtureFingerprint,
    task: stored.anchor?.task ?? null,
    tools: stored.anchor?.tools ?? toolsForArm(ARM_NAMES.dshMinimal),
    reasoningEffort: stored.anchor?.reasoningEffort ?? null,
    maxTokens: stored.anchor?.maxTokens ?? null,
    continuationMessage: stored.anchor?.continuationMessage ?? null,
    openWorkstream: stored.anchor?.openWorkstream === true,
    candidates: (stored.candidates ?? []).map((candidate) => ({
      candidateIndex: candidate.candidateIndex,
      requestFingerprints: candidate.requestFingerprints ?? [],
      acceptedToolSequence: candidate.evaluation?.acceptedToolSequence ?? [],
      exactTwoToolCalls: candidate.evaluation?.exactTwoToolCalls
        ?? candidate.evaluation?.checks?.exactTwoToolCalls
        ?? null,
      exactAcceptedSequence: candidate.evaluation?.checks?.exactAcceptedSequence ?? null,
      stopReason: candidate.stopReason ?? null,
      finalAnswer: candidate.finalAnswer ?? '',
      unsafeAttempts: candidate.evaluation?.unsafeAttempts ?? 0,
      reportedModels: collectReportedModels(candidate),
      messagesFingerprint: fingerprint(candidate.messages ?? []),
      assistantTurns: candidate.assistantTurns ?? [],
      toolEvents: candidate.toolEvents ?? [],
    })),
  }
}

export function computeCandidateSetFingerprint(stored) {
  return fingerprint(candidateSetIdentity(stored))
}

export function attachCandidateSetFingerprint(stored) {
  stored.candidateSetFingerprint = computeCandidateSetFingerprint(stored)
  return stored
}

export function validateResultsForFreeze(stored, selected, options = {}) {
  if (!stored || !selected) {
    throw new Error('Results file has no selected candidate.')
  }
  const requestedModel = stored.requestedModel ?? stored.model
  if (!requestedModel) {
    throw new Error('Results are missing requested model.')
  }
  if (options.expectedModel && requestedModel !== options.expectedModel) {
    throw new Error(
      `Results model ${requestedModel} does not match target ${options.expectedModel}.`,
    )
  }
  if (stored.model && stored.model !== requestedModel) {
    throw new Error(
      `Results model field ${stored.model} does not match requested model ${requestedModel}.`,
    )
  }

  const expectedFixtureId = options.expectedFixtureId
    ?? OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId
  const expectedFixtureFingerprint = options.expectedFixtureFingerprint
    ?? OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint
  if (stored.fixtureId !== expectedFixtureId) {
    throw new Error(
      `Fixture id ${stored.fixtureId ?? '(missing)'} does not match ${expectedFixtureId}.`,
    )
  }
  if (stored.fixtureFingerprint !== expectedFixtureFingerprint) {
    throw new Error('Fixture fingerprint mismatch.')
  }

  const expectedSetFingerprint = options.expectedCandidateSetFingerprint
    ?? stored.candidateSetFingerprint
  const computedSetFingerprint = computeCandidateSetFingerprint(stored)
  if (!expectedSetFingerprint || expectedSetFingerprint !== computedSetFingerprint) {
    throw new Error('Candidate-set fingerprint mismatch.')
  }

  if (!hasCompleteFinalAssistant(selected.messages)) {
    throw new Error('Selected candidate is missing a complete final assistant message.')
  }

  const evaluation = stored.anchor?.openWorkstream
    ? evaluateOpenWorkstreamCandidate(selected)
    : evaluateAnchorCandidate(selected)
  if (!evaluation.checks.noUnsafeAttempts) {
    throw new Error('Selected candidate has an unsafe tool attempt.')
  }

  assertCandidateReportedModels(requestedModel, collectReportedModels(selected))
  return {
    requestedModel,
    fixtureId: stored.fixtureId,
    fixtureFingerprint: stored.fixtureFingerprint,
    candidateSetFingerprint: computedSetFingerprint,
    evaluation,
  }
}

export function resolveCanonicalDefaultStart(input = {}) {
  const preset = input.preset === undefined || input.preset === null || input.preset === ''
    ? null
    : String(input.preset)
  if (preset !== CANONICAL_DEFAULT_PRESET) {
    if (preset) {
      throw new Error(`Unknown Anchor job preset: ${preset}.`)
    }
    return { preset: null }
  }
  const overrides = CANONICAL_OVERRIDE_KEYS.filter((key) => (
    Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null
  ))
  if (overrides.length) {
    throw new Error(
      `preset ${CANONICAL_DEFAULT_PRESET} rejects ${overrides.join(', ')}.`,
    )
  }
  return {
    preset: CANONICAL_DEFAULT_PRESET,
    anchorPrompt: OPEN_WORKSTREAM_ANCHOR_TASK,
    runs: CANONICAL_DEFAULT_JOB.runs,
    maxSubturns: CANONICAL_DEFAULT_JOB.maxSubturns,
    maxTokens: CANONICAL_DEFAULT_JOB.maxTokens,
    reasoningEffort: CANONICAL_DEFAULT_JOB.reasoningEffort,
    continuationMessage: OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  }
}

export function buildBuilderEnv(parentEnv, explicit) {
  const env = {}
  const parent = parentEnv ?? {}
  for (const wanted of INHERITED_BUILDER_ENV_KEYS) {
    const found = Object.keys(parent).find((key) => key.toUpperCase() === wanted)
    if (found !== undefined && parent[found] !== undefined) {
      env[found] = parent[found]
    }
  }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined || value === null) continue
    env[key] = String(value)
  }
  return env
}

export function redactBuilderText(text, secrets = []) {
  let safe = String(text ?? '')
  for (const secret of secrets) {
    if (!secret) continue
    safe = safe.replaceAll(String(secret), '[REDACTED]')
  }
  return safe
}

export function plannedResultsPath(configuration, environment = process.env) {
  return environment.ANCHOR_RESULTS_PATH?.trim()
    || `results/anchor-candidates-${configuration.anchor.id}.json`
}
