import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const BUILDER_PATH = fileURLToPath(new URL('../lab/run-anchor-candidate.mjs', import.meta.url))

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return parsed
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
    maximumUpstreamCalls: job.runs * job.maxSubturns,
    anchorId: job.anchorId,
    artifactPath: job.artifactPath,
    activated: job.activated,
    error: job.error,
  }
}

function runBuilder(job, profile) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BUILDER_PATH, '--open-workstream', '--freeze'], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: profile.gatewayApiKey,
        DEEPSEEK_BASE_URL: profile.upstreamBaseUrl,
        DEEPSEEK_MODEL: job.model,
        ANCHOR_RUNS: String(job.runs),
        ANCHOR_MAX_SUBTURNS: String(job.maxSubturns),
        ANCHOR_MAX_TOKENS: String(job.maxTokens),
        ANCHOR_ARTIFACT_ID: job.anchorId,
        ANCHOR_OUTPUT_PATH: job.artifactPath,
      },
    })
    job.child = child
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
      const safeError = stderr.replaceAll(profile.gatewayApiKey, '[REDACTED]').trim()
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
      maxSubturns: integer(input.maxSubturns, 6, 2, 12, 'maxSubturns'),
      maxTokens: integer(input.maxTokens, 384_000, 1, 384_000, 'maxTokens'),
      anchorId,
      artifactPath: resolve('anchors', `${anchorId}.json`),
      activated: false,
      error: null,
      child: null,
    }
    this.jobs.set(id, job)
    this.runningProfiles.add(profileName)
    this.#trim()
    void this.#execute(job, profile)
    return publicJob(job)
  }

  async close() {
    const children = [...this.jobs.values()]
      .map((job) => job.child)
      .filter(Boolean)
    for (const child of children) child.kill()
  }

  async #execute(job, profile) {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    try {
      await this.runBuilder(job, profile)
      await this.activateAnchor(job.profile, job.artifactPath)
      job.activated = true
      job.status = 'succeeded'
    } catch (error) {
      job.status = 'failed'
      job.error = error?.message ?? String(error)
    } finally {
      job.completedAt = new Date().toISOString()
      this.runningProfiles.delete(job.profile)
    }
  }

  #trim() {
    if (this.jobs.size <= this.historyLimit) return
    const removable = [...this.jobs.values()]
      .filter((job) => !['queued', 'running'].includes(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    while (this.jobs.size > this.historyLimit && removable.length) {
      this.jobs.delete(removable.shift().id)
    }
  }
}
