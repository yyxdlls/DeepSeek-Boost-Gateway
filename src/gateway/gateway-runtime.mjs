import { once } from 'node:events'
import {
  applyManagedConfig,
  managedProfileSecrets,
  managedProfileViews,
  saveManagedConfig,
  updateManagedProfile,
} from './managed-config.mjs'
import { startGatewayProfile } from './gateway-instance.mjs'
import { gatewayRuntimeProfiles } from './runtime-config.mjs'

async function stopServer(server) {
  if (!server?.listening) return
  server.close()
  await once(server, 'close')
}

function sameListener(left, right) {
  return left && right &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.port === right.port
}

export class GatewayRuntime {
  constructor(options) {
    this.environment = { ...options.environment }
    this.document = options.document
    this.configPath = options.configPath
    this.version = options.version ?? null
    this.dataServers = options.dataServers ?? []
    this.diagnosticStores = new Map()
  }

  effectiveEnvironment(document = this.document) {
    return applyManagedConfig(this.environment, document)
  }

  profileSecrets(document = this.document) {
    return managedProfileSecrets(this.environment, document)
  }

  profileViews() {
    const views = managedProfileViews(this.environment, this.document)
    return views.map((view) => {
      const server = this.dataServers.find(
        (candidate) => candidate.gatewayConfig?.profile === view.name,
      )
      return {
        ...view,
        running: Boolean(server?.listening),
        loadedAnchor: server?.gatewayConfig?.anchors?.[0] ?? null,
      }
    })
  }

  secretProfile(name, document = this.document) {
    return this.profileSecrets(document).find((profile) => profile.name === name) ?? null
  }

  async startAll() {
    const profiles = gatewayRuntimeProfiles(this.effectiveEnvironment())
    for (const profile of profiles) {
      const server = await this.#start(profile)
      this.dataServers.push(server)
    }
    return this.dataServers
  }

  async updateProfile(name, patch) {
    const previousDocument = this.document
    const candidateDocument = updateManagedProfile(previousDocument, name, patch)
    // Validate the complete deployment, including duplicate listeners and the
    // requirement that at least one data profile remains enabled.
    gatewayRuntimeProfiles(this.effectiveEnvironment(candidateDocument))

    await this.#reconfigure(name, previousDocument, candidateDocument)
    try {
      await saveManagedConfig(candidateDocument, this.configPath)
      this.document = candidateDocument
    } catch (error) {
      await this.#reconfigure(name, candidateDocument, previousDocument)
      throw error
    }
    return this.profileViews().find((profile) => profile.name === name)
  }

  async activateAnchor(name, anchorPath) {
    return this.updateProfile(name, { anchorPath })
  }

  async close() {
    await Promise.all(this.dataServers.map(stopServer))
    this.dataServers.splice(0)
  }

  diagnosticStore(name) {
    if (!this.diagnosticStores.has(name)) this.diagnosticStores.set(name, [])
    return this.diagnosticStores.get(name)
  }

  async #start(profile) {
    return startGatewayProfile(profile, {
      version: this.version,
      deploymentMode: 'split',
      webUiEnabled: false,
      managementEnabled: false,
      diagnosticStore: this.diagnosticStore(profile.name),
    })
  }

  async #reconfigure(name, fromDocument, toDocument) {
    const oldProfile = this.secretProfile(name, fromDocument)
    const newProfile = this.secretProfile(name, toDocument)
    const oldServerIndex = this.dataServers.findIndex(
      (server) => server.gatewayConfig?.profile === name,
    )
    const oldServer = oldServerIndex >= 0 ? this.dataServers[oldServerIndex] : null

    if (!newProfile?.enabled) {
      await stopServer(oldServer)
      if (oldServerIndex >= 0) this.dataServers.splice(oldServerIndex, 1)
      return
    }

    if (!oldServer) {
      this.dataServers.push(await this.#start(newProfile))
      return
    }

    if (!sameListener(oldProfile, newProfile)) {
      const replacement = await this.#start(newProfile)
      await stopServer(oldServer)
      this.dataServers.splice(oldServerIndex, 1, replacement)
      return
    }

    await stopServer(oldServer)
    try {
      const replacement = await this.#start(newProfile)
      this.dataServers.splice(oldServerIndex, 1, replacement)
    } catch (error) {
      try {
        const restored = await this.#start(oldProfile)
        this.dataServers.splice(oldServerIndex, 1, restored)
      } catch (restoreError) {
        error.cause = restoreError
      }
      throw error
    }
  }
}
