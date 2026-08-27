export async function handleAnchorJobRoutes({
  request,
  response,
  pathname,
  sendJson,
  readJson,
  mutationAuthorized,
  anchorJobs,
}) {
  if (request.method === 'GET' && pathname === '/__gateway/anchors/jobs') {
    sendJson(response, 200, {
      schemaVersion: 1,
      jobs: anchorJobs?.list() ?? [],
    })
    return true
  }

  if (request.method === 'POST' && pathname === '/__gateway/anchors/jobs') {
    if (!anchorJobs) {
      sendJson(response, 501, { error: { type: 'gateway_anchor_builder_unavailable' } })
      return true
    }
    if (!mutationAuthorized(request)) {
      sendJson(response, 403, {
        error: {
          type: 'gateway_management_mutation_forbidden',
          message: 'Anchor creation requires a same-app JSON request marker.',
        },
      })
      return true
    }
    try {
      const job = anchorJobs.start(await readJson(request))
      sendJson(response, 202, { schemaVersion: 1, job })
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, {
        error: {
          type: 'gateway_anchor_job_rejected',
          message: error?.message ?? String(error),
        },
      })
    }
    return true
  }

  const anchorJobCandidateMatch = request.method === 'GET'
    ? pathname.match(/^\/__gateway\/anchors\/jobs\/([0-9a-f-]+)\/candidates\/(\d+)$/i)
    : null
  if (anchorJobCandidateMatch) {
    if (!anchorJobs?.getCandidate) {
      sendJson(response, 501, { error: { type: 'gateway_anchor_builder_unavailable' } })
      return true
    }
    try {
      const candidate = await anchorJobs.getCandidate(
        anchorJobCandidateMatch[1],
        anchorJobCandidateMatch[2],
      )
      sendJson(response, 200, { schemaVersion: 1, candidate })
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, {
        error: {
          type: 'gateway_anchor_candidate_unavailable',
          message: error?.message ?? String(error),
        },
      })
    }
    return true
  }

  const anchorJobMatch = request.method === 'GET'
    ? pathname.match(/^\/__gateway\/anchors\/jobs\/([0-9a-f-]+)$/i)
    : null
  if (anchorJobMatch) {
    const job = anchorJobs?.get(anchorJobMatch[1]) ?? null
    sendJson(
      response,
      job ? 200 : 404,
      job ?? { error: { type: 'gateway_anchor_job_not_found' } },
    )
    return true
  }

  const anchorJobActivateMatch = request.method === 'POST'
    ? pathname.match(/^\/__gateway\/anchors\/jobs\/([0-9a-f-]+)\/activate$/i)
    : null
  if (anchorJobActivateMatch) {
    if (!anchorJobs?.activate) {
      sendJson(response, 501, { error: { type: 'gateway_anchor_builder_unavailable' } })
      return true
    }
    if (!mutationAuthorized(request)) {
      sendJson(response, 403, {
        error: {
          type: 'gateway_management_mutation_forbidden',
          message: 'Anchor activation requires a same-app JSON request marker.',
        },
      })
      return true
    }
    try {
      await readJson(request)
      const job = await anchorJobs.activate(anchorJobActivateMatch[1])
      sendJson(response, 202, { schemaVersion: 1, job })
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, {
        error: {
          type: error?.statusCode === 409
            ? 'gateway_anchor_job_conflict'
            : 'gateway_anchor_job_action_rejected',
          message: error?.message ?? String(error),
        },
      })
    }
    return true
  }

  const anchorJobActionMatch = request.method === 'POST'
    ? pathname.match(/^\/__gateway\/anchors\/jobs\/([0-9a-f-]+)\/(select|discard)$/i)
    : null
  if (anchorJobActionMatch) {
    if (!anchorJobs) {
      sendJson(response, 501, { error: { type: 'gateway_anchor_builder_unavailable' } })
      return true
    }
    if (!mutationAuthorized(request)) {
      sendJson(response, 403, {
        error: {
          type: 'gateway_management_mutation_forbidden',
          message: 'Anchor selection requires a same-app JSON request marker.',
        },
      })
      return true
    }
    const [, jobId, action] = anchorJobActionMatch
    try {
      const input = await readJson(request)
      if (action === 'discard' && input.candidate !== undefined) {
        throw new Error('Discarding a job takes no candidate index.')
      }
      const job = action === 'select'
        ? await anchorJobs.select(jobId, {
            candidate: input.candidate,
            displayName: input.displayName,
            activate: input.activate,
          })
        : anchorJobs.discard(jobId)
      sendJson(response, 202, { schemaVersion: 1, job })
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, {
        error: {
          type: error?.statusCode === 409
            ? 'gateway_anchor_job_conflict'
            : error?.type === 'gateway_anchor_display_name_invalid'
              ? 'gateway_anchor_display_name_invalid'
              : 'gateway_anchor_job_action_rejected',
          message: error?.message ?? String(error),
        },
      })
    }
    return true
  }

  return false
}

export async function handleProfileProbeRoute({
  request,
  response,
  pathname,
  sendJson,
  mutationAuthorized,
  probeProfile,
}) {
  const match = request.method === 'POST'
    ? pathname.match(/^\/__gateway\/config\/profiles\/(pro|flash|vision)\/probe$/)
    : null
  if (!match) return false
  if (!probeProfile) {
    sendJson(response, 501, { error: { type: 'gateway_config_read_only' } })
    return true
  }
  if (!mutationAuthorized(request)) {
    sendJson(response, 403, {
      error: {
        type: 'gateway_management_mutation_forbidden',
        message: 'Upstream probe requires a same-app JSON request marker.',
      },
    })
    return true
  }
  try {
    const result = await probeProfile(match[1])
    sendJson(response, 200, { schemaVersion: 1, ...result })
  } catch (error) {
    sendJson(response, error?.statusCode ?? 400, {
      error: {
        type: error?.type ?? 'gateway_upstream_probe_failed',
        message: error?.message ?? String(error),
      },
    })
  }
  return true
}
