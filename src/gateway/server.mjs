import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AnchorJobManager } from './anchor-jobs.mjs'
import {
  DEFAULT_ANCHOR_DIRECTORY,
  deleteUserAnchorArtifact,
  listAnchorArtifacts,
  readAnchorArtifactContent,
} from './anchor-catalog.mjs'
import {
  buildModelPlanes,
  loadProfileAnchors,
  startGatewayProfile,
} from './gateway-instance.mjs'
import { GatewayRuntime } from './gateway-runtime.mjs'
import { loadLocalEnv } from './load-env.mjs'
import {
  DEFAULT_MANAGED_CONFIG_PATH,
  applyManagedConfig,
  attachMicroAnchorSnapshots,
  createManagedMicroAnchor,
  deleteManagedMicroAnchor,
  effectiveMicroAnchorFingerprint,
  loadManagedConfig,
  managedDeploymentView,
  managedDocumentView,
  managedMicroAnchorView,
  managedProfileSecrets,
  managedProfileViews,
  resolveModelMicroAnchorSnapshots,
  saveManagedConfig,
  updateManagedDeployment,
  updateManagedMicroAnchor,
  updateManagedProfile,
} from './managed-config.mjs'
import {
  createManagedMutationCoordinator,
  mutationResult,
} from './managed-mutation-coordinator.mjs'
import { createGatewayManagementServer } from './management-server.mjs'
import { listenGateway } from './proxy.mjs'
import {
  removeGatewayPidFile,
  writeGatewayPidFile,
} from './pid-file.mjs'
import {
  gatewayCombinedProfile,
  gatewayManagementConfig,
  gatewayModelPlanes,
  gatewayRuntimeProfiles,
  validateGatewayDeployment,
} from './runtime-config.mjs'

loadLocalEnv()

const packageMetadata = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
)

function browserHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

// Collects the model planes that currently reference an Anchor file so
// deletion can 409 instead of leaving a dangling binding. Bindings come from
// the live managed profile view (configured anchorPath + loaded anchor) —
// no new global state.
function anchorBindingsFromViews(views) {
  const bindings = []
  for (const view of Array.isArray(views) ? views : []) {
    if (!view) continue
    const loaded = view.loadedAnchor ?? null
    const path = loaded?.path ?? view.anchorPath ?? null
    const fingerprint = loaded?.fingerprint ?? null
    if (!path && !fingerprint) continue
    bindings.push({ profile: view.name, path, fingerprint })
  }
  return bindings
}

function printDataServer(server, deploymentMode) {
  const address = server.address()
  process.stdout.write(`${JSON.stringify({
    event: 'gateway-data-listening',
    deploymentMode,
    profile: server.gatewayConfig.profile,
    models: server.gatewayConfig.models,
    baseUrl: `http://${browserHost(address.address)}:${address.port}/v1`,
    ...server.gatewayConfig,
  }, null, 2)}\n`)
}

let managedDocument = await loadManagedConfig(DEFAULT_MANAGED_CONFIG_PATH)
const effectiveEnvironment = applyManagedConfig(process.env, managedDocument)
const deploymentMode = effectiveEnvironment.GATEWAY_INSTANCE_MODE ?? 'single'
validateGatewayDeployment(effectiveEnvironment)
const instanceId = randomUUID()
const dataServers = []
let managementServer = null
let runtime = null
let anchorJobs = null
let healthUrl = null

try {
  if (['split', 'all'].includes(deploymentMode)) {
    runtime = new GatewayRuntime({
      environment: process.env,
      document: managedDocument,
      configPath: DEFAULT_MANAGED_CONFIG_PATH,
      version: packageMetadata.version,
      instanceId,
      dataServers,
    })
    const runtimeEnvironment = runtime.effectiveEnvironment()
    const management = gatewayManagementConfig(runtimeEnvironment)
    const managementListener = `${management.host.toLowerCase()}:${management.port}`
    const splitProfiles = gatewayRuntimeProfiles(runtimeEnvironment)
    const combinedProfile = deploymentMode === 'all'
      ? gatewayCombinedProfile(runtimeEnvironment)
      : null
    const listeners = new Set([managementListener])
    for (const profile of [...splitProfiles, ...(combinedProfile ? [combinedProfile] : [])]) {
      const dataListener = `${profile.host.toLowerCase()}:${profile.port}`
      if (listeners.has(dataListener)) {
        throw new Error(
          `Gateway profile ${profile.name} cannot share listener ${dataListener}.`,
        )
      }
      listeners.add(dataListener)
    }

    await runtime.startAll()
    for (const server of dataServers) printDataServer(server, deploymentMode)

    anchorJobs = new AnchorJobManager({
      getProfile: (name) => runtime.secretProfile(name),
      activateAnchor: (name, path, options) => runtime.activateAnchor(name, path, options),
    })
    managementServer = createGatewayManagementServer({
      version: packageMetadata.version,
      instanceId,
      host: management.host,
      port: management.port,
      managementToken: management.managementToken,
      deploymentMode,
      dataServers,
      profileViews: () => runtime.profileViews(),
      updateProfile: (name, patch) => runtime.updateProfile(name, patch),
      deploymentView: () => runtime.deploymentView(),
      updateDeployment: (patch) => runtime.updateDeployment(patch),
      anchorJobs,
      listAnchors: () => listAnchorArtifacts(),
      readAnchorContent: (input) => readAnchorArtifactContent(input),
      deleteAnchor: (input) => deleteUserAnchorArtifact(input, DEFAULT_ANCHOR_DIRECTORY, {
        bindings: anchorBindingsFromViews(runtime.profileViews()),
      }),
      clearDiagnostics: () => runtime.clearDiagnostics(),
      listMicroAnchors: () => managedMicroAnchorView(runtime.document),
      createMicroAnchor: (input) => runtime.createMicroAnchor(input),
      updateMicroAnchor: (id, patch) => runtime.updateMicroAnchor(id, patch),
      deleteMicroAnchor: (id) => runtime.deleteMicroAnchor(id),
    })
    const address = await listenGateway(managementServer, management.host, management.port)
    healthUrl = `http://${browserHost(address.address)}:${address.port}/__gateway/health`
    process.stdout.write(`${JSON.stringify({
      event: 'gateway-management-listening',
      deploymentMode,
      webUiUrl: `http://${browserHost(address.address)}:${address.port}/`,
      healthUrl: `http://${browserHost(address.address)}:${address.port}/__gateway/health`,
      instances: dataServers.map((dataServer) => ({
        profile: dataServer.gatewayConfig.profile,
        baseUrl: `http://${browserHost(dataServer.gatewayConfig.host)}:${dataServer.gatewayConfig.port}/v1`,
      })),
    }, null, 2)}\n`)
  } else {
    const coordinator = createManagedMutationCoordinator()
    const profileGenerations = { pro: 0, flash: 0, vision: 0 }
    const fingerprintMap = (document) => {
      const snapshots = resolveModelMicroAnchorSnapshots(document)
      return Object.fromEntries(
        Object.entries(snapshots).map(([model, snapshot]) => [
          model,
          `${Boolean(snapshot.enabled)}:${effectiveMicroAnchorFingerprint(snapshot)}`,
        ]),
      )
    }
    const affectedPlaneNames = (fromDocument, toDocument) => {
      const previous = fingerprintMap(fromDocument)
      const next = fingerprintMap(toDocument)
      const previousPlanes = new Map(
        gatewayModelPlanes(applyManagedConfig(process.env, fromDocument)).map((plane) => [plane.name, plane]),
      )
      const nextPlanes = new Map(
        gatewayModelPlanes(applyManagedConfig(process.env, toDocument)).map((plane) => [plane.name, plane]),
      )
      return ['pro', 'flash', 'vision'].filter((name) => {
        const left = previousPlanes.get(name)
        const right = nextPlanes.get(name)
        if (JSON.stringify(left) !== JSON.stringify(right)) return true
        const leftModel = left?.model
        const rightModel = right?.model
        return previous[leftModel] !== next[rightModel]
      })
    }
    async function materializePlane(document, name) {
      const env = applyManagedConfig(process.env, document)
      const planeSpec = gatewayModelPlanes(env).find((item) => item.name === name)
      if (!planeSpec) throw new Error(`Unknown Gateway profile: ${name}`)
      const profile = attachMicroAnchorSnapshots({
        name: planeSpec.name,
        models: [planeSpec.model],
        defaultMode: planeSpec.defaultMode,
        planes: [planeSpec],
        anchorPaths: { [planeSpec.model]: planeSpec.anchorPath },
        gatewayApiKey: planeSpec.gatewayApiKey,
      }, resolveModelMicroAnchorSnapshots(document))
      const anchors = await loadProfileAnchors(profile)
      return buildModelPlanes(profile, anchors)[0]
    }
    const mutateSingleDocument = async (mutator, options = {}) => coordinator.commit(async () => {
      const previous = managedDocument
      const candidate = mutator(previous)
      validateGatewayDeployment(applyManagedConfig(process.env, candidate))
      const affected = options.affectedNames
        ?? affectedPlaneNames(previous, candidate)
      const planes = []
      for (const name of affected) planes.push(await materializePlane(candidate, name))
      const previousFingerprints = fingerprintMap(previous)
      const nextFingerprints = fingerprintMap(candidate)
      const effectiveChanged = JSON.stringify(previousFingerprints) !== JSON.stringify(nextFingerprints)
        || affected.length > 0
      await saveManagedConfig(candidate, DEFAULT_MANAGED_CONFIG_PATH, process.env)
      managedDocument = candidate
      for (const plane of planes) dataServers[0]?.replacePlane(plane)
      for (const name of affected) {
        if (name in profileGenerations) profileGenerations[name] += 1
      }
      return mutationResult({
        documentView: managedDocumentView(process.env, managedDocument),
        affectedProfiles: affected,
        effectiveChanged,
        restartRequired: false,
        pendingRestart: false,
      })
    })
    const [baseProfile] = gatewayRuntimeProfiles(effectiveEnvironment)
    const profile = attachMicroAnchorSnapshots(
      baseProfile,
      resolveModelMicroAnchorSnapshots(managedDocument),
    )
    const deploymentView = () => managedDeploymentView(process.env, managedDocument)
    const updateDeployment = async (patch) => coordinator.commit(async () => {
      const next = updateManagedDeployment(managedDocument, patch, process.env)
      validateGatewayDeployment(applyManagedConfig(process.env, next))
      await saveManagedConfig(next, DEFAULT_MANAGED_CONFIG_PATH, process.env)
      managedDocument = next
      return { ...deploymentView(), restartRequired: true, pendingRestart: true }
    })
    function secretProfile(name, document = managedDocument) {
      const item = managedProfileSecrets(process.env, document).find((entry) => entry.name === name)
      if (!item) return null
      return { ...item, configGeneration: Number(profileGenerations[name] ?? 0) }
    }
    async function updateSingleProfile(name, patch, options = {}) {
      if (
        options.expectedGeneration !== undefined
        && Number(profileGenerations[name] ?? 0) !== Number(options.expectedGeneration)
      ) {
        const error = new Error('Profile configuration changed since the job started.')
        error.statusCode = 409
        error.type = 'gateway_anchor_generation_conflict'
        throw error
      }
      const result = await mutateSingleDocument(
        (document) => updateManagedProfile(document, name, patch),
        { affectedNames: [name] },
      )
      const view = managedProfileViews(process.env, managedDocument)
        .find((item) => item.name === name)
      return {
        profile: view ? { ...view, running: Boolean(dataServers[0]?.listening) } : view,
        ...result,
      }
    }
    anchorJobs = new AnchorJobManager({
      getProfile: (name) => secretProfile(name),
      activateAnchor: (name, path, options) => updateSingleProfile(
        name,
        { anchorPath: path, enhancementMode: 'anchor' },
        options,
      ),
    })
    const singleModeProfileViews = () => managedProfileViews(process.env, managedDocument).map((view) => ({
      ...view,
      running: Boolean(dataServers[0]?.listening),
      loadedAnchor: dataServers[0]?.gatewayConfig?.planes?.find((plane) => plane.name === view.name)?.anchor
        ?? dataServers[0]?.gatewayConfig?.anchors?.find((anchor) => anchor.model === view.model)
        ?? null,
    }))
    const server = await startGatewayProfile(profile, {
      version: packageMetadata.version,
      instanceId,
      deploymentMode,
      environment: effectiveEnvironment,
      webUiEnabled: true,
      managementEnabled: true,
      deploymentView,
      updateDeployment,
      listAnchors: () => listAnchorArtifacts(),
      readAnchorContent: (input) => readAnchorArtifactContent(input),
      deleteAnchor: (input) => deleteUserAnchorArtifact(input, DEFAULT_ANCHOR_DIRECTORY, {
        bindings: anchorBindingsFromViews(singleModeProfileViews()),
      }),
      updateProfile: (name, patch) => updateSingleProfile(name, patch),
      profileViews: singleModeProfileViews,
      anchorJobs,
      listMicroAnchors: () => managedMicroAnchorView(managedDocument),
      createMicroAnchor: (input) => mutateSingleDocument((document) => (
        createManagedMicroAnchor(document, input)
      )),
      updateMicroAnchor: (id, patch) => mutateSingleDocument((document) => (
        updateManagedMicroAnchor(document, id, patch)
      )),
      deleteMicroAnchor: (id) => mutateSingleDocument((document) => (
        deleteManagedMicroAnchor(document, id)
      )),
    })
    dataServers.push(server)
    printDataServer(server, deploymentMode)
    const address = server.address()
    healthUrl = `http://${browserHost(address.address)}:${address.port}/__gateway/health`
  }
  await writeGatewayPidFile({ instanceId, healthUrl })
} catch (error) {
  await anchorJobs?.close()
  await runtime?.close()
  for (const server of dataServers) server.close()
  managementServer?.close()
  throw error
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await anchorJobs?.close()
  await runtime?.close()
  if (!runtime) {
    await Promise.all(dataServers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
  if (managementServer?.listening) {
    await new Promise((resolve) => managementServer.close(resolve))
  }
  try {
    await removeGatewayPidFile(instanceId)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0))
  })
}
