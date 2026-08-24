import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { handleAnchorJobRoutes } from './management-routes.mjs'
import { COT_MARKER_PROFILE } from './trajectory-stats.mjs'
import { serveWebUiRequest } from './web-ui.mjs'

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function managementAuthorized(request, token) {
  if (!token) return true
  const supplied = String(request.headers['x-gateway-management-token'] ?? '')
  const expectedBytes = Buffer.from(token)
  const suppliedBytes = Buffer.from(supplied)
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
}

function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

async function readJson(request, limitBytes = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      const error = new Error('Management request body is too large.')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('Management request body must be valid JSON.')
    error.statusCode = 400
    throw error
  }
}

function mutationAuthorized(request) {
  return request.headers['x-gateway-management-request'] === '1' &&
    /^application\/json(?:;|$)/i.test(String(request.headers['content-type'] ?? ''))
}

function browserHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

function publicProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile
  const { apiKey: _apiKey, gatewayApiKey: _gatewayApiKey, ...safe } = profile
  return safe
}

function instanceConfig(server) {
  const config = server.gatewayConfig
  return {
    ...config,
    processId: server.childPid ?? null,
    baseUrl: `http://${browserHost(config.host)}:${config.port}/v1`,
  }
}

export function createGatewayManagementServer(options = {}) {
  const config = {
    instanceId: options.instanceId ?? null,
    version: options.version ?? null,
    deploymentMode: options.deploymentMode ?? 'split',
    host: options.host ?? '127.0.0.1',
    port: Number(options.port ?? 8642),
    managementToken: options.managementToken ?? '',
    dataServers: options.dataServers ?? [],
    profileViews: options.profileViews ?? (() => []),
    updateProfile: options.updateProfile ?? null,
    deploymentView: options.deploymentView ?? (() => ({ mode: options.deploymentMode ?? 'split', combinedPort: 8646 })),
    updateDeployment: options.updateDeployment ?? null,
    anchorJobs: options.anchorJobs ?? null,
    listAnchors: options.listAnchors ?? null,
    readAnchorContent: options.readAnchorContent ?? null,
    deleteAnchor: options.deleteAnchor ?? null,
    clearDiagnostics: options.clearDiagnostics ?? null,
    listMicroAnchors: options.listMicroAnchors ?? null,
    createMicroAnchor: options.createMicroAnchor ?? null,
    updateMicroAnchor: options.updateMicroAnchor ?? null,
    deleteMicroAnchor: options.deleteMicroAnchor ?? null,
  }
  if (!isLoopbackHost(config.host) && !config.managementToken) {
    throw new Error('A non-loopback Gateway management host requires a managementToken.')
  }

  function instances() {
    return config.dataServers.map(instanceConfig)
  }

  function publicHealth() {
    const currentInstances = instances()
    const configuredKeyCount = currentInstances.filter(
      (instance) => instance.gatewayApiKeyConfigured,
    ).length
    const anchors = currentInstances.flatMap((instance) =>
      (instance.anchors ?? []).map((anchor) => ({ ...anchor, profile: instance.profile })),
    )
    return {
      status: 'ok',
      processId: process.pid,
      instanceId: config.instanceId,
      version: config.version,
      deploymentMode: config.deploymentMode,
      profile: 'management',
      mode: config.deploymentMode,
      host: config.host,
      port: config.port,
      credentialPolicy: 'gateway-only',
      gatewayApiKeyConfigured: configuredKeyCount > 0,
      allGatewayApiKeysConfigured:
        currentInstances.length > 0 && configuredKeyCount === currentInstances.length,
      gatewayApiKeyConfiguredCount: configuredKeyCount,
      managementAuthRequired: Boolean(config.managementToken),
      diagnosticHistoryLimit: currentInstances.reduce(
        (sum, instance) => sum + Number(instance.diagnosticHistoryLimit ?? 0),
        0,
      ),
      anchors,
      instances: currentInstances,
      managedProfiles: config.profileViews().map(publicProfile),
      webUiPath: '/',
    }
  }

  function diagnostics(limit) {
    return config.dataServers
      .flatMap((dataServer) => dataServer.gatewayDiagnostics?.(limit) ?? [])
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
      .slice(0, limit)
  }

  const server = http.createServer(async (request, response) => {
    const localUrl = new URL(request.url ?? '/', 'http://gateway.management')
    if (serveWebUiRequest(request, response, localUrl.pathname)) return

    if (!managementAuthorized(request, config.managementToken)) {
      sendJson(response, 401, { error: { type: 'gateway_management_unauthorized' } })
      return
    }

    if (request.method === 'OPTIONS' && localUrl.pathname.startsWith('/__gateway/')) {
      response.statusCode = 204
      response.setHeader('allow', 'GET, PATCH, POST, DELETE, OPTIONS')
      response.end()
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/health') {
      sendJson(response, 200, publicHealth())
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/diagnostics') {
      const requestedLimit = Number(localUrl.searchParams.get('limit') ?? 100)
      const limit = Number.isSafeInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 500)
        : 100
      const entries = diagnostics(limit)
      sendJson(response, 200, {
        schemaVersion: 1,
        markerProfile: COT_MARKER_PROFILE,
        retained: config.dataServers.reduce(
          (sum, dataServer) => sum + (dataServer.gatewayDiagnostics?.(500).length ?? 0),
          0,
        ),
        entries,
      })
      return
    }

    if (request.method === 'DELETE' && localUrl.pathname === '/__gateway/diagnostics') {
      if (!config.clearDiagnostics) {
        sendJson(response, 501, { error: { type: 'gateway_diagnostics_clear_unavailable' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Clearing diagnostics requires a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const input = await readJson(request)
        if (input.confirmation !== '\u6e05\u7a7a\u5168\u90e8\u8bf7\u6c42') {
          sendJson(response, 400, {
            error: {
              type: 'gateway_diagnostics_confirmation_required',
              message: '\u5fc5\u987b\u51c6\u786e\u8f93\u5165\u201c\u6e05\u7a7a\u5168\u90e8\u8bf7\u6c42\u201d\u624d\u80fd\u5220\u9664\u8bca\u65ad\u548c\u8f6e\u8f6c\u65e5\u5fd7\u3002',
            },
          })
          return
        }
        const deleted = await config.clearDiagnostics()
        sendJson(response, 200, { schemaVersion: 1, deleted })
      } catch (error) {
        sendJson(response, 500, {
          error: {
            type: 'gateway_diagnostics_clear_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/config') {
      sendJson(response, 200, {
        schemaVersion: 1,
        deploymentMode: config.deploymentMode,
        deployment: config.deploymentView(),
        profiles: config.profileViews().map(publicProfile),
      })
      return
    }

    if (request.method === 'PATCH' && localUrl.pathname === '/__gateway/config/deployment') {
      if (!config.updateDeployment) {
        sendJson(response, 501, { error: { type: 'gateway_deployment_config_read_only' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Deployment writes require a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const deployment = await config.updateDeployment(await readJson(request))
        sendJson(response, 200, { schemaVersion: 1, deployment })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: 'gateway_deployment_update_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/micro-anchors') {
      try {
        sendJson(response, 200, {
          schemaVersion: 2,
          microAnchors: config.listMicroAnchors ? await config.listMicroAnchors() : { definitions: [], profiles: {} },
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_view_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (request.method === 'POST' && localUrl.pathname === '/__gateway/micro-anchors') {
      if (!config.createMicroAnchor) {
        sendJson(response, 501, { error: { type: 'gateway_micro_anchor_unavailable' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Micro-anchor writes require a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        sendJson(response, 200, await config.createMicroAnchor(await readJson(request)))
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_create_failed',
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    const microAnchorMatch = localUrl.pathname.match(/^\/__gateway\/micro-anchors\/([^/]+)$/)
    if (microAnchorMatch && ['PATCH', 'DELETE'].includes(request.method)) {
      const handler = request.method === 'PATCH' ? config.updateMicroAnchor : config.deleteMicroAnchor
      if (!handler) {
        sendJson(response, 501, { error: { type: 'gateway_micro_anchor_unavailable' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Micro-anchor writes require a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const id = decodeURIComponent(microAnchorMatch[1])
        const payload = await readJson(request)
        sendJson(response, 200, request.method === 'PATCH' ? await handler(id, payload) : await handler(id))
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: error?.type ?? 'gateway_micro_anchor_update_failed',
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/anchors') {
      try {
        sendJson(response, 200, {
          schemaVersion: 1,
          anchors: config.listAnchors ? await config.listAnchors() : [],
        })
      } catch (error) {
        sendJson(response, 500, {
          error: {
            type: 'gateway_anchor_catalog_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (request.method === 'DELETE' && localUrl.pathname === '/__gateway/anchors') {
      if (!config.deleteAnchor) {
        sendJson(response, 501, { error: { type: 'gateway_anchor_delete_unavailable' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Anchor deletion requires a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        // Accept exactly one of path/id, either in the JSON body or in the
        // query string; the catalog lookup enforces the exactly-one rule.
        let input = await readJson(request)
        if (!(input?.path || input?.id)) {
          const path = localUrl.searchParams.get('path')
          const id = localUrl.searchParams.get('id')
          if (path !== null || id !== null) {
            input = {
              ...(path !== null ? { path } : {}),
              ...(id !== null ? { id } : {}),
            }
          }
        }
        const deleted = await config.deleteAnchor(input)
        sendJson(response, 200, {
          schemaVersion: 1,
          deleted: { id: deleted.id, path: deleted.path },
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.type ?? (
              error?.statusCode === 404
                ? 'gateway_anchor_not_found'
                : 'gateway_anchor_delete_failed'
            ),
            message: error?.message ?? String(error),
            referencedBy: error?.referencedBy,
          },
        })
      }
      return
    }

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/anchors/content') {
      if (!config.readAnchorContent) {
        sendJson(response, 501, { error: { type: 'gateway_anchor_content_unavailable' } })
        return
      }
      const path = localUrl.searchParams.get('path')
      const id = localUrl.searchParams.get('id')
      try {
        sendJson(response, 200, {
          schemaVersion: 1,
          anchor: await config.readAnchorContent({
            ...(path !== null ? { path } : {}),
            ...(id !== null ? { id } : {}),
          }),
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: {
            type: error?.statusCode === 404
              ? 'gateway_anchor_not_found'
              : 'gateway_anchor_content_rejected',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    const profileMatch = request.method === 'PATCH'
      ? localUrl.pathname.match(/^\/__gateway\/config\/profiles\/(pro|flash|vision)$/)
      : null
    if (profileMatch) {
      if (!config.updateProfile) {
        sendJson(response, 501, { error: { type: 'gateway_config_read_only' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Management writes require a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const result = await config.updateProfile(profileMatch[1], await readJson(request))
        sendJson(response, 200, {
          schemaVersion: 1,
          profile: publicProfile(result?.profile ?? result),
          ...(result?.documentView ? {
            documentView: result.documentView,
            affectedProfiles: result.affectedProfiles,
            effectiveChanged: result.effectiveChanged,
            restartRequired: result.restartRequired,
            pendingRestart: result.pendingRestart,
          } : {}),
        })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: 'gateway_config_update_failed',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    if (await handleAnchorJobRoutes({
      request,
      response,
      pathname: localUrl.pathname,
      sendJson,
      readJson,
      mutationAuthorized,
      anchorJobs: config.anchorJobs,
    })) return

    const match = request.method === 'GET'
      ? localUrl.pathname.match(/^\/__gateway\/diagnostics\/([0-9a-f-]+)$/i)
      : null
    if (match) {
      const entry = diagnostics(500).find((item) => item.requestId === match[1])
      sendJson(
        response,
        entry ? 200 : 404,
        entry ?? { error: { type: 'gateway_diagnostic_not_found', request_id: match[1] } },
      )
      return
    }

    sendJson(response, 404, {
      error: {
        type: 'gateway_management_route_not_found',
        path: localUrl.pathname,
      },
    })
  })

  server.gatewayConfig = publicHealth()
  return server
}
