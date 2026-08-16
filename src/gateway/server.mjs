import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AnchorJobManager } from './anchor-jobs.mjs'
import { listAnchorArtifacts } from './anchor-catalog.mjs'
import { startGatewayProfile } from './gateway-instance.mjs'
import { GatewayRuntime } from './gateway-runtime.mjs'
import { loadLocalEnv } from './load-env.mjs'
import {
  DEFAULT_MANAGED_CONFIG_PATH,
  loadManagedConfig,
} from './managed-config.mjs'
import { createGatewayManagementServer } from './management-server.mjs'
import { listenGateway } from './proxy.mjs'
import {
  removeGatewayPidFile,
  writeGatewayPidFile,
} from './pid-file.mjs'
import {
  gatewayManagementConfig,
  gatewayRuntimeProfiles,
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

const deploymentMode = process.env.GATEWAY_INSTANCE_MODE ?? 'single'
const instanceId = randomUUID()
const dataServers = []
let managementServer = null
let runtime = null
let anchorJobs = null
let healthUrl = null

try {
  if (deploymentMode === 'split') {
    const managedDocument = await loadManagedConfig(DEFAULT_MANAGED_CONFIG_PATH)
    runtime = new GatewayRuntime({
      environment: process.env,
      document: managedDocument,
      configPath: DEFAULT_MANAGED_CONFIG_PATH,
      version: packageMetadata.version,
      instanceId,
      dataServers,
    })
    const management = gatewayManagementConfig(process.env)
    const managementListener = `${management.host.toLowerCase()}:${management.port}`
    for (const profile of gatewayRuntimeProfiles(runtime.effectiveEnvironment())) {
      const dataListener = `${profile.host.toLowerCase()}:${profile.port}`
      if (dataListener === managementListener) {
        throw new Error(
          `Gateway profile ${profile.name} cannot share the management listener ${managementListener}.`,
        )
      }
    }

    await runtime.startAll()
    for (const server of dataServers) printDataServer(server, deploymentMode)

    anchorJobs = new AnchorJobManager({
      getProfile: (name) => runtime.secretProfile(name),
      activateAnchor: (name, path) => runtime.activateAnchor(name, path),
    })
    managementServer = createGatewayManagementServer({
      version: packageMetadata.version,
      instanceId,
      host: management.host,
      port: management.port,
      managementToken: management.managementToken,
      dataServers,
      profileViews: () => runtime.profileViews(),
      updateProfile: (name, patch) => runtime.updateProfile(name, patch),
      anchorJobs,
      listAnchors: () => listAnchorArtifacts(),
      clearDiagnostics: () => runtime.clearDiagnostics(),
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
    const [profile] = gatewayRuntimeProfiles(process.env)
    const server = await startGatewayProfile(profile, {
      version: packageMetadata.version,
      instanceId,
      deploymentMode,
      webUiEnabled: true,
      managementEnabled: true,
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
