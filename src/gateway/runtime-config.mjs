import { join } from 'node:path'

const MODEL_PRO = 'deepseek-v4-pro'
const MODEL_FLASH = 'deepseek-v4-flash'

const SPLIT_PROFILE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    name: 'pro',
    prefix: 'GATEWAY_PRO',
    model: MODEL_PRO,
    defaultPort: 8643,
    defaultEnabled: true,
  }),
  Object.freeze({
    name: 'flash',
    prefix: 'GATEWAY_FLASH',
    model: MODEL_FLASH,
    defaultPort: 8644,
    defaultEnabled: false,
  }),
])

function nonEmpty(...values) {
  return values.find((value) => value !== undefined && String(value).trim() !== '') ?? ''
}

function enabled(value, fallback) {
  if (value === undefined || value === '') return fallback
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function port(value, fallback, name) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`)
  }
  return parsed
}

function sharedOptions(env) {
  return {
    captureMode: env.GATEWAY_CAPTURE_MODE ?? 'metadata',
    captureLimitBytes: env.GATEWAY_CAPTURE_LIMIT_BYTES,
    responseObservationLimitBytes: env.GATEWAY_RESPONSE_OBSERVATION_LIMIT_BYTES,
    upstreamTimeoutMs: env.GATEWAY_UPSTREAM_TIMEOUT_MS,
    requestLimitBytes: env.GATEWAY_REQUEST_LIMIT_BYTES,
    diagnosticHistoryLimit: env.GATEWAY_DIAGNOSTIC_HISTORY_LIMIT,
    logMaxBytes: env.GATEWAY_LOG_MAX_BYTES,
    logMaxFiles: env.GATEWAY_LOG_MAX_FILES,
  }
}

function singleProfile(env) {
  const models = (env.GATEWAY_MODELS ?? MODEL_PRO)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  return {
    name: 'single',
    host: env.GATEWAY_HOST ?? '127.0.0.1',
    port: port(env.GATEWAY_PORT, 8642, 'GATEWAY_PORT'),
    models,
    upstreamBaseUrl: env.GATEWAY_UPSTREAM_BASE_URL ?? 'https://api.deepseek.com',
    gatewayApiKey: env.GATEWAY_UPSTREAM_API_KEY ?? '',
    managementToken: env.GATEWAY_MANAGEMENT_TOKEN ?? '',
    defaultMode: env.GATEWAY_ENHANCEMENT_MODE ?? 'anchor',
    anchorPaths: {
      [MODEL_PRO]: nonEmpty(
        env.GATEWAY_PRO_ANCHOR_PATH,
        env.GATEWAY_ANCHOR_PATH,
      ),
      [MODEL_FLASH]: env.GATEWAY_FLASH_ANCHOR_PATH ?? '',
    },
    logDir: env.GATEWAY_LOG_DIR,
    ...sharedOptions(env),
  }
}

function splitProfile(env, descriptor) {
  const prefix = descriptor.prefix
  const sharedLogRoot = env.GATEWAY_LOG_DIR ?? join(process.cwd(), 'results', 'gateway')
  const profileApiKey = env[`${prefix}_UPSTREAM_API_KEY`]
  const gatewayApiKey = nonEmpty(profileApiKey, env.GATEWAY_UPSTREAM_API_KEY)
  return {
    name: descriptor.name,
    host: nonEmpty(env[`${prefix}_HOST`], env.GATEWAY_HOST, '127.0.0.1'),
    port: port(env[`${prefix}_PORT`], descriptor.defaultPort, `${prefix}_PORT`),
    models: [descriptor.model],
    upstreamBaseUrl: nonEmpty(
      env[`${prefix}_UPSTREAM_BASE_URL`],
      env.GATEWAY_UPSTREAM_BASE_URL,
      'https://api.deepseek.com',
    ),
    gatewayApiKey,
    gatewayApiKeySource: String(profileApiKey ?? '').trim()
      ? 'profile'
      : gatewayApiKey
        ? 'shared-fallback'
        : 'none',
    managementToken: nonEmpty(
      env[`${prefix}_MANAGEMENT_TOKEN`],
      env.GATEWAY_MANAGEMENT_TOKEN,
    ),
    defaultMode: nonEmpty(
      env[`${prefix}_ENHANCEMENT_MODE`],
      env.GATEWAY_ENHANCEMENT_MODE,
      'anchor',
    ),
    anchorPaths: {
      [descriptor.model]: nonEmpty(
        env[`${prefix}_ANCHOR_PATH`],
        descriptor.model === MODEL_PRO ? env.GATEWAY_ANCHOR_PATH : '',
      ),
    },
    logDir: nonEmpty(env[`${prefix}_LOG_DIR`], join(sharedLogRoot, descriptor.name)),
    ...sharedOptions(env),
  }
}

export function gatewaySplitProfiles(env = process.env) {
  return SPLIT_PROFILE_DESCRIPTORS.map((descriptor) => ({
    ...splitProfile(env, descriptor),
    enabled: enabled(
      env[`${descriptor.prefix}_ENABLED`],
      descriptor.defaultEnabled,
    ),
  }))
}

export function gatewayRuntimeProfiles(env = process.env) {
  const mode = env.GATEWAY_INSTANCE_MODE ?? 'single'
  if (mode === 'single') return [singleProfile(env)]
  if (mode !== 'split') {
    throw new Error('GATEWAY_INSTANCE_MODE must be single or split.')
  }

  const profiles = gatewaySplitProfiles(env).filter((profile) => profile.enabled)
  if (profiles.length === 0) {
    throw new Error('Split mode requires GATEWAY_PRO_ENABLED or GATEWAY_FLASH_ENABLED.')
  }

  const listeners = new Set()
  for (const profile of profiles) {
    const listener = `${profile.host.toLowerCase()}:${profile.port}`
    if (listeners.has(listener)) {
      throw new Error(`Gateway profiles cannot share listener ${listener}.`)
    }
    listeners.add(listener)
  }
  return profiles
}

export function gatewayManagementConfig(env = process.env) {
  return {
    host: env.GATEWAY_WEB_UI_HOST ?? env.GATEWAY_HOST ?? '127.0.0.1',
    port: port(env.GATEWAY_WEB_UI_PORT, 8642, 'GATEWAY_WEB_UI_PORT'),
    managementToken: env.GATEWAY_MANAGEMENT_TOKEN ?? '',
  }
}

export const GATEWAY_MODELS = Object.freeze({
  pro: MODEL_PRO,
  flash: MODEL_FLASH,
})
