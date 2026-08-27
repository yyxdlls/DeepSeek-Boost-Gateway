import { rename, unlink, writeFile, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  BUILTIN_MICRO_ANCHOR_ID,
  MICRO_ANCHOR_CACHE_WARNING,
  builtinMicroAnchor,
  collectMicroAnchorReferences,
  createCustomMicroAnchor,
  defaultMicroAnchorSelection,
  deleteCustomMicroAnchor,
  isBuiltinMicroAnchorId,
  isCustomMicroAnchorId,
  resolveMicroAnchorDefinition,
  resolveMicroAnchorSnapshot,
  updateCustomMicroAnchor,
} from './micro-anchor.mjs'
import { toCatalogAnchorPath } from './anchor-catalog.mjs'
import { GATEWAY_MODELS, gatewaySplitProfiles } from './runtime-config.mjs'

export const DEFAULT_MANAGED_CONFIG_PATH = resolve('gateway.config.json')

const PROFILE_NAMES = Object.freeze(['pro', 'flash', 'vision'])
export const MANAGED_DEPLOYMENT_MODES = Object.freeze(['split', 'single', 'all'])
const ENV_FIELDS = Object.freeze({
  enabled: 'ENABLED',
  host: 'HOST',
  port: 'PORT',
  upstreamBaseUrl: 'UPSTREAM_BASE_URL',
  upstreamModel: 'UPSTREAM_MODEL',
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

const UPSTREAM_MODEL_MAX = 200

export function normalizeUpstreamModel(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('upstreamModel must be a string.')
  const normalized = value.trim()
  if (!normalized) return ''
  if (normalized.length > UPSTREAM_MODEL_MAX) {
    throw new Error(`upstreamModel must contain at most ${UPSTREAM_MODEL_MAX} characters.`)
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
    throw new Error('upstreamModel must not contain control characters.')
  }
  return normalized
}

function validateMicroAnchorDocument(document) {
  if (document.microAnchors === undefined) return
  if (!isRecord(document.microAnchors)) {
    throw new Error('Managed Gateway config microAnchors must be an object.')
  }
  const allowed = new Set(['definitions'])
  for (const key of Object.keys(document.microAnchors)) {
    if (!allowed.has(key)) throw new Error(`Unsupported microAnchors setting: ${key}`)
  }
  if (document.microAnchors.definitions === undefined) return
  if (!isRecord(document.microAnchors.definitions)) {
    throw new Error('Managed Gateway config microAnchors.definitions must be an object.')
  }
  for (const [id, entry] of Object.entries(document.microAnchors.definitions)) {
    if (isBuiltinMicroAnchorId(id) || !isCustomMicroAnchorId(id)) {
      throw new Error(`Invalid custom micro-anchor id: ${id}`)
    }
    if (!isRecord(entry)) throw new Error(`Micro-anchor ${id} must be an object.`)
    if (entry.name !== undefined && typeof entry.name !== 'string') {
      throw new Error(`Micro-anchor ${id} name must be a string.`)
    }
    if (entry.content !== undefined && typeof entry.content !== 'string') {
      throw new Error(`Micro-anchor ${id} content must be a string.`)
    }
  }
}

function validateProfileMicroAnchor(name, selection) {
  if (selection === undefined) return
  if (!isRecord(selection)) {
    throw new Error(`Managed profile ${name} microAnchor must be an object.`)
  }
  const allowed = new Set(['enabled', 'selectedId'])
  for (const key of Object.keys(selection)) {
    if (!allowed.has(key)) throw new Error(`Unsupported microAnchor setting: ${key}`)
  }
  if (own(selection, 'enabled') && typeof selection.enabled !== 'boolean') {
    throw new Error('microAnchor.enabled must be a boolean.')
  }
  if (own(selection, 'selectedId') && typeof selection.selectedId !== 'string') {
    throw new Error('microAnchor.selectedId must be a string.')
  }
}

function validateDocument(document) {
  if (!isRecord(document)) throw new Error('Managed Gateway config must be a JSON object.')
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2) {
    throw new Error('Managed Gateway config schemaVersion must be 1 or 2.')
  }
  if (!isRecord(document.profiles)) {
    throw new Error('Managed Gateway config profiles must be an object.')
  }
  validateMicroAnchorDocument(document)
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
    validateProfileMicroAnchor(name, document.profiles[name].microAnchor)
  }
  return document
}

function migrateManagedConfig(document) {
  validateDocument(document)
  const next = {
    ...document,
    schemaVersion: 2,
    profiles: { ...document.profiles },
  }
  const existingDefinitions = isRecord(document.microAnchors?.definitions)
    ? document.microAnchors.definitions
    : {}
  next.microAnchors = {
    ...(isRecord(document.microAnchors) ? document.microAnchors : {}),
    definitions: { ...existingDefinitions },
  }
  for (const name of PROFILE_NAMES) {
    if (!isRecord(next.profiles[name])) continue
    const profile = { ...next.profiles[name] }
    if (!isRecord(profile.microAnchor)) {
      profile.microAnchor = defaultMicroAnchorSelection()
    } else {
      profile.microAnchor = {
        ...defaultMicroAnchorSelection(),
        ...profile.microAnchor,
      }
    }
    next.profiles[name] = profile
  }
  return next
}

function assertValidMicroAnchorSelections(document) {
  const definitions = document.microAnchors?.definitions ?? {}
  for (const name of PROFILE_NAMES) {
    const selection = document.profiles[name]?.microAnchor
    if (!isRecord(selection)) continue
    resolveMicroAnchorSnapshot(definitions, selection)
  }
}

function assertDocumentAnchorCompatibility(document) {
  for (const name of PROFILE_NAMES) {
    const profile = document.profiles[name]
    if (!isRecord(profile)) continue
    if (profile.enhancementMode === 'anchor' && own(profile, 'anchorPath') && profile.anchorPath === '') {
      throw new Error(`${name} cannot use anchor mode with an empty Anchor path.`)
    }
  }
}

export function normalizeManagedConfig(document) {
  const migrated = migrateManagedConfig(document)
  assertValidMicroAnchorSelections(migrated)
  assertDocumentAnchorCompatibility(migrated)
  return migrated
}

export function emptyManagedConfig() {
  return {
    schemaVersion: 2,
    microAnchors: { definitions: {} },
    profiles: {},
  }
}

async function atomicWriteFile(path, text) {
  const directory = dirname(path)
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tempPath, path)
    return
  } catch (error) {
    if (process.platform !== 'win32') {
      await unlink(tempPath).catch(() => {})
      throw error
    }
  }
  const backupPath = `${path}.${process.pid}.bak`
  let movedExisting = false
  try {
    await rename(path, backupPath)
    movedExisting = true
  } catch (backupError) {
    if (backupError?.code !== 'ENOENT') {
      await unlink(tempPath).catch(() => {})
      throw backupError
    }
  }
  try {
    await rename(tempPath, path)
    if (movedExisting) await unlink(backupPath).catch(() => {})
  } catch (replaceError) {
    if (movedExisting) {
      try {
        await rename(backupPath, path)
      } catch {
        // Preserve the replace error; caller still sees a failed save.
      }
    }
    await unlink(tempPath).catch(() => {})
    throw replaceError
  }
}

export async function loadManagedConfig(path = DEFAULT_MANAGED_CONFIG_PATH) {
  try {
    return normalizeManagedConfig(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyManagedConfig()
    throw error
  }
}

export async function saveManagedConfig(
  document,
  path = DEFAULT_MANAGED_CONFIG_PATH,
  environment = process.env,
) {
  const normalized = normalizeManagedConfig(document)
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

export function applyManagedConfig(environment = process.env, document = emptyManagedConfig()) {
  const normalized = normalizeManagedConfig(document)
  const deployment = managedDeploymentView(environment, document)
  const merged = {
    ...environment,
    GATEWAY_INSTANCE_MODE: deployment.mode,
    GATEWAY_COMBINED_PORT: String(deployment.combinedPort),
  }
  if (normalized.deployment?.mode === 'single') {
    merged.GATEWAY_MODELS = Object.values(GATEWAY_MODELS).join(',')
  }
  for (const name of PROFILE_NAMES) {
    const values = normalized.profiles[name]
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
  const allowed = new Set([...Object.keys(ENV_FIELDS), 'clearApiKey', 'microAnchor'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unsupported profile setting: ${key}`)
  }
  if (own(patch, 'microAnchor')) validateProfileMicroAnchor(name, patch.microAnchor)
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
  if (own(patch, 'upstreamModel')) {
    normalizeUpstreamModel(patch.upstreamModel)
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

function nextProfileMicroAnchor(current, patch) {
  const baseline = isRecord(current.microAnchor)
    ? { ...defaultMicroAnchorSelection(), ...current.microAnchor }
    : defaultMicroAnchorSelection()
  if (!own(patch, 'microAnchor')) return baseline
  const nextSelection = { ...baseline }
  if (own(patch.microAnchor, 'enabled')) nextSelection.enabled = patch.microAnchor.enabled
  if (own(patch.microAnchor, 'selectedId')) nextSelection.selectedId = patch.microAnchor.selectedId
  return nextSelection
}

export function updateManagedProfile(document, name, patch) {
  const currentDocument = normalizeManagedConfig(document)
  validateProfilePatch(name, patch)
  const current = currentDocument.profiles[name] ?? {}
  const next = { ...current }
  for (const field of Object.keys(ENV_FIELDS)) {
    if (field === 'apiKey') continue
    if (own(patch, field)) {
      next[field] = field === 'anchorPath'
        ? toCatalogAnchorPath(patch[field])
        : field === 'upstreamModel'
          ? normalizeUpstreamModel(patch[field])
          : patch[field]
    }
  }
  if (patch.clearApiKey) next.apiKey = ''
  else if (own(patch, 'apiKey') && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
  next.microAnchor = nextProfileMicroAnchor(current, patch)
  return normalizeManagedConfig({
    ...currentDocument,
    profiles: {
      ...currentDocument.profiles,
      [name]: next,
    },
  })
}

export function managedDeploymentView(environment = process.env, document = emptyManagedConfig()) {
  normalizeManagedConfig(document)
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
  const currentDocument = normalizeManagedConfig(document)
  if (!isRecord(patch)) throw new Error('Deployment update must be a JSON object.')
  const allowed = new Set(['mode', 'combinedPort'])
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unsupported deployment setting: ${key}`)
  }
  const current = managedDeploymentView(environment, currentDocument)
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
  return normalizeManagedConfig({
    ...currentDocument,
    deployment: { mode, combinedPort },
  })
}

function publicMicroAnchorSelection(snapshot) {
  return {
    enabled: Boolean(snapshot?.enabled),
    selectedId: snapshot?.id ?? BUILTIN_MICRO_ANCHOR_ID,
    effectiveFingerprint: snapshot?.enabled ? snapshot.contentFingerprint ?? null : null,
    source: snapshot?.source ?? null,
  }
}

export function resolveProfileMicroAnchorSnapshot(document, name) {
  const normalized = normalizeManagedConfig(document)
  return resolveMicroAnchorSnapshot(
    normalized.microAnchors.definitions,
    normalized.profiles[name]?.microAnchor ?? defaultMicroAnchorSelection(),
  )
}

export function resolveModelMicroAnchorSnapshots(document) {
  const snapshots = {}
  for (const name of PROFILE_NAMES) {
    snapshots[GATEWAY_MODELS[name]] = resolveProfileMicroAnchorSnapshot(document, name)
  }
  return snapshots
}

export function attachMicroAnchorSnapshots(profile, snapshotsByModel) {
  const microAnchors = {}
  for (const model of profile.models ?? []) {
    if (snapshotsByModel[model]) microAnchors[model] = snapshotsByModel[model]
  }
  return { ...profile, microAnchors }
}

export function createManagedMicroAnchor(document, input) {
  const current = normalizeManagedConfig(document)
  const created = createCustomMicroAnchor(current.microAnchors.definitions, input)
  return normalizeManagedConfig({
    ...current,
    microAnchors: {
      ...current.microAnchors,
      definitions: {
        ...current.microAnchors.definitions,
        [created.id]: created.definition,
      },
    },
  })
}

export function updateManagedMicroAnchor(document, id, patch) {
  const current = normalizeManagedConfig(document)
  const nextDefinition = updateCustomMicroAnchor(current.microAnchors.definitions, id, patch)
  return normalizeManagedConfig({
    ...current,
    microAnchors: {
      ...current.microAnchors,
      definitions: {
        ...current.microAnchors.definitions,
        [id]: nextDefinition,
      },
    },
  })
}

export function deleteManagedMicroAnchor(document, id) {
  const current = normalizeManagedConfig(document)
  deleteCustomMicroAnchor(current.microAnchors.definitions, current.profiles, id)
  const { [id]: _removed, ...definitions } = current.microAnchors.definitions
  return normalizeManagedConfig({
    ...current,
    microAnchors: {
      ...current.microAnchors,
      definitions,
    },
  })
}

export function managedMicroAnchorView(document) {
  const normalized = normalizeManagedConfig(document)
  const definitions = [
    builtinMicroAnchor(),
    ...Object.keys(normalized.microAnchors.definitions).map((id) => (
      resolveMicroAnchorDefinition(normalized.microAnchors.definitions, id)
    )),
  ].map((definition) => ({
    ...definition,
    referencedBy: collectMicroAnchorReferences(normalized.profiles, definition.id),
  }))
  const profiles = {}
  for (const name of PROFILE_NAMES) {
    profiles[name] = publicMicroAnchorSelection(resolveProfileMicroAnchorSnapshot(normalized, name))
  }
  return {
    cacheWarning: MICRO_ANCHOR_CACHE_WARNING,
    definitions,
    profiles,
  }
}

export function managedDocumentView(environment, document) {
  const normalized = normalizeManagedConfig(document)
  return {
    schemaVersion: normalized.schemaVersion,
    deployment: managedDeploymentView(environment, normalized),
    profiles: managedProfileViews(environment, normalized),
    microAnchors: managedMicroAnchorView(normalized),
  }
}

export function effectiveMicroAnchorFingerprint(snapshot) {
  if (!snapshot?.enabled) return null
  return snapshot.contentFingerprint ?? null
}

export function managedProfileViews(environment, document) {
  const normalized = normalizeManagedConfig(document)
  const effectiveEnvironment = applyManagedConfig(environment, normalized)
  return gatewaySplitProfiles(effectiveEnvironment).map((profile) => {
    const snapshot = resolveProfileMicroAnchorSnapshot(normalized, profile.name)
    return {
      name: profile.name,
      model: profile.models[0],
      enabled: profile.enabled,
      host: profile.host,
      port: profile.port,
      upstreamBaseUrl: profile.upstreamBaseUrl,
      upstreamModel: String(profile.upstreamModel ?? '').trim(),
      apiKeyConfigured: Boolean(profile.gatewayApiKey),
      apiKeySource: profile.gatewayApiKeySource ?? 'none',
      apiKeyPreview: maskApiKey(profile.gatewayApiKey),
      enhancementMode: profile.defaultMode,
      anchorPath: toCatalogAnchorPath(profile.anchorPaths[profile.models[0]] ?? ''),
      anchorConfigured: Boolean(profile.anchorPaths[profile.models[0]]),
      logDir: profile.logDir ?? '',
      microAnchor: publicMicroAnchorSelection(snapshot),
    }
  })
}

export function managedProfileSecrets(environment, document) {
  const normalized = normalizeManagedConfig(document)
  const snapshots = resolveModelMicroAnchorSnapshots(normalized)
  return gatewaySplitProfiles(applyManagedConfig(environment, normalized)).map((profile) => (
    attachMicroAnchorSnapshots(profile, snapshots)
  ))
}

export const MANAGED_PROFILE_NAMES = PROFILE_NAMES
export const MANAGED_ENV_FIELDS = ENV_FIELDS
