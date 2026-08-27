import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { loadAnchorArtifact } from './anchor.mjs'
import { scanAnchorArtifacts } from './anchor-catalog.mjs'
import {
  comparableAnchorDisplayName,
  nameReservationKey,
  normalizeAnchorDisplayName,
} from './anchor-manifest.mjs'
import { cotStyleFromCounts, openingPreview } from './trajectory-stats.mjs'
import {
  OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
} from '../lab/anchor-profile.mjs'
import {
  buildBuilderEnv,
  redactBuilderText,
  resolveCanonicalDefaultStart,
} from '../lab/anchor-generation-gates.mjs'

const BUILDER_PATH = fileURLToPath(new URL('../lab/run-anchor-candidate.mjs', import.meta.url))

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
}

function jobError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function firstLine(value, maxLength = 120) {
  const text = String(value ?? '').trim().split(/\r?\n/, 1)[0] ?? ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function reasoningEffort(value = 'max') {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!['low', 'high', 'max'].includes(normalized)) {
    throw new Error('reasoningEffort must be low, high, or max.')
  }
  return normalized
}

function publicJob(job) {
  return {
    id: job.id,
    profile: job.profile,
    model: job.model,
    requestedModel: job.requestedModel ?? job.model,
    preset: job.preset ?? null,
    fixtureId: job.fixtureId ?? null,
    fixtureFingerprint: job.fixtureFingerprint ?? null,
    candidateSetFingerprint: job.candidateSetFingerprint ?? null,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    runs: job.runs,
    maxSubturns: job.maxSubturns,
    maxTokens: job.maxTokens,
    reasoningEffort: job.reasoningEffort,
    continuationChars: job.continuationMessage.length,
    maximumUpstreamCalls: job.runs * job.maxSubturns,
    anchorPromptChars: job.anchorPrompt.length,
    candidateSetId: job.candidateSetId,
    displayName: job.displayName,
    anchorId: job.anchorId,
    artifactPath: job.artifactPath,
    artifactFingerprint: job.artifactFingerprint,
    activated: job.activated,
    resultsPath: job.resultsPath,
    candidates: job.candidates,
    autoSelectedCandidate: job.autoSelectedCandidate,
    selectedCandidate: job.selectedCandidate,
    progress: job.progress,
    live: ['queued', 'running'].includes(job.status) ? job.live ?? null : null,
    error: job.error,
  }
}

const COT_COUNT_PATTERNS = Object.freeze([
  ['imIng', /\bi['\u2019]m\s+[a-z]+ing\b/giu],
  ['imIngZh', /我正在/gu],
  ['weNeed', /\bwe\s+need\b/giu],
  ['weNeedZh', /我们需要/gu],
  ['lets', /\blet['\u2019]s\b/giu],
  ['letsZh', /让我们/gu],
  ['letMe', /\blet\s+me\b/giu],
  ['letMeZh', /让我(?!们)/gu],
])

function cotMarkerCounts(assistantTurns) {
  const counts = Object.fromEntries(COT_COUNT_PATTERNS.map(([id]) => [id, 0]))
  for (const turn of assistantTurns) {
    const text = String(turn?.reasoning ?? '')
    if (!text) continue
    for (const [id, pattern] of COT_COUNT_PATTERNS) {
      pattern.lastIndex = 0
      counts[id] += [...text.matchAll(pattern)].length
    }
  }
  return counts
}

function firstReasoningPreview(assistantTurns) {
  for (const turn of assistantTurns) {
    const text = String(turn?.reasoning ?? '').trim()
    if (text) return openingPreview(text)
  }
  return '—'
}

function candidateSummary(candidate) {
  const turns = candidate.assistantTurns ?? []
  const evaluation = candidate.evaluation ?? {}
  const markers = cotMarkerCounts(turns)
  const calledTools = new Set(turns.flatMap((turn) => turn.toolNames ?? []))
  return {
    candidateIndex: candidate.candidateIndex,
    eligible: evaluation.eligible === true,
    eligibilityBasis: evaluation.eligibilityBasis ?? null,
    stopReason: candidate.stopReason ?? null,
    reasoningChars: turns.reduce(
      (sum, turn) => sum + String(turn.reasoning ?? '').length, 0,
    ),
    contentChars: turns.reduce(
      (sum, turn) => sum + String(turn.content ?? '').length, 0,
    ),
    finalAnswerChars: String(candidate.finalAnswer ?? '').length,
    completed: candidate.stopReason === 'final-answer' && String(candidate.finalAnswer ?? '').trim().length > 0,
    toolStatus: {
      bash: calledTools.has('bash'),
      strReplaceEditor: calledTools.has('str_replace_editor'),
    },
    totalToolCalls: Number(evaluation.totalToolCalls ?? 0),
    acceptedToolSequence: evaluation.acceptedToolSequence ?? [],
    letMeTotal: Number(evaluation.letMeTotal ?? 0),
    markers,
    cot: cotStyleFromCounts(markers),
    openingPreview: firstReasoningPreview(turns),
    checks: evaluation.checks ?? null,
    observations: evaluation.observations ?? null,
    usage: candidate.usage ?? null,
    turns: turns.map((turn) => ({
      subturn: turn.subturn,
      toolNames: turn.toolNames ?? [],
      finishReason: turn.finishReason ?? null,
      reasoningFirstLine: firstLine(turn.reasoning),
      contentFirstLine: firstLine(turn.content),
    })),
  }
}

function recommendedCandidate(summaries) {
  const preferred = summaries.filter(
    (summary) => summary.eligible && summary.cot?.label === 'minimal',
  )
  if (!preferred.length) return null
  return preferred
    .sort(
      (left, right) =>
        Number(right.cot?.counts?.collective ?? 0) - Number(left.cot?.counts?.collective ?? 0) ||
        Number(left.cot?.counts?.interruptive ?? 0) - Number(right.cot?.counts?.interruptive ?? 0) ||
        Number(right.usage?.totalTokens ?? 0) - Number(left.usage?.totalTokens ?? 0) ||
        left.candidateIndex - right.candidateIndex,
    )[0].candidateIndex
}

async function loadCandidatesFromResults(job) {
  const stored = JSON.parse(await readFile(job.resultsPath, 'utf8'))
  if (!stored || !Array.isArray(stored.candidates)) {
    throw new Error(`Anchor builder results are malformed: ${job.resultsPath}`)
  }
  const candidates = stored.candidates.map(candidateSummary)
  if (!candidates.length) {
    throw new Error(`Anchor builder produced no candidates: ${job.resultsPath}`)
  }
  return {
    candidates,
    autoSelectedCandidate: recommendedCandidate(candidates),
    fixtureId: stored.fixtureId ?? stored.anchor?.fixtureId ?? null,
    fixtureFingerprint: stored.fixtureFingerprint ?? stored.anchor?.fixtureFingerprint ?? null,
    candidateSetFingerprint: stored.candidateSetFingerprint ?? null,
    requestedModel: stored.requestedModel ?? stored.model ?? job.model,
  }
}

const PROGRESS_EVENT_LIMIT = 120
const PROGRESS_TAIL_CHARS = 12_000
const LIVE_TAIL_CHARS = 6_000

// Live state tracks the currently streaming turn so the WebUI can display a
// streaming output dialog. Completed sub-turns are retained as short first-line
// previews; the full transcript is only read from the results file on demand.
const emptyLive = (candidate, subturn) => ({
  candidate,
  subturn,
  phase: null,
  reasoningChars: 0,
  contentChars: 0,
  reasoningTail: '',
  contentTail: '',
  completed: [],
  usage: null,
  totalToolCalls: 0,
  updatedAt: new Date().toISOString(),
})

function updateLiveTail(target, text) {
  return `${target}${text}`.slice(-LIVE_TAIL_CHARS)
}

function recordBuilderLine(job, line) {
  const trimmed = line.trim()
  if (!trimmed) return
  job.progressTail = `${job.progressTail}${trimmed}\n`.slice(-PROGRESS_TAIL_CHARS)
  try {
    const event = JSON.parse(trimmed)
    if (event && typeof event === 'object' && typeof event.type === 'string') {
      if (event.type === 'subturn') {
        if (!job.live || job.live.candidate !== event.candidate) {
          job.live = emptyLive(event.candidate, event.subturn)
        }
        job.live.subturn = event.subturn
        job.live.phase = null
        job.live.usage = event.usage ?? null
        job.live.totalToolCalls = event.totalToolCalls ?? job.live.totalToolCalls
        job.live.completed.push({
          subturn: event.subturn,
          firstLine: event.firstLine ?? '',
          toolNames: event.toolNames ?? [],
          finishReason: event.finishReason ?? null,
        })
        if (job.live.completed.length > 24) {
          job.live.completed.splice(0, job.live.completed.length - 24)
        }
        job.live.updatedAt = new Date().toISOString()
        pushProgress(job, event)
        return
      }
      if (event.type === 'candidate') {
        // A candidate finished; reset live so the next delta starts fresh.
        const priorLive = job.live
        job.live = event.candidate === priorLive?.candidate ? emptyLive(event.candidate, 0) : null
        pushProgress(job, event)
        return
      }
      if (event.type === 'delta') {
        if (!job.live || job.live.candidate !== event.candidate) {
          job.live = emptyLive(event.candidate, event.subturn)
        } else if (job.live.subturn !== event.subturn) {
          const previous = job.live
          job.live = {
            ...emptyLive(event.candidate, event.subturn),
            completed: previous.completed,
            usage: previous.usage,
            totalToolCalls: previous.totalToolCalls,
          }
        }
        job.live.subturn = event.subturn
        job.live.phase = event.phase
        job.live.updatedAt = new Date().toISOString()
        if (event.phase === 'reasoning') {
          job.live.reasoningChars = event.reasoningChars ?? job.live.reasoningChars
          job.live.reasoningTail = updateLiveTail(job.live.reasoningTail, event.text ?? '')
        } else if (event.phase === 'content') {
          job.live.contentChars = event.contentChars ?? job.live.contentChars
          job.live.contentTail = updateLiveTail(job.live.contentTail, event.text ?? '')
        }
        return
      }
      pushProgress(job, event)
      return
    }
  } catch {
    // Non-JSON builder output stays visible through progressTail only.
  }
}

function pushProgress(job, event) {
  job.progress.push(event)
  if (job.progress.length > PROGRESS_EVENT_LIMIT) {
    job.progress.splice(0, job.progress.length - PROGRESS_EVENT_LIMIT)
  }
}

export function trackBuilderOutput(job, child) {
  if (!child.stdout) return
  child.stdout.on('data', (chunk) => {
    job.outputBuffer = `${job.outputBuffer ?? ''}${chunk}`
    const lines = job.outputBuffer.split(/\r?\n/)
    job.outputBuffer = lines.pop() ?? ''
    for (const line of lines) recordBuilderLine(job, line)
  })
  child.stdout.once('end', () => {
    if (job.outputBuffer) {
      recordBuilderLine(job, job.outputBuffer)
      job.outputBuffer = ''
    }
  })
}

function runBuilder(job, profile, mode = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const freeze = Boolean(mode.fromResults)
    const args = freeze
      ? [
          BUILDER_PATH,
          '--from-results', mode.fromResults,
          '--candidate', String(mode.candidate),
        ]
      : [BUILDER_PATH, '--open-workstream']
    const explicit = freeze
      ? {
          DEEPSEEK_MODEL: job.model,
          ANCHOR_ARTIFACT_ID: job.anchorId,
          ANCHOR_OUTPUT_PATH: job.artifactPath,
          ANCHOR_DISPLAY_NAME: job.displayName,
          ANCHOR_EXPECTED_FIXTURE_ID: job.fixtureId,
          ANCHOR_EXPECTED_FIXTURE_FINGERPRINT: job.fixtureFingerprint,
          ANCHOR_EXPECTED_CANDIDATE_SET_FINGERPRINT: job.candidateSetFingerprint,
        }
      : {
          DEEPSEEK_MODEL: job.model,
          ANCHOR_RUNS: String(job.runs),
          ANCHOR_MAX_SUBTURNS: String(job.maxSubturns),
          ANCHOR_MAX_TOKENS: String(job.maxTokens),
          DEEPSEEK_REASONING_EFFORT: job.reasoningEffort,
          ANCHOR_CONTINUATION_MESSAGE: job.continuationMessage,
          DEEPSEEK_API_KEY: profile.gatewayApiKey,
          DEEPSEEK_BASE_URL: profile.upstreamBaseUrl,
          ANCHOR_RESULTS_PATH: job.resultsPath,
          ANCHOR_USER_PROMPT: job.anchorPrompt,
        }
    const env = buildBuilderEnv(process.env, explicit)
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', freeze ? 'ignore' : 'pipe', 'pipe'],
      env,
    })
    job.child = child
    if (!freeze) trackBuilderOutput(job, child)
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      job.child = null
      if (code === 0) {
        resolvePromise()
        return
      }
      const secret = profile?.gatewayApiKey
      const safeError = redactBuilderText(stderr, [secret, explicit.DEEPSEEK_API_KEY]).trim()
      rejectPromise(new Error(
        safeError || `Anchor builder exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`,
      ))
    })
  })
}

export class AnchorJobManager {
  constructor(options) {
    this.getProfile = options.getProfile
    this.activateAnchor = options.activateAnchor
    this.runBuilder = options.runBuilder ?? runBuilder
    this.loadCandidates = options.loadCandidates ?? loadCandidatesFromResults
    this.getConfigGeneration = options.getConfigGeneration ?? ((name) => {
      const profile = this.getProfile?.(name)
      return Number(profile?.configGeneration ?? 0)
    })
    this.anchorDirectory = options.anchorDirectory ?? resolve('anchors')
    this.jobs = new Map()
    this.runningProfiles = new Set()
    this.nameReservations = new Map()
    this.historyLimit = options.historyLimit ?? 20
  }

  list() {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicJob)
  }

  get(id) {
    const job = this.jobs.get(id)
    return job ? publicJob(job) : null
  }

  start(input = {}) {
    const profileName = String(input.profile ?? '')
    const profile = this.getProfile(profileName)
    if (!profile) throw new Error(`Unknown Gateway profile: ${profileName}`)
    if (!profile.gatewayApiKey) {
      throw new Error(`Gateway profile ${profileName} has no configured API key.`)
    }
    if (this.runningProfiles.has(profileName)) {
      throw new Error(`An Anchor job is already running for ${profileName}.`)
    }

    const id = randomUUID()
    const canonical = resolveCanonicalDefaultStart(input)
    const anchorPrompt = canonical.preset
      ? canonical.anchorPrompt
      : String(input.anchorPrompt ?? '').trim()
    if (!canonical.preset && (anchorPrompt.length < 20 || anchorPrompt.length > 8_000)) {
      throw new Error('anchorPrompt must contain 20 to 8000 characters.')
    }
    const continuationMessage = canonical.preset
      ? canonical.continuationMessage
      : input.continuationMessage === undefined || input.continuationMessage === null
        ? OPEN_WORKSTREAM_CONTINUATION_MESSAGE
        : String(input.continuationMessage)
    if (continuationMessage.length > 4_000) {
      throw new Error('continuationMessage must contain 0 to 4000 characters.')
    }
    const runs = canonical.preset ? canonical.runs : integer(input.runs, 3, 1, 10, 'runs')
    const maxSubturns = canonical.preset
      ? canonical.maxSubturns
      : integer(input.maxSubturns, 6, 3, 12, 'maxSubturns')
    const maxTokens = canonical.preset
      ? canonical.maxTokens
      : integer(input.maxTokens, 384_000, 1, 384_000, 'maxTokens')
    const effort = canonical.preset
      ? canonical.reasoningEffort
      : reasoningEffort(input.reasoningEffort)
    // 参数都合法后再清上一轮待选，避免校验失败误废弃已生成候选。
    this.#abandonPendingForProfile(profileName)
    const job = {
      id,
      profile: profileName,
      model: profile.models[0],
      requestedModel: profile.models[0],
      preset: canonical.preset,
      fixtureId: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId,
      fixtureFingerprint: OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint,
      candidateSetFingerprint: null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      runs,
      maxSubturns,
      maxTokens,
      reasoningEffort: effort,
      continuationMessage,
      anchorPrompt,
      candidateSetId: id,
      displayName: null,
      anchorId: null,
      artifactPath: null,
      artifactFingerprint: null,
      resultsPath: resolve('results', 'anchor-jobs', `${id}.json`),
      configGeneration: this.getConfigGeneration(profileName),
      reservationKey: null,
      activated: false,
      candidates: null,
      autoSelectedCandidate: null,
      selectedCandidate: null,
      progress: [],
      progressTail: '',
      outputBuffer: '',
      live: null,
      error: null,
      child: null,
    }
    this.jobs.set(id, job)
    this.runningProfiles.add(profileName)
    this.#trim()
    void this.#generate(job, profile)
    return publicJob(job)
  }

  select(id, input = {}) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (job.status !== 'awaiting-selection') {
      throw jobError(409, `Anchor job ${id} is not awaiting a candidate selection (status: ${job.status}).`)
    }
    const index = Number(input?.candidate)
    const candidate = job.candidates?.find(
      (item) => item.candidateIndex === index,
    )
    if (!candidate) {
      throw jobError(400, `Candidate ${input?.candidate} is not part of job ${id}.`)
    }
    let displayName
    try {
      displayName = normalizeAnchorDisplayName(input?.displayName)
    } catch (error) {
      const wrapped = jobError(400, error.message)
      wrapped.type = error.type ?? 'gateway_anchor_display_name_invalid'
      throw wrapped
    }
    const activate = input?.activate !== false
    // Atomically leave awaiting-selection before the first await.
    job.status = 'reserving-name'
    job.error = null
    job.selectedCandidate = index
    job.displayName = displayName
    return this.#saveSelected(job, { activate, candidateIndex: index })
  }

  async activate(id) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (!['saved', 'saved-not-activated'].includes(job.status)) {
      throw jobError(409, `Anchor job ${id} cannot be activated (status: ${job.status}).`)
    }
    if (!job.artifactPath) {
      throw jobError(409, 'Anchor job has no saved artifact to activate.')
    }
    if (!(await pathExists(job.artifactPath))) {
      throw jobError(409, `Saved Anchor artifact is missing: ${job.artifactPath}`)
    }
    try {
      await this.activateAnchor(job.profile, job.artifactPath)
      job.activated = true
      job.status = 'succeeded'
      job.error = null
    } catch (error) {
      job.status = 'saved-not-activated'
      job.activated = false
      job.error = error?.message ?? String(error)
      throw jobError(error?.statusCode ?? 409, job.error)
    } finally {
      job.completedAt = new Date().toISOString()
    }
    return publicJob(job)
  }

  discard(id) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (job.status !== 'awaiting-selection') {
      throw jobError(409, `Anchor job ${id} is not awaiting a candidate selection (status: ${job.status}).`)
    }
    this.#abandon(job)
    return publicJob(job)
  }

  #abandon(job) {
    job.status = 'discarded'
    job.completedAt = new Date().toISOString()
    job.error = null
    void rm(job.resultsPath, { force: true }).catch(() => {})
  }

  #abandonPendingForProfile(profileName) {
    for (const job of this.jobs.values()) {
      if (job.profile === profileName && job.status === 'awaiting-selection') {
        this.#abandon(job)
      }
    }
  }

  async getCandidate(id, candidateIndex) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (!job.candidates) {
      throw jobError(409, 'Anchor job has no stored candidates yet.')
    }
    const index = Number(candidateIndex)
    if (!job.candidates.some((item) => item.candidateIndex === index)) {
      throw jobError(400, `Candidate ${candidateIndex} is not part of job ${id}.`)
    }
    const stored = JSON.parse(await readFile(job.resultsPath, 'utf8'))
    const candidate = Array.isArray(stored?.candidates)
      ? stored.candidates.find((item) => item.candidateIndex === index)
      : null
    if (!candidate) {
      throw jobError(410, `Candidate ${index} is no longer stored for job ${id}.`)
    }
    return candidate
  }

  async close() {
    const children = [...this.jobs.values()]
      .map((job) => job.child)
      .filter(Boolean)
    for (const child of children) child.kill()
  }

  async #generate(job, profile) {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    try {
      await this.runBuilder(job, profile)
      const loaded = await this.loadCandidates(job)
      job.candidates = loaded.candidates
      job.autoSelectedCandidate = loaded.autoSelectedCandidate
      if (loaded.fixtureId) job.fixtureId = loaded.fixtureId
      if (loaded.fixtureFingerprint) job.fixtureFingerprint = loaded.fixtureFingerprint
      if (loaded.candidateSetFingerprint) {
        job.candidateSetFingerprint = loaded.candidateSetFingerprint
      }
      if (loaded.requestedModel) job.requestedModel = loaded.requestedModel
      job.status = 'awaiting-selection'
    } catch (error) {
      job.status = 'failed'
      job.error = error?.message ?? String(error)
    } finally {
      job.completedAt = new Date().toISOString()
      this.runningProfiles.delete(job.profile)
    }
  }

  async #saveSelected(job, { activate, candidateIndex }) {
    const reservationKey = nameReservationKey(job.model, job.displayName)
    try {
      const catalog = await scanAnchorArtifacts({ includeControls: true })
      this.#assertNameAvailable(job, catalog, reservationKey)
      this.nameReservations.set(reservationKey, job.id)
      job.reservationKey = reservationKey

      const catalogAgain = await scanAnchorArtifacts({ includeControls: true })
      this.#assertNameAvailable(job, catalogAgain, reservationKey)

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
      job.anchorId = `${job.model}-open-workstream-${timestamp}-${job.id.slice(0, 8)}`
      job.artifactPath = resolve(this.anchorDirectory, `${job.anchorId}.json`)

      await this.runBuilder(job, null, {
        fromResults: job.resultsPath,
        candidate: candidateIndex,
      })

      if (!(await pathExists(job.artifactPath))) {
        throw new Error(`Anchor builder did not create ${job.artifactPath}`)
      }

      const loaded = await loadAnchorArtifact(job.artifactPath)
      if (loaded.id !== job.anchorId) {
        throw new Error(
          `Artifact id ${loaded.id} does not match job identity ${job.anchorId}.`,
        )
      }
      if (basename(job.artifactPath) !== `${job.anchorId}.json`) {
        throw new Error(
          `Artifact file name ${basename(job.artifactPath)} does not match job identity ${job.anchorId}.`,
        )
      }
      if (loaded.artifact.displayName !== job.displayName) {
        throw new Error(
          `Artifact displayName does not match the reserved name for job ${job.id}.`,
        )
      }
      job.artifactFingerprint = loaded.fingerprint
      this.#releaseName(job)

      if (!activate) {
        job.status = 'saved'
        job.activated = false
        return publicJob(job)
      }

      if (this.getConfigGeneration(job.profile) !== job.configGeneration) {
        job.status = 'saved-not-activated'
        job.activated = false
        job.error = 'Profile configuration changed since the job started.'
        throw jobError(409, job.error)
      }

      try {
        await this.activateAnchor(job.profile, job.artifactPath, {
          expectedGeneration: job.configGeneration,
        })
        job.activated = true
        job.status = 'succeeded'
        job.error = null
      } catch (error) {
        job.status = 'saved-not-activated'
        job.activated = false
        job.error = error?.message ?? String(error)
      }
      return publicJob(job)
    } catch (error) {
      const saved = job.artifactPath ? await pathExists(job.artifactPath) : false
      if (!saved) {
        this.#releaseName(job)
        job.anchorId = null
        job.artifactPath = null
        job.artifactFingerprint = null
        job.selectedCandidate = null
        // 落盘前失败必须回到待挑选：候选还在 results 里，不能把整次生成标成
        // failed，否则界面不再渲染候选，等于白烧上游。
        const canReselect = Array.isArray(job.candidates) && job.candidates.length > 0
        job.status = canReselect ? 'awaiting-selection' : 'failed'
      } else {
        this.#releaseName(job)
        job.status = 'saved-not-activated'
      }
      job.error = error?.message ?? String(error)
      if (error?.statusCode) throw error
      throw jobError(saved ? 409 : 500, job.error)
    } finally {
      job.completedAt = new Date().toISOString()
    }
  }

  #assertNameAvailable(job, catalog, reservationKey) {
    const reservedBy = this.nameReservations.get(reservationKey)
    if (reservedBy && reservedBy !== job.id) {
      throw jobError(409, 'Display name is already reserved for this model.')
    }
    const normalized = comparableAnchorDisplayName(job.displayName)
    const taken = catalog.find((artifact) =>
      artifact.model === job.model &&
      comparableAnchorDisplayName(artifact.displayName) === normalized,
    )
    if (taken) {
      throw jobError(409, 'Display name already exists for this model.')
    }
  }

  #releaseName(job) {
    if (!job.reservationKey) return
    if (this.nameReservations.get(job.reservationKey) === job.id) {
      this.nameReservations.delete(job.reservationKey)
    }
    job.reservationKey = null
  }

  #trim() {
    if (this.jobs.size <= this.historyLimit) return
    const removable = [...this.jobs.values()]
      .filter((job) => ![
        'queued',
        'running',
        'awaiting-selection',
        'reserving-name',
        'saved',
        'saved-not-activated',
      ].includes(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    while (this.jobs.size > this.historyLimit && removable.length) {
      this.jobs.delete(removable.shift().id)
    }
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
