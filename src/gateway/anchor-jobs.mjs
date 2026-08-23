import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { cotStyleFromCounts, openingPreview } from './trajectory-stats.mjs'
import { OPEN_WORKSTREAM_CONTINUATION_MESSAGE } from '../lab/anchor-profile.mjs'

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
    anchorId: job.anchorId,
    artifactPath: job.artifactPath,
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
        right.reasoningChars - left.reasoningChars ||
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
  return { candidates, autoSelectedCandidate: recommendedCandidate(candidates) }
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
    const env = {
      ...process.env,
      DEEPSEEK_MODEL: job.model,
      ANCHOR_RUNS: String(job.runs),
      ANCHOR_MAX_SUBTURNS: String(job.maxSubturns),
      ANCHOR_MAX_TOKENS: String(job.maxTokens),
      DEEPSEEK_REASONING_EFFORT: job.reasoningEffort,
      ANCHOR_CONTINUATION_MESSAGE: job.continuationMessage,
      ANCHOR_ARTIFACT_ID: job.anchorId,
      ANCHOR_OUTPUT_PATH: job.artifactPath,
    }
    if (freeze) {
      delete env.DEEPSEEK_API_KEY
      delete env.DEEPSEEK_BASE_URL
      delete env.ANCHOR_USER_PROMPT
      delete env.ANCHOR_RESULTS_PATH
    } else {
      env.DEEPSEEK_API_KEY = profile.gatewayApiKey
      env.DEEPSEEK_BASE_URL = profile.upstreamBaseUrl
      env.ANCHOR_RESULTS_PATH = job.resultsPath
      env.ANCHOR_USER_PROMPT = job.anchorPrompt
    }
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
      const safeError = secret
        ? stderr.replaceAll(secret, '[REDACTED]').trim()
        : stderr.trim()
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
    this.jobs = new Map()
    this.runningProfiles = new Set()
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
    const anchorPrompt = String(input.anchorPrompt ?? '').trim()
    if (anchorPrompt.length < 20 || anchorPrompt.length > 8_000) {
      throw new Error('anchorPrompt must contain 20 to 8000 characters.')
    }
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    const anchorId = `${profile.models[0]}-open-workstream-${timestamp}-${id.slice(0, 8)}`
    const job = {
      id,
      profile: profileName,
      model: profile.models[0],
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      runs: integer(input.runs, 3, 1, 10, 'runs'),
      maxSubturns: integer(input.maxSubturns, 6, 3, 12, 'maxSubturns'),
      maxTokens: integer(input.maxTokens, 384_000, 1, 384_000, 'maxTokens'),
      reasoningEffort: reasoningEffort(input.reasoningEffort),
      continuationMessage: String(
        input.continuationMessage ?? OPEN_WORKSTREAM_CONTINUATION_MESSAGE,
      ).trim(),
      anchorPrompt,
      anchorId,
      artifactPath: resolve('anchors', `${anchorId}.json`),
      resultsPath: resolve('results', 'anchor-jobs', `${id}.json`),
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
    if (!job.continuationMessage || job.continuationMessage.length > 4_000) {
      throw new Error('continuationMessage must contain 1 to 4000 characters.')
    }
    this.jobs.set(id, job)
    this.runningProfiles.add(profileName)
    this.#trim()
    void this.#generate(job, profile)
    return publicJob(job)
  }

  select(id, candidateIndex) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (job.status !== 'awaiting-selection') {
      throw jobError(409, `Anchor job ${id} is not awaiting a candidate selection (status: ${job.status}).`)
    }
    const index = Number(candidateIndex)
    const candidate = job.candidates?.find(
      (item) => item.candidateIndex === index,
    )
    if (!candidate) {
      throw jobError(400, `Candidate ${candidateIndex} is not part of job ${id}.`)
    }
    job.status = 'freezing'
    job.error = null
    void this.#freeze(job, index)
    return publicJob(job)
  }

  discard(id) {
    const job = this.jobs.get(id)
    if (!job) throw jobError(404, 'Anchor job not found.')
    if (job.status !== 'awaiting-selection') {
      throw jobError(409, `Anchor job ${id} is not awaiting a candidate selection (status: ${job.status}).`)
    }
    job.status = 'discarded'
    job.completedAt = new Date().toISOString()
    void rm(job.resultsPath, { force: true }).catch(() => {})
    return publicJob(job)
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
      job.status = 'awaiting-selection'
    } catch (error) {
      job.status = 'failed'
      job.error = error?.message ?? String(error)
    } finally {
      job.completedAt = new Date().toISOString()
      this.runningProfiles.delete(job.profile)
    }
  }

  async #freeze(job, candidateIndex) {
    try {
      await this.runBuilder(job, null, {
        fromResults: job.resultsPath,
        candidate: candidateIndex,
      })
      await this.activateAnchor(job.profile, job.artifactPath)
      job.activated = true
      job.selectedCandidate = candidateIndex
      job.status = 'succeeded'
    } catch (error) {
      job.status = 'failed'
      job.error = error?.message ?? String(error)
    } finally {
      job.completedAt = new Date().toISOString()
    }
  }

  #trim() {
    if (this.jobs.size <= this.historyLimit) return
    const removable = [...this.jobs.values()]
      .filter((job) => !['queued', 'running', 'awaiting-selection', 'freezing'].includes(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    while (this.jobs.size > this.historyLimit && removable.length) {
      this.jobs.delete(removable.shift().id)
    }
  }
}
