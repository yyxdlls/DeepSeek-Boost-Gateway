import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { TRAJECTORY_MARKER_PROFILE } from './trajectory-stats.mjs'
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
    host: options.host ?? '127.0.0.1',
    port: Number(options.port ?? 8642),
    managementToken: options.managementToken ?? '',
    dataServers: options.dataServers ?? [],
    profileViews: options.profileViews ?? (() => []),
    updateProfile: options.updateProfile ?? null,
    anchorJobs: options.anchorJobs ?? null,
    listAnchors: options.listAnchors ?? null,
    clearDiagnostics: options.clearDiagnostics ?? null,
  }
  if (!isLoopbackHost(config.host) && !config.managementToken) {
    throw new Error('A non-loopback Gateway management host requires a managementToken.')
  }

  function instances() {
    return config.dataServers.map(instanceConfig)
  }

  function publicHealth() {
    const currentInstances = instances()
    const anchors = currentInstances.flatMap((instance) =>
      (instance.anchors ?? []).map((anchor) => ({ ...anchor, profile: instance.profile })),
    )
    return {
      status: 'ok',
      processId: process.pid,
      instanceId: config.instanceId,
      version: config.version,
      deploymentMode: 'split',
      profile: 'management',
      mode: 'split',
      host: config.host,
      port: config.port,
      credentialPolicy: 'gateway-only',
      gatewayApiKeyConfigured:
        currentInstances.length > 0 &&
        currentInstances.every((instance) => instance.gatewayApiKeyConfigured),
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
        markerProfile: TRAJECTORY_MARKER_PROFILE,
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
        if (input.confirmation !== '清空全部请求') {
          sendJson(response, 400, {
            error: {
              type: 'gateway_diagnostics_confirmation_required',
              message: '必须准确输入“清空全部请求”才能删除诊断和轮转日志。',
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
        deploymentMode: 'split',
        profiles: config.profileViews().map(publicProfile),
      })
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

    const profileMatch = request.method === 'PATCH'
      ? localUrl.pathname.match(/^\/__gateway\/config\/profiles\/(pro|flash)$/)
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
        const profile = await config.updateProfile(profileMatch[1], await readJson(request))
        sendJson(response, 200, { schemaVersion: 1, profile: publicProfile(profile) })
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

    if (request.method === 'GET' && localUrl.pathname === '/__gateway/anchors/jobs') {
      sendJson(response, 200, {
        schemaVersion: 1,
        jobs: config.anchorJobs?.list() ?? [],
      })
      return
    }

    if (request.method === 'POST' && localUrl.pathname === '/__gateway/anchors/jobs') {
      if (!config.anchorJobs) {
        sendJson(response, 501, { error: { type: 'gateway_anchor_builder_unavailable' } })
        return
      }
      if (!mutationAuthorized(request)) {
        sendJson(response, 403, {
          error: {
            type: 'gateway_management_mutation_forbidden',
            message: 'Anchor creation requires a same-app JSON request marker.',
          },
        })
        return
      }
      try {
        const job = config.anchorJobs.start(await readJson(request))
        sendJson(response, 202, { schemaVersion: 1, job })
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: {
            type: 'gateway_anchor_job_rejected',
            message: error?.message ?? String(error),
          },
        })
      }
      return
    }

    const anchorJobMatch = request.method === 'GET'
      ? localUrl.pathname.match(/^\/__gateway\/anchors\/jobs\/([0-9a-f-]+)$/i)
      : null
    if (anchorJobMatch) {
      const job = config.anchorJobs?.get(anchorJobMatch[1]) ?? null
      sendJson(
        response,
        job ? 200 : 404,
        job ?? { error: { type: 'gateway_anchor_job_not_found' } },
      )
      return
    }

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
