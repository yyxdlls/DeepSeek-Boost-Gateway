import { join } from 'node:path'

const MODEL_PRO = 'deepseek-v4-pro'
const MODEL_FLASH = 'deepseek-v4-flash'
const MODEL_VISION = 'deepseek-v4-flash-vision-exp'
const DEFAULT_PRO_ANCHOR_PATH = 'anchors/deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json'
export const DEFAULT_UPSTREAM_BASE_URL = 'https://api.deepseek.com'

const SPLIT_PROFILE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    name: 'pro',
    prefix: 'GATEWAY_PRO',
    model: MODEL_PRO,
    defaultPort: 8643,
    defaultEnabled: true,
    defaultMode: 'anchor',
    defaultAnchorPath: DEFAULT_PRO_ANCHOR_PATH,
  }),
  Object.freeze({
    name: 'flash',
    prefix: 'GATEWAY_FLASH',
    model: MODEL_FLASH,
    defaultPort: 8644,
    defaultEnabled: true,
    // The previously bundled Flash artifact copied the Pro trajectory and was
    // not a Flash-native generation. Do not activate it as a trusted default.
    defaultMode: 'bypass',
    defaultAnchorPath: '',
  }),
  Object.freeze({
    name: 'vision',
    prefix: 'GATEWAY_VISION',
    model: MODEL_VISION,
    defaultPort: 8645,
    defaultEnabled: true,
    // No bundled model-native Anchor exists yet. Start transparently, then
    // generate and bind one from the WebUI before switching to anchor mode.
    defaultMode: 'bypass',
    defaultAnchorPath: '',
  }),
])

function nonEmpty(...values) {
  return values.find((value) => value !== undefined && String(value).trim() !== '') ?? ''
}

export function resolveAnchorPath(environment, keys, defaultPath) {
  const source = environment ?? {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    return value === undefined || value === null ? '' : String(value)
  }
  return defaultPath === undefined || defaultPath === null ? '' : String(defaultPath)
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

function parseModelList(value, fallback) {
  return String(value ?? fallback)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

function ownProfileApiKey(env, prefix) {
  return String(env[`${prefix}_UPSTREAM_API_KEY`] ?? '').trim()
}

function ownProfileUpstream(env, prefix) {
  return String(env[`${prefix}_UPSTREAM_BASE_URL`] ?? '').trim() || DEFAULT_UPSTREAM_BASE_URL
}

function descriptorAnchorPath(env, descriptor) {
  return resolveAnchorPath(
    env,
    descriptor.model === MODEL_PRO
      ? [`${descriptor.prefix}_ANCHOR_PATH`, 'GATEWAY_ANCHOR_PATH']
      : [`${descriptor.prefix}_ANCHOR_PATH`],
    descriptor.defaultAnchorPath,
  )
}

function listenerAnchorPaths(env) {
  return {
    [MODEL_PRO]: resolveAnchorPath(
      env,
      ['GATEWAY_PRO_ANCHOR_PATH', 'GATEWAY_ANCHOR_PATH'],
      DEFAULT_PRO_ANCHOR_PATH,
    ),
    [MODEL_FLASH]: resolveAnchorPath(env, ['GATEWAY_FLASH_ANCHOR_PATH'], ''),
    [MODEL_VISION]: resolveAnchorPath(env, ['GATEWAY_VISION_ANCHOR_PATH'], ''),
  }
}

export function gatewayModelPlanes(env = process.env) {
  return SPLIT_PROFILE_DESCRIPTORS.map((descriptor) => {
    const gatewayApiKey = ownProfileApiKey(env, descriptor.prefix)
    return {
      name: descriptor.name,
      model: descriptor.model,
      enabled: enabled(
        env[`${descriptor.prefix}_ENABLED`],
        descriptor.defaultEnabled,
      ),
      upstreamBaseUrl: ownProfileUpstream(env, descriptor.prefix),
      upstreamModel: String(env[`${descriptor.prefix}_UPSTREAM_MODEL`] ?? '').trim(),
      gatewayApiKey,
      gatewayApiKeySource: gatewayApiKey ? 'profile' : 'none',
      defaultMode: nonEmpty(
        env[`${descriptor.prefix}_ENHANCEMENT_MODE`],
        descriptor.defaultMode,
      ),
      anchorPath: descriptorAnchorPath(env, descriptor),
    }
  })
}

export function warnIfUnusableGlobalUpstreamKey(env = process.env, write = (line) => {
  process.stderr.write(line)
}) {
  const globalKey = String(env.GATEWAY_UPSTREAM_API_KEY ?? '').trim()
  if (!globalKey) return false
  const hasOwnKey = SPLIT_PROFILE_DESCRIPTORS.some((descriptor) => (
    ownProfileApiKey(env, descriptor.prefix)
  ))
  if (hasOwnKey) return false
  const mode = env.GATEWAY_INSTANCE_MODE ?? 'single'
  const modelCount = mode === 'split'
    ? gatewaySplitProfiles(env).length
    : parseModelList(
      mode === 'all'
        ? env.GATEWAY_COMBINED_MODELS ?? [MODEL_PRO, MODEL_FLASH, MODEL_VISION].join(',')
        : env.GATEWAY_MODELS ?? [MODEL_PRO, MODEL_FLASH, MODEL_VISION].join(','),
      [MODEL_PRO, MODEL_FLASH, MODEL_VISION].join(','),
    ).length
  if (modelCount < 2) return false
  write(
    'Gateway warning: GATEWAY_UPSTREAM_API_KEY is set, but no per-model GATEWAY_*_UPSTREAM_API_KEY is configured. Multi-model routing will not share this key; requests for a model without its own key return 503.\n',
  )
  return true
}

function multiModelListenerProfile(env, options) {
  return {
    name: options.name,
    host: options.host,
    port: options.port,
    models: options.models,
    planes: gatewayModelPlanes(env),
    managementToken: env.GATEWAY_MANAGEMENT_TOKEN ?? '',
    anchorPaths: listenerAnchorPaths(env),
    logDir: options.logDir,
    ...sharedOptions(env),
  }
}

function singleProfile(env) {
  const models = parseModelList(
    env.GATEWAY_MODELS,
    [MODEL_PRO, MODEL_FLASH, MODEL_VISION].join(','),
  )
  return multiModelListenerProfile(env, {
    name: 'single',
    host: env.GATEWAY_HOST ?? '127.0.0.1',
    port: port(env.GATEWAY_PORT, 8642, 'GATEWAY_PORT'),
    models,
    logDir: env.GATEWAY_LOG_DIR,
  })
}

function splitProfile(env, descriptor) {
  const prefix = descriptor.prefix
  const sharedLogRoot = env.GATEWAY_LOG_DIR ?? join(process.cwd(), 'results', 'gateway')
  const plane = gatewayModelPlanes(env).find((item) => item.name === descriptor.name)
  return {
    name: descriptor.name,
    host: nonEmpty(env[`${prefix}_HOST`], env.GATEWAY_HOST, '127.0.0.1'),
    port: port(env[`${prefix}_PORT`], descriptor.defaultPort, `${prefix}_PORT`),
    models: [descriptor.model],
    planes: plane ? [plane] : [],
    upstreamBaseUrl: plane?.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL,
    upstreamModel: String(plane?.upstreamModel ?? '').trim(),
    gatewayApiKey: plane?.gatewayApiKey ?? '',
    gatewayApiKeySource: plane?.gatewayApiKeySource ?? 'none',
    managementToken: nonEmpty(
      env[`${prefix}_MANAGEMENT_TOKEN`],
      env.GATEWAY_MANAGEMENT_TOKEN,
    ),
    defaultMode: plane?.defaultMode ?? descriptor.defaultMode,
    anchorPaths: {
      [descriptor.model]: plane?.anchorPath ?? descriptorAnchorPath(env, descriptor),
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
  if (!['split', 'all'].includes(mode)) {
    throw new Error('GATEWAY_INSTANCE_MODE must be split, single, or all.')
  }

  const profiles = gatewaySplitProfiles(env).filter((profile) => profile.enabled)
  if (profiles.length === 0) {
    throw new Error('Split mode requires at least one enabled Pro, Flash, or Vision profile.')
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

export function gatewayCombinedProfile(env = process.env) {
  return multiModelListenerProfile(env, {
    name: 'combined',
    host: env.GATEWAY_COMBINED_HOST ?? env.GATEWAY_HOST ?? '127.0.0.1',
    port: port(env.GATEWAY_COMBINED_PORT, 8646, 'GATEWAY_COMBINED_PORT'),
    models: parseModelList(
      env.GATEWAY_COMBINED_MODELS,
      [MODEL_PRO, MODEL_FLASH, MODEL_VISION].join(','),
    ),
    logDir: env.GATEWAY_COMBINED_LOG_DIR ?? join(
      env.GATEWAY_LOG_DIR ?? join(process.cwd(), 'results', 'gateway'),
      'combined',
    ),
  })
}

export function validateGatewayDeployment(env = process.env) {
  const mode = env.GATEWAY_INSTANCE_MODE ?? 'single'
  const profiles = gatewayRuntimeProfiles(env)
  const listeners = mode === 'single'
    ? profiles.map((profile) => ({ name: profile.name, host: profile.host, port: profile.port }))
    : [
        { name: 'management', ...gatewayManagementConfig(env) },
        ...profiles.map((profile) => ({ name: profile.name, host: profile.host, port: profile.port })),
        ...(mode === 'all' ? [gatewayCombinedProfile(env)].map((profile) => ({
          name: profile.name,
          host: profile.host,
          port: profile.port,
        })) : []),
      ]
  const seen = new Map()
  for (const listener of listeners) {
    const key = `${listener.host.toLowerCase()}:${listener.port}`
    if (seen.has(key)) {
      throw new Error(`Gateway ${listener.name} cannot share listener ${key} with ${seen.get(key)}.`)
    }
    seen.set(key, listener.name)
  }
  return { mode, listeners }
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
  vision: MODEL_VISION,
})
