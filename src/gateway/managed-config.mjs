import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GATEWAY_MODELS, gatewaySplitProfiles } from './runtime-config.mjs'

export const DEFAULT_MANAGED_CONFIG_PATH = resolve('gateway.config.json')

const PROFILE_NAMES = Object.freeze(['pro', 'flash', 'vision'])
export const MANAGED_DEPLOYMENT_MODES = Object.freeze(['split', 'single', 'all'])
const ENV_FIELDS = Object.freeze({
  enabled: 'ENABLED',
  host: 'HOST',
  port: 'PORT',
  upstreamBaseUrl: 'UPSTREAM_BASE_URL',
  apiKey: 'UPSTREAM_API_KEY',
  enhancementMode: 'ENHANCEMENT_MODE',
  anchorPath: 'ANCHOR_PATH',
  logDir: 'LOG_DIR',
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function maskApiKey(value) {
  const key = String(value ?? '')
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}••••${key.slice(-2)}`
  return `${key.slice(0, 7)}••••${key.slice(-4)}`
}

function validateDocument(document) {
  if (!isRecord(document)) throw new Error('Managed Gateway config must be a JSON object.')
  if (document.schemaVersion !== 1) {
    throw new Error('Managed Gateway config schemaVersion must be 1.')
  }
  if (!isRecord(document.profiles)) {
    throw new Error('Managed Gateway config profiles must be an object.')
  }
  if (document.deployment !== undefined) {
    if (!isRecord(document.deployment)) {
      throw new Error('Managed Gateway config deployment must be an object.')
    }
    const allowed = new Set(['mode', 'combinedPort'])
    for (const key of Object.keys(document.deployment)) {
      if (!allowed.has(key)) throw new Error(`Unsupported deployment setting: ${key}`)
    }
    if (own(document.deployment, 'mode') && !MANAGED_DEPLOYMENT_MODES.includes(document.deployment.mode)) {
      throw new Error('deployment.mode must be split, single, or all.')
    }
    if (own(document.deployment, 'combinedPort')) {
      const value = Number(document.deployment.combinedPort)
      if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
        throw new Error('deployment.combinedPort must be an integer from 1 to 65535.')
      }
    }
  }
  for (const name of Object.keys(document.profiles)) {
    if (!PROFILE_NAMES.includes(name)) throw new Error(`Unknown managed profile: ${name}`)
    if (!isRecord(document.profiles[name])) {
      throw new Error(`Managed profile ${name} must be an object.`)
    }
  }
  return document
}

export function emptyManagedConfig() {
  return { schemaVersion: 1, profiles: {} }
}

export async function loadManagedConfig(path = DEFAULT_MANAGED_CONFIG_PATH) {
  try {
    return validateDocument(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyManagedConfig()
    throw error
  }
}

export async function saveManagedConfig(document, path = DEFAULT_MANAGED_CONFIG_PATH) {
  validateDocument(document)
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function applyManagedConfig(environment = process.env, document = emptyManagedConfig()) {
  validateDocument(document)
  const deployment = managedDeploymentView(environment, document)
  const merged = {
    ...environment,
    GATEWAY_INSTANCE_MODE: deployment.mode,
    GATEWAY_COMBINED_PORT: String(deployment.combinedPort),
  }
  if (document.deployment?.mode === 'single') {
    merged.GATEWAY_MODELS = Object.values(GATEWAY_MODELS).join(',')
    merged.GATEWAY_ENHANCEMENT_MODE = 'bypass'
  }
  for (const name of PROFILE_NAMES) {
    const values = document.profiles[name]
    if (!isRecord(values)) continue
    const prefix = `GATEWAY_${name.toUpperCase()}`
    for (const [field, suffix] of Object.entries(ENV_FIELDS)) {
      if (!own(values, field)) continue
      merged[`${prefix}_${suffix}`] = String(values[field])
    }
  }
  return merged
}

function validateProfilePatch(name, patch) {
  if (!PROFILE_NAMES.includes(name)) throw new Error(`Unknown Gateway profile: ${name}`)
  if (!isRecord(patch)) throw new Error('Profile update must be a JSON object.')
  const allowed = new Set([...Object.keys(ENV_FIELDS), 'clearApiKey'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unsupported profile setting: ${key}`)
  }
  if (own(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.')
  }
  if (own(patch, 'port')) {
    const value = Number(patch.port)
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      throw new Error('port must be an integer from 1 to 65535.')
    }
  }
  if (own(patch, 'enhancementMode') && !['anchor', 'bypass'].includes(patch.enhancementMode)) {
    throw new Error('enhancementMode must be anchor or bypass.')
  }
  if (own(patch, 'upstreamBaseUrl')) {
    const url = new URL(String(patch.upstreamBaseUrl))
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('upstreamBaseUrl must use http or https.')
    }
  }
  for (const field of ['host', 'upstreamBaseUrl', 'anchorPath', 'logDir']) {
    if (own(patch, field) && typeof patch[field] !== 'string') {
      throw new Error(`${field} must be a string.`)
    }
  }
  if (own(patch, 'apiKey') && typeof patch.apiKey !== 'string') {
    throw new Error('apiKey must be a string.')
  }
  if (own(patch, 'clearApiKey') && typeof patch.clearApiKey !== 'boolean') {
    throw new Error('clearApiKey must be a boolean.')
  }
}

export function updateManagedProfile(document, name, patch) {
  validateDocument(document)
  validateProfilePatch(name, patch)
  const current = document.profiles[name] ?? {}
  const next = { ...current }
  for (const field of Object.keys(ENV_FIELDS)) {
    if (field === 'apiKey') continue
    if (own(patch, field)) next[field] = patch[field]
  }
  if (patch.clearApiKey) next.apiKey = ''
  else if (own(patch, 'apiKey') && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
  return {
    ...document,
    profiles: {
      ...document.profiles,
      [name]: next,
    },
  }
}

export function managedDeploymentView(environment = process.env, document = emptyManagedConfig()) {
  validateDocument(document)
  const mode = document.deployment?.mode ?? environment.GATEWAY_INSTANCE_MODE ?? 'single'
  if (!MANAGED_DEPLOYMENT_MODES.includes(mode)) {
    throw new Error('Gateway deployment mode must be split, single, or all.')
  }
  const rawPort = document.deployment?.combinedPort ?? environment.GATEWAY_COMBINED_PORT ?? 8646
  const combinedPort = Number(rawPort)
  if (!Number.isSafeInteger(combinedPort) || combinedPort < 1 || combinedPort > 65535) {
    throw new Error('Combined Gateway port must be an integer from 1 to 65535.')
  }
  return { mode, combinedPort, restartRequired: false }
}

export function updateManagedDeployment(document, patch, environment = process.env) {
  validateDocument(document)
  if (!isRecord(patch)) throw new Error('Deployment update must be a JSON object.')
  const allowed = new Set(['mode', 'combinedPort'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unsupported deployment setting: ${key}`)
  }
  const current = managedDeploymentView(environment, document)
  const mode = own(patch, 'mode') ? String(patch.mode) : current.mode
  const combinedPort = own(patch, 'combinedPort')
    ? Number(patch.combinedPort)
    : current.combinedPort
  if (!MANAGED_DEPLOYMENT_MODES.includes(mode)) {
    throw new Error('deployment mode must be split, single, or all.')
  }
  if (!Number.isSafeInteger(combinedPort) || combinedPort < 1 || combinedPort > 65535) {
    throw new Error('combinedPort must be an integer from 1 to 65535.')
  }
  return {
    ...document,
    deployment: { mode, combinedPort },
  }
}

export function managedProfileViews(environment, document) {
  const effectiveEnvironment = applyManagedConfig(environment, document)
  return gatewaySplitProfiles(effectiveEnvironment).map((profile) => ({
    name: profile.name,
    model: profile.models[0],
    enabled: profile.enabled,
    host: profile.host,
    port: profile.port,
    upstreamBaseUrl: profile.upstreamBaseUrl,
    apiKeyConfigured: Boolean(profile.gatewayApiKey),
    apiKeySource: profile.gatewayApiKeySource ?? 'none',
    apiKeyPreview: maskApiKey(profile.gatewayApiKey),
    enhancementMode: profile.defaultMode,
    anchorPath: profile.anchorPaths[profile.models[0]] ?? '',
    anchorConfigured: Boolean(profile.anchorPaths[profile.models[0]]),
    logDir: profile.logDir ?? '',
  }))
}

export function managedProfileSecrets(environment, document) {
  return gatewaySplitProfiles(applyManagedConfig(environment, document))
}

export const MANAGED_PROFILE_NAMES = PROFILE_NAMES
