import { loadAnchorArtifact } from './anchor.mjs'
import { loadDiagnosticHistory } from './diagnostic-history.mjs'
import { isBuiltinMicroAnchorId, isCustomMicroAnchorId } from './micro-anchor.mjs'
import { createGatewayServer, listenGateway } from './proxy.mjs'
import {
  DEFAULT_UPSTREAM_BASE_URL,
  GATEWAY_MODELS,
  warnIfUnusableGlobalUpstreamKey,
} from './runtime-config.mjs'
import { join } from 'node:path'

const SUPPORTED_MODELS = new Set(Object.values(GATEWAY_MODELS))
const ANCHOR_ENV_BY_MODEL = Object.freeze({
  [GATEWAY_MODELS.pro]: 'GATEWAY_PRO_ANCHOR_PATH',
  [GATEWAY_MODELS.flash]: 'GATEWAY_FLASH_ANCHOR_PATH',
  [GATEWAY_MODELS.vision]: 'GATEWAY_VISION_ANCHOR_PATH',
})

async function loadModelAnchor(model, path) {
  const anchor = await loadAnchorArtifact(path)
  const sourceModel = anchor.artifact.source?.model
  if (sourceModel !== model) {
    throw new Error(
      `Anchor ${anchor.id} was generated for ${sourceModel ?? '(unknown)'}, not ${model}.`,
    )
  }
  if (anchor.artifact.verification?.copiedBaseline) {
    throw new Error(
      `Anchor ${anchor.id} is a copied baseline, not a model-native generation for ${model}.`,
    )
  }
  return anchor
}

function profilePlanes(profile) {
  if (Array.isArray(profile.planes)) return profile.planes
  if (profile.planes && typeof profile.planes === 'object') return Object.values(profile.planes)
  return []
}

function planeForModel(profile, model) {
  return profilePlanes(profile).find((plane) => plane.model === model) ?? null
}

function modelDefaultMode(profile, model) {
  return planeForModel(profile, model)?.defaultMode ?? profile.defaultMode ?? 'bypass'
}

function modelHasOwnKey(profile, model) {
  const plane = planeForModel(profile, model)
  if (plane) return Boolean(plane.gatewayApiKey)
  return profile.models?.length === 1 ? Boolean(profile.gatewayApiKey) : false
}

function modelEnabled(profile, model) {
  const plane = planeForModel(profile, model)
  if (plane) return plane.enabled !== false
  return profile.enabled !== false
}

export async function loadProfileAnchors(profile) {
  const anchors = {}
  const multiModel = (profile.models?.length ?? 0) > 1
  for (const model of profile.models) {
    if (!SUPPORTED_MODELS.has(model)) {
      throw new Error(`Unsupported Gateway model: ${model}`)
    }
    const path = profile.anchorPaths?.[model] ?? planeForModel(profile, model)?.anchorPath
    if (path) {
      anchors[model] = await loadModelAnchor(model, path)
      continue
    }
    if (!modelEnabled(profile, model)) continue
    if (multiModel && !modelHasOwnKey(profile, model)) continue
    if (modelDefaultMode(profile, model) === 'bypass') continue
    throw new Error(
      `${ANCHOR_ENV_BY_MODEL[model]} is required when ${model} uses anchor mode.`,
    )
  }
  return anchors
}

export function assertProfileMicroAnchors(profile) {
  for (const model of profile.models ?? []) {
    const snapshot = profile.microAnchors?.[model]
    if (!snapshot) continue
    if (snapshot.id && !isBuiltinMicroAnchorId(snapshot.id) && !isCustomMicroAnchorId(snapshot.id)) {
      throw new Error(`${profile.name} micro-anchor selectedId for ${model} is invalid.`)
    }
    if (snapshot.enabled && !snapshot.id) {
      throw new Error(`${profile.name} has an enabled micro-anchor without a selectedId for ${model}.`)
    }
    if (snapshot.enabled && !snapshot.content) {
      throw new Error(`${profile.name} micro-anchor content for ${model} is missing.`)
    }
  }
}

export function assertProfileMode(profile) {
  const planes = profilePlanes(profile)
  if (planes.length > 0) {
    for (const plane of planes) {
      if (!['anchor', 'bypass'].includes(plane.defaultMode)) {
        throw new Error(`${plane.name} enhancement mode must be anchor or bypass.`)
      }
    }
    return
  }
  if (!['anchor', 'bypass'].includes(profile.defaultMode)) {
    throw new Error(`${profile.name} enhancement mode must be anchor or bypass.`)
  }
}

export function buildModelPlanes(profile, anchors = {}) {
  const planes = profilePlanes(profile)
  if (planes.length > 0) {
    return planes.map((plane) => ({
      ...plane,
      upstreamBaseUrl: plane.upstreamBaseUrl || DEFAULT_UPSTREAM_BASE_URL,
      anchors: anchors[plane.model] ? { [plane.model]: anchors[plane.model] } : {},
      microAnchors: {
        [plane.model]: profile.microAnchors?.[plane.model] ?? { enabled: false },
      },
    }))
  }
  return (profile.models ?? []).map((model) => ({
    name: profile.name,
    model,
    enabled: profile.enabled !== false,
    upstreamBaseUrl: profile.upstreamBaseUrl || DEFAULT_UPSTREAM_BASE_URL,
    gatewayApiKey: profile.gatewayApiKey ?? '',
    gatewayApiKeySource: profile.gatewayApiKeySource ?? (profile.gatewayApiKey ? 'profile' : 'none'),
    defaultMode: profile.defaultMode ?? 'bypass',
    anchors: anchors[model] ? { [model]: anchors[model] } : {},
    microAnchors: {
      [model]: profile.microAnchors?.[model] ?? { enabled: false },
    },
  }))
}

export async function startGatewayProfile(profile, options = {}) {
  assertProfileMode(profile)
  assertProfileMicroAnchors(profile)
  if ((profile.models?.length ?? 0) > 1) {
    warnIfUnusableGlobalUpstreamKey(options.environment ?? process.env)
  }
  const anchors = await loadProfileAnchors(profile)
  const modelPlanes = buildModelPlanes(profile, anchors)
  let diagnosticStore = options.diagnosticStore
  if (!Array.isArray(diagnosticStore) || diagnosticStore.length === 0) {
    const restored = await loadDiagnosticHistory({
      profile: profile.name,
      logFile: join(profile.logDir ?? join(process.cwd(), 'results', 'gateway'), 'traffic.jsonl'),
      limit: Number(profile.diagnosticHistoryLimit) || 100,
      maxFiles: Number(profile.logMaxFiles) || 5,
    })
    if (Array.isArray(diagnosticStore)) diagnosticStore.push(...restored)
    else diagnosticStore = restored
  }
  const server = createGatewayServer({
    instanceId: options.instanceId ?? null,
    version: options.version ?? null,
    deploymentMode: options.deploymentMode ?? 'split',
    profileName: profile.name,
    host: profile.host,
    port: profile.port,
    upstreamBaseUrl: profile.upstreamBaseUrl,
    gatewayApiKey: profile.gatewayApiKey,
    gatewayApiKeySource: profile.gatewayApiKeySource,
    managementToken: profile.managementToken,
    defaultMode: profile.defaultMode,
    allowedModels: profile.models,
    modelPlanes,
    anchors,
    microAnchors: profile.microAnchors ?? options.microAnchors ?? {},
    captureMode: profile.captureMode,
    captureLimitBytes: profile.captureLimitBytes,
    responseObservationLimitBytes: profile.responseObservationLimitBytes,
    upstreamTimeoutMs: profile.upstreamTimeoutMs,
    requestLimitBytes: profile.requestLimitBytes,
    diagnosticHistoryLimit: profile.diagnosticHistoryLimit,
    logMaxBytes: profile.logMaxBytes,
    logMaxFiles: profile.logMaxFiles,
    logDir: profile.logDir,
    webUiEnabled: options.webUiEnabled ?? false,
    managementEnabled: options.managementEnabled ?? false,
    diagnosticStore,
    onDiagnostic: options.onDiagnostic,
    deploymentView: options.deploymentView,
    updateDeployment: options.updateDeployment,
    listAnchors: options.listAnchors,
    readAnchorContent: options.readAnchorContent,
    deleteAnchor: options.deleteAnchor,
    updateProfile: options.updateProfile,
    profileViews: options.profileViews,
    anchorJobs: options.anchorJobs,
    listMicroAnchors: options.listMicroAnchors,
    createMicroAnchor: options.createMicroAnchor,
    updateMicroAnchor: options.updateMicroAnchor,
    deleteMicroAnchor: options.deleteMicroAnchor,
  })
  await listenGateway(server, profile.host, profile.port)
  return server
}
