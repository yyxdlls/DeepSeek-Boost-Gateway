import { DEFAULT_ANCHOR_PATH, loadAnchorArtifact } from './anchor.mjs'
import { loadDiagnosticHistory } from './diagnostic-history.mjs'
import { createGatewayServer, listenGateway } from './proxy.mjs'
import { GATEWAY_MODELS } from './runtime-config.mjs'
import { join } from 'node:path'

const SUPPORTED_MODELS = new Set(Object.values(GATEWAY_MODELS))
const ANCHOR_ENV_BY_MODEL = Object.freeze({
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

export async function loadProfileAnchors(profile) {
  const anchors = {}
  for (const model of profile.models) {
    if (!SUPPORTED_MODELS.has(model)) {
      throw new Error(`Unsupported Gateway model: ${model}`)
    }
    if (model === GATEWAY_MODELS.pro) {
      anchors[model] = await loadModelAnchor(
        model,
        profile.anchorPaths[model] || DEFAULT_ANCHOR_PATH,
      )
    } else {
      const path = profile.anchorPaths[model]
      if (!path) {
        if (profile.defaultMode === 'bypass') continue
        throw new Error(
          `${ANCHOR_ENV_BY_MODEL[model]} is required when ${model} uses anchor mode.`,
        )
      }
      anchors[model] = await loadModelAnchor(model, path)
    }
  }
  return anchors
}

export function assertProfileMode(profile) {
  if (!['anchor', 'bypass'].includes(profile.defaultMode)) {
    throw new Error(`${profile.name} enhancement mode must be anchor or bypass.`)
  }
}

export async function startGatewayProfile(profile, options = {}) {
  assertProfileMode(profile)
  const anchors = await loadProfileAnchors(profile)
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
    anchors,
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
  })
  await listenGateway(server, profile.host, profile.port)
  return server
}
