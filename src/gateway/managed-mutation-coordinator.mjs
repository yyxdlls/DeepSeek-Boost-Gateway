export function createSerialQueue() {
  let chain = Promise.resolve()
  return function enqueue(task) {
    const run = chain.then(() => task())
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export function structuredMutationError(error, fallbackType = 'gateway_managed_mutation_failed') {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  if (!wrapped.statusCode) wrapped.statusCode = error?.statusCode ?? 400
  if (!wrapped.type) wrapped.type = error?.type ?? fallbackType
  return wrapped
}

export function createManagedMutationCoordinator(options = {}) {
  const enqueue = options.enqueue ?? createSerialQueue()
  return {
    enqueue,
    async commit(work) {
      return enqueue(async () => {
        if (typeof options.assertReady === 'function') options.assertReady()
        try {
          return await work()
        } catch (error) {
          throw structuredMutationError(error)
        }
      })
    },
  }
}

export function mutationResult({
  documentView = null,
  affectedProfiles = [],
  effectiveChanged = false,
  restartRequired = false,
  pendingRestart = false,
} = {}) {
  return {
    documentView,
    affectedProfiles: [...affectedProfiles],
    effectiveChanged: Boolean(effectiveChanged),
    restartRequired: Boolean(restartRequired),
    pendingRestart: Boolean(pendingRestart),
  }
}
