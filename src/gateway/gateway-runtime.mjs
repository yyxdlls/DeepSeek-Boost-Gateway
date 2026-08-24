import {
  applyManagedConfig,
  attachMicroAnchorSnapshots,
  createManagedMicroAnchor,
  deleteManagedMicroAnchor,
  effectiveMicroAnchorFingerprint,
  managedDeploymentView,
  managedDocumentView,
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
  structuredMutationError,
} from './managed-mutation-coordinator.mjs'
import { spawnGatewayProfileProcess } from './profile-process.mjs'
import {
  gatewayCombinedProfile,
  gatewayRuntimeProfiles,
  validateGatewayDeployment,
} from './runtime-config.mjs'

async function stopServer(server) {
  if (server?.gatewayStop) {
    await server.gatewayStop()
    return
  }
  if (!server?.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function sameListener(left, right) {
  return left && right &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.port === right.port
}

function snapshotMapFingerprint(microAnchors = {}) {
  const entries = Object.entries(microAnchors).map(([model, snapshot]) => ([
    model,
    {
      enabled: Boolean(snapshot?.enabled),
      id: snapshot?.id ?? null,
      fingerprint: effectiveMicroAnchorFingerprint(snapshot),
    },
  ]))
  entries.sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify(entries)
}

function planeFingerprint(planes) {
  if (!planes) return null
  const list = Array.isArray(planes) ? planes : Object.values(planes)
  const entries = list.map((plane) => ({
    name: plane?.name ?? null,
    model: plane?.model ?? null,
    enabled: plane?.enabled !== false,
    upstreamBaseUrl: plane?.upstreamBaseUrl ?? '',
    gatewayApiKey: plane?.gatewayApiKey ?? '',
    defaultMode: plane?.defaultMode ?? null,
    anchorPath: plane?.anchorPath ?? '',
  }))
  entries.sort((left, right) => String(left.model).localeCompare(String(right.model)))
  return JSON.stringify(entries)
}

function profileSignature(profile) {
  if (!profile) return null
  return JSON.stringify({
    name: profile.name,
    enabled: profile.enabled !== false,
    host: profile.host,
    port: profile.port,
    models: profile.models,
    upstreamBaseUrl: profile.upstreamBaseUrl,
    gatewayApiKey: profile.gatewayApiKey ?? '',
    defaultMode: profile.defaultMode,
    anchorPaths: profile.anchorPaths ?? {},
    logDir: profile.logDir ?? '',
    microAnchors: snapshotMapFingerprint(profile.microAnchors),
    planes: planeFingerprint(profile.planes),
  })
}

export class GatewayRuntime {
  constructor(options) {
    this.environment = { ...options.environment }
    this.document = options.document
    this.configPath = options.configPath
    this.version = options.version ?? null
    this.instanceId = options.instanceId ?? null
    this.dataServers = options.dataServers ?? []
    this.diagnosticStores = new Map()
    this.degraded = false
    this.degradedError = null
    this.appliedMode = managedDeploymentView(this.environment, this.document).mode
    this.profileGenerations = { pro: 0, flash: 0, vision: 0 }
    this.#startProfile = options.startProfile ?? spawnGatewayProfileProcess
    this.#saveDocument = options.saveDocument ?? saveManagedConfig
    this.#coordinator = createManagedMutationCoordinator({
      assertReady: () => this.#assertReady(),
    })
  }

  #startProfile
  #saveDocument
  #coordinator

  #assertReady() {
    if (!this.degraded) return
    const error = structuredMutationError(
      new Error('Gateway runtime is degraded after a failed restore.'),
      'gateway_runtime_degraded',
    )
    error.statusCode = 409
    error.type = 'gateway_runtime_degraded'
    error.cause = this.degradedError
    throw error
  }

  effectiveEnvironment(document = this.document) {
    return applyManagedConfig(this.environment, document)
  }

  profileSecrets(document = this.document) {
    return managedProfileSecrets(this.environment, document)
  }

  runtimeProfiles(document = this.document) {
    const env = this.effectiveEnvironment(document)
    const mode = this.appliedMode ?? env.GATEWAY_INSTANCE_MODE ?? 'single'
    const snapshots = resolveModelMicroAnchorSnapshots(document)
    if (mode === 'single') {
      return gatewayRuntimeProfiles(env).map((profile) => (
        attachMicroAnchorSnapshots(profile, snapshots)
      ))
    }
    const profiles = gatewayRuntimeProfiles(env).map((profile) => (
      attachMicroAnchorSnapshots(profile, snapshots)
    ))
    if (mode === 'all') {
      profiles.push(attachMicroAnchorSnapshots(gatewayCombinedProfile(env), snapshots))
    }
    return profiles
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

  deploymentView() {
    return managedDeploymentView(this.environment, this.document)
  }

  documentView() {
    return managedDocumentView(this.environment, this.document)
  }

  async updateDeployment(patch) {
    return this.#coordinator.commit(async () => {
      const candidateDocument = updateManagedDeployment(
        this.document,
        patch,
        this.environment,
      )
      validateGatewayDeployment(this.effectiveEnvironment(candidateDocument))
      await this.#saveDocument(candidateDocument, this.configPath, this.environment)
      this.document = candidateDocument
      return {
        ...this.deploymentView(),
        restartRequired: true,
        pendingRestart: true,
      }
    })
  }

  getConfigGeneration(name) {
    return Number(this.profileGenerations[name] ?? 0)
  }

  secretProfile(name, document = this.document) {
    const profile = this.profileSecrets(document).find((item) => item.name === name)
    if (!profile) return null
    return { ...profile, configGeneration: this.getConfigGeneration(name) }
  }

  instanceProfile(name, document = this.document) {
    return this.runtimeProfiles(document).find((profile) => profile.name === name) ?? null
  }

  async startAll() {
    this.appliedMode = this.deploymentView().mode
    const profiles = this.runtimeProfiles()
    for (const profile of profiles) {
      const server = await this.#start(profile)
      this.dataServers.push(server)
    }
    return this.dataServers
  }

  async updateProfile(name, patch) {
    const result = await this.#mutateDocument(
      (document) => updateManagedProfile(document, name, patch),
    )
    return {
      ...this.profileViews().find((profile) => profile.name === name),
      ...result,
    }
  }

  async createMicroAnchor(input) {
    return this.#mutateDocument((document) => createManagedMicroAnchor(document, input))
  }

  async updateMicroAnchor(id, patch) {
    return this.#mutateDocument((document) => updateManagedMicroAnchor(document, id, patch))
  }

  async deleteMicroAnchor(id) {
    return this.#mutateDocument((document) => deleteManagedMicroAnchor(document, id))
  }

  async updateProfileMicroAnchor(name, patch) {
    return this.updateProfile(name, { microAnchor: patch })
  }

  async activateAnchor(name, anchorPath, options = {}) {
    if (
      options.expectedGeneration !== undefined &&
      this.getConfigGeneration(name) !== Number(options.expectedGeneration)
    ) {
      const error = structuredMutationError(
        new Error('Profile configuration changed since the job started.'),
        'gateway_anchor_generation_conflict',
      )
      error.statusCode = 409
      throw error
    }
    return this.updateProfile(name, { anchorPath, enhancementMode: 'anchor' })
  }

  async close() {
    await Promise.all(this.runtimeProfiles().map(async (profile) => {
      const server = this.dataServers.find(
        (candidate) => candidate.gatewayConfig?.profile === profile.name,
      )
      await stopServer(server)
    }))
    await Promise.all(this.dataServers.map(stopServer))
    this.dataServers.splice(0)
  }

  async clearDiagnostics() {
    const deleted = (await Promise.all(
      this.dataServers.map((server) => server.gatewayClearDiagnostics?.() ?? 0),
    )).reduce((sum, count) => sum + Number(count || 0), 0)
    for (const store of this.diagnosticStores.values()) store.splice(0)
    return deleted
  }

  diagnosticStore(name) {
    if (!this.diagnosticStores.has(name)) this.diagnosticStores.set(name, [])
    return this.diagnosticStores.get(name)
  }

  affectedRuntimeProfiles(fromDocument, toDocument) {
    const previous = new Map(this.runtimeProfiles(fromDocument).map((profile) => [profile.name, profile]))
    const next = new Map(this.runtimeProfiles(toDocument).map((profile) => [profile.name, profile]))
    const names = [...new Set([...previous.keys(), ...next.keys()])]
    return names.filter((name) => profileSignature(previous.get(name)) !== profileSignature(next.get(name)))
  }

  async #mutateDocument(mutator) {
    return this.#coordinator.commit(async () => {
      const previousDocument = this.document
      const candidateDocument = mutator(previousDocument)
      validateGatewayDeployment(this.effectiveEnvironment(candidateDocument))
      const affected = this.affectedRuntimeProfiles(previousDocument, candidateDocument)
      const records = []
      try {
        for (const name of this.#orderedNames(affected, candidateDocument, previousDocument)) {
          records.push(await this.#reconfigure(name, previousDocument, candidateDocument))
        }
        await this.#saveDocument(candidateDocument, this.configPath, this.environment)
        this.document = candidateDocument
        this.#bumpGenerations(affected)
      } catch (error) {
        await this.#rollback(records, error)
        throw error
      }
      const effectiveChanged = this.#effectiveChanged(previousDocument, candidateDocument, affected)
      return mutationResult({
        documentView: this.documentView(),
        affectedProfiles: affected,
        effectiveChanged,
        restartRequired: false,
        pendingRestart: false,
      })
    })
  }

  #orderedNames(names, ...documents) {
    const order = []
    for (const document of documents) {
      for (const profile of this.runtimeProfiles(document)) {
        if (names.includes(profile.name) && !order.includes(profile.name)) order.push(profile.name)
      }
    }
    for (const name of names) {
      if (!order.includes(name)) order.push(name)
    }
    return order
  }

  #bumpGenerations(affected) {
    for (const name of affected) {
      if (name === 'pro' || name === 'flash' || name === 'vision') {
        this.profileGenerations[name] = this.getConfigGeneration(name) + 1
      }
    }
  }

  #effectiveChanged(fromDocument, toDocument, affected) {
    if (affected.some((name) => name === 'combined' || ['pro', 'flash', 'vision'].includes(name))) {
      const previous = resolveModelMicroAnchorSnapshots(fromDocument)
      const next = resolveModelMicroAnchorSnapshots(toDocument)
      return Object.keys({ ...previous, ...next }).some((model) => (
        snapshotMapFingerprint({ [model]: previous[model] }) !==
        snapshotMapFingerprint({ [model]: next[model] })
      )) || affected.length > 0
    }
    return affected.length > 0
  }

  async #start(profile) {
    return this.#startProfile(profile, {
      version: this.version,
      instanceId: this.instanceId,
      deploymentMode: this.appliedMode,
      webUiEnabled: false,
      managementEnabled: false,
      diagnosticStore: this.diagnosticStore(profile.name),
    })
  }

  async #reconfigure(name, fromDocument, toDocument) {
    const oldProfile = this.instanceProfile(name, fromDocument)
    const newProfile = this.instanceProfile(name, toDocument)
    const oldServerIndex = this.dataServers.findIndex(
      (server) => server.gatewayConfig?.profile === name,
    )
    const oldServer = oldServerIndex >= 0 ? this.dataServers[oldServerIndex] : null
    const record = {
      name,
      beforeProfile: oldProfile,
      afterProfile: newProfile,
      activeState: oldServer ? 'before' : 'none',
    }

    if (!newProfile) {
      await stopServer(oldServer)
      if (oldServerIndex >= 0) this.dataServers.splice(oldServerIndex, 1)
      record.activeState = 'after'
      return record
    }

    if (!oldServer) {
      this.dataServers.push(await this.#start(newProfile))
      record.activeState = 'after'
      return record
    }

    if (!sameListener(oldProfile, newProfile)) {
      const replacement = await this.#start(newProfile)
      await stopServer(oldServer)
      this.dataServers.splice(oldServerIndex, 1, replacement)
      record.activeState = 'after'
      return record
    }

    await stopServer(oldServer)
    try {
      const replacement = await this.#start(newProfile)
      this.dataServers.splice(oldServerIndex, 1, replacement)
      record.activeState = 'after'
      return record
    } catch (error) {
      try {
        const restored = await this.#start(oldProfile)
        this.dataServers.splice(oldServerIndex, 1, restored)
        record.activeState = 'before'
      } catch (restoreError) {
        error.restoreError = restoreError
        this.degraded = true
        this.degradedError = error
        record.activeState = 'none'
      }
      throw error
    }
  }

  async #rollback(records, originalError) {
    for (const record of [...records].reverse()) {
      if (record.activeState !== 'after') continue
      try {
        await this.#restore(record)
        record.activeState = 'before'
      } catch (restoreError) {
        this.degraded = true
        this.degradedError = originalError
        if (originalError && typeof originalError === 'object') {
          originalError.restoreError = restoreError
        }
        throw originalError
      }
    }
  }

  async #restore(record) {
    const index = this.dataServers.findIndex(
      (server) => server.gatewayConfig?.profile === record.name,
    )
    const current = index >= 0 ? this.dataServers[index] : null
    if (!record.beforeProfile) {
      await stopServer(current)
      if (index >= 0) this.dataServers.splice(index, 1)
      return
    }
    if (!current) {
      this.dataServers.push(await this.#start(record.beforeProfile))
      return
    }
    await stopServer(current)
    const restored = await this.#start(record.beforeProfile)
    if (index >= 0) this.dataServers.splice(index, 1, restored)
    else this.dataServers.push(restored)
  }
}
