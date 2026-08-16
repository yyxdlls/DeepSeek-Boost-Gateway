import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { classifyTrajectory, compareArms } from './classifier.mjs'
import {
  ARM_NAMES,
  DEFAULT_PROFILE,
  buildTrajectoryProbeRequest,
  capabilitiesForModel,
  makeChatCompletionsUrl,
  toolsForArm,
} from './profile.mjs'

const ARM_ORDER = Object.freeze([
  ARM_NAMES.standardControl,
  ARM_NAMES.dshMinimal,
])

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
    runsPerArm: positiveInteger(environment.PROBE_RUNS, 3, 'PROBE_RUNS'),
    timeoutMs: positiveInteger(
      environment.PROBE_TIMEOUT_MS,
      300_000,
      'PROBE_TIMEOUT_MS',
    ),
    maxTokens: positiveInteger(
      environment.PROBE_MAX_TOKENS,
      DEFAULT_PROFILE.maxTokens,
      'PROBE_MAX_TOKENS',
    ),
  }
}

function safeErrorBody(body, apiKey) {
  const truncated = body.slice(0, 2_000)
  return apiKey ? truncated.replaceAll(apiKey, '[REDACTED]') : truncated
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requestFor(configuration, arm) {
  return buildTrajectoryProbeRequest({
    arm,
    model: configuration.model,
    maxTokens: configuration.maxTokens,
  })
}

async function runOnce(configuration, arm, armRun, sequence) {
  const request = requestFor(configuration, arm)
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
    throw new Error(
      `${arm} run ${armRun}: upstream HTTP ${response.status}: ${body}`,
    )
  }

  const payload = await response.json()
  const message = payload.choices?.[0]?.message
  if (!message || typeof message !== 'object') {
    throw new Error(`${arm} run ${armRun}: response has no assistant message.`)
  }

  const reasoning = message.reasoning_content ?? message.reasoning ?? ''
  const toolNames = (message.tool_calls ?? [])
    .map((call) => call.function?.name)
    .filter(Boolean)

  return {
    arm,
    armRun,
    sequence,
    requestFingerprint: fingerprint(request),
    classification: classifyTrajectory(
      reasoning,
      Boolean(String(message.content ?? '').trim()),
    ),
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
    toolNames,
    usage: payload.usage ?? null,
    model: payload.model ?? null,
    systemFingerprint: payload.system_fingerprint ?? null,
    rawMessage: message,
  }
}

function dryRunSummary(configuration) {
  const requests = Object.fromEntries(
    ARM_ORDER.map((arm) => {
      const request = requestFor(configuration, arm)
      return [
        arm,
        {
          requestFingerprint: fingerprint(request),
          request,
        },
      ]
    }),
  )

  return {
    dryRun: true,
    paidRequestsSent: 0,
    endpoint: makeChatCompletionsUrl(configuration.baseUrl),
    model: configuration.model,
    modelCapabilities: capabilitiesForModel(configuration.model),
    runsPerArm: configuration.runsPerArm,
    totalPlannedRequests: configuration.runsPerArm * ARM_ORDER.length,
    armOrder: ARM_ORDER,
    requests,
  }
}

async function main() {
  const configuration = configurationFromEnvironment()
  const dryRun = process.argv.includes('--dry-run')
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunSummary(configuration), null, 2)}\n`)
    return
  }

  if (!configuration.apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. On Windows, use .\\scripts\\run-minimal-probe.ps1 for hidden input.',
    )
  }

  configuration.endpoint = makeChatCompletionsUrl(configuration.baseUrl)
  const runs = []
  let sequence = 0

  // Interleave the two arms so a time-varying backend is less likely to bias
  // all observations for one schema in the same direction.
  for (let armRun = 1; armRun <= configuration.runsPerArm; armRun += 1) {
    for (const arm of ARM_ORDER) {
      sequence += 1
      const run = await runOnce(configuration, arm, armRun, sequence)
      runs.push(run)
      process.stdout.write(`${JSON.stringify({
        sequence,
        arm,
        armRun,
        label: run.classification.label,
        firstLine: run.classification.metrics.firstLine,
        letMe: run.classification.metrics.letMe,
        finishReason: run.finishReason,
        toolNames: run.toolNames,
        usage: run.usage,
      }, null, 2)}\n`)
    }
  }

  const runsFor = (arm) => runs.filter((run) => run.arm === arm)
  const result = {
    schemaVersion: 3,
    experiment: 'dsh-minimal-vs-dsh-standard-control',
    createdAt: new Date().toISOString(),
    endpoint: configuration.endpoint,
    model: configuration.model,
    modelCapabilities: capabilitiesForModel(configuration.model),
    system: DEFAULT_PROFILE.system,
    userPrompt: DEFAULT_PROFILE.userPrompt,
    arms: Object.fromEntries(
      ARM_ORDER.map((arm) => [
        arm,
        {
          tools: toolsForArm(arm),
          toolSchemaFingerprint: fingerprint(toolsForArm(arm)),
        },
      ]),
    ),
    requestSettings: {
      thinking: structuredClone(DEFAULT_PROFILE.thinking),
      reasoningEffort: DEFAULT_PROFILE.reasoningEffort,
      maxTokens: configuration.maxTokens,
      timeoutMs: configuration.timeoutMs,
      runsPerArm: configuration.runsPerArm,
      interleavedArmOrder: ARM_ORDER,
    },
    verdict: compareArms(
      runsFor(ARM_NAMES.dshMinimal),
      runsFor(ARM_NAMES.standardControl),
    ),
    runs,
  }

  const resultDirectory = resolve('results')
  await mkdir(resultDirectory, { recursive: true })
  const timestamp = result.createdAt.replaceAll(':', '-')
  const resultPath = resolve(
    resultDirectory,
    `dsh-minimal-trajectory-${timestamp}.json`,
  )
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  process.stdout.write(`${JSON.stringify({
    saved: resultPath,
    verdict: result.verdict,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
