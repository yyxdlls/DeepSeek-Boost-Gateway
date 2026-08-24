import { readdir, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadAnchorArtifact } from './anchor.mjs'
import { classifyAnchorArtifact } from './anchor-manifest.mjs'
import { summarizeMessageTrajectory } from './trajectory-stats.mjs'

export const DEFAULT_ANCHOR_DIRECTORY = resolve('anchors')

function anchorReadError(statusCode, message, type = null) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (type) error.type = type
  return error
}

function portablePath(path) {
  return path.split(sep).join('/')
}

// Job activation writes resolve()'d absolute paths; the catalog and WebUI
// speak cwd-relative `anchors/....json`. Collapse anything under cwd so a
// Windows absolute binding still selects the same catalog card.
export function toCatalogAnchorPath(value, cwd = process.cwd()) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const slash = raw.replaceAll('\\', '/')
  const absolute = resolve(cwd, slash)
  const rel = relative(cwd, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return slash
  return portablePath(rel)
}

function catalogEntry(absolutePath, loaded, classification) {
  return {
    id: loaded.id,
    path: portablePath(relative(process.cwd(), absolutePath)),
    model: loaded.artifact.source?.model ?? null,
    createdAt: loaded.artifact.createdAt ?? null,
    fingerprint: loaded.fingerprint,
    immutable: true,
    bundledDefault: classification.bundledDefault,
    copiedBaseline: false,
    derivedFrom: loaded.artifact.source?.derivedFrom ?? null,
    category: classification.category,
    displayName: classification.displayName,
    selectable: classification.selectable,
    productVisible: classification.productVisible,
  }
}

export async function scanAnchorArtifacts(options = {}) {
  const directory = options.directory ?? DEFAULT_ANCHOR_DIRECTORY
  const includeControls = options.includeControls === true
  const absoluteDirectory = resolve(directory)
  const entries = await readdir(absoluteDirectory, { withFileTypes: true })
  const artifacts = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const absolutePath = resolve(absoluteDirectory, entry.name)
    try {
      const loaded = await loadAnchorArtifact(absolutePath)
      const classification = classifyAnchorArtifact(absolutePath, loaded.artifact)
      if (classification.excluded) continue
      if (!includeControls && classification.category === 'control') continue
      artifacts.push(catalogEntry(absolutePath, loaded, classification))
    } catch {
      // Invalid or partial artifacts are not offered as selectable bindings.
    }
  }

  return artifacts.sort((left, right) =>
    String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) ||
    left.id.localeCompare(right.id),
  )
}

export async function listAnchorArtifacts(directory = DEFAULT_ANCHOR_DIRECTORY) {
  return scanAnchorArtifacts({ directory, includeControls: false })
}

// Rejects absolute paths, drive letters, UNC prefixes, `..` traversal and
// control characters before the path is ever resolved against the filesystem.
function normalizeRequestedPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) throw anchorReadError(400, 'Anchor content path is required.')
  if (/[\u0000-\u001f]/.test(raw)) {
    throw anchorReadError(400, 'Anchor content path contains invalid control characters.')
  }
  const normalized = raw.replaceAll('\\', '/')
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw anchorReadError(400, 'Anchor content path must be relative to the anchors directory.')
  }
  if (normalized.split('/').includes('..')) {
    throw anchorReadError(400, 'Anchor content path must not traverse outside the anchors directory.')
  }
  return normalized.replace(/^\.\//, '')
}

// Shared path/id → catalog entry resolution between the read-only content API
// and the delete API. Same safety rules for both: relative paths, no `..`,
// no absolute/UNC/drive-letter forms, and only top-level entries of the
// anchors directory (subdirectories such as `anchors/legacy/` are never
// scanned and therefore never resolvable here).
async function resolveAnchorArtifactEntry(input, directory) {
  const requestedPath = typeof input?.path === 'string' && input.path.trim()
    ? input.path.trim()
    : null
  const requestedId = typeof input?.id === 'string' && input.id.trim()
    ? input.id.trim()
    : null
  if (!requestedPath && !requestedId) {
    throw anchorReadError(400, 'Anchor content lookup requires a path or an id.')
  }
  if (requestedPath && requestedId) {
    throw anchorReadError(400, 'Anchor content lookup accepts exactly one of path or id.')
  }

  const normalized = requestedPath ? normalizeRequestedPath(requestedPath) : null
  const absoluteDirectory = resolve(directory)
  let candidateAbsolute = null
  if (normalized) {
    const candidate = resolve(absoluteDirectory, normalized)
    if (candidate !== absoluteDirectory && !candidate.startsWith(`${absoluteDirectory}${sep}`)) {
      throw anchorReadError(400, 'Anchor content path resolves outside the anchors directory.')
    }
    candidateAbsolute = candidate
  }

  // Content API uses the full legal scan so hidden controls remain readable.
  const artifacts = await scanAnchorArtifacts({ directory, includeControls: true })
  let entry = null
  if (normalized) {
    entry = artifacts.find((artifact) =>
      artifact.path === normalized ||
      resolve(artifact.path.split('/').join(sep)) === candidateAbsolute,
    ) ?? null
  } else {
    const matches = artifacts.filter((artifact) => artifact.id === requestedId)
    if (matches.length > 1) {
      throw anchorReadError(
        400,
        `Anchor id "${requestedId}" is ambiguous; use its catalog path instead.`,
      )
    }
    entry = matches[0] ?? null
  }
  if (!entry) {
    throw anchorReadError(
      404,
      `Anchor artifact is not in the catalog: ${normalized ?? requestedId}`,
    )
  }
  return entry
}

// Mirrors the WebUI `bindingMatchesArtifact` semantics: fingerprint equality
// (when both sides carry one) wins; otherwise compare normalized paths with
// the same suffix tolerance for `anchors/...` forms rooted deeper on disk.
function catalogPath(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

export function bindingMatchesArtifact(bound, artifact) {
  if (!artifact) return false
  const boundPath = catalogPath(bound?.path)
  const artifactPath = catalogPath(artifact.path)
  return Boolean(
    bound?.fingerprint && artifact.fingerprint && bound.fingerprint === artifact.fingerprint,
  ) || Boolean(
    artifactPath && boundPath &&
    (boundPath === artifactPath || boundPath.endsWith(`/${artifactPath}`) || artifactPath.endsWith(`/${boundPath}`)),
  )
}

export function collectAnchorReferences(bindings, artifact) {
  const profiles = (Array.isArray(bindings) ? bindings : [])
    .filter((bound) => bindingMatchesArtifact(bound, artifact))
    .map((bound) => bound?.profile)
    .filter((profile) => typeof profile === 'string' && profile.length > 0)
  return [...new Set(profiles)]
}

export async function readAnchorArtifactContent(input = {}, directory = DEFAULT_ANCHOR_DIRECTORY) {
  const entry = await resolveAnchorArtifactEntry(input, directory)
  const artifactPath = resolve(entry.path.split('/').join(sep))
  let loaded
  try {
    loaded = await loadAnchorArtifact(artifactPath)
  } catch (error) {
    throw anchorReadError(
      400,
      `Anchor artifact failed validation: ${error?.message ?? String(error)}`,
    )
  }
  if (loaded.fingerprint !== entry.fingerprint) {
    throw anchorReadError(
      400,
      'Anchor artifact changed since cataloging; refusing to serve it.',
    )
  }
  const artifact = loaded.artifact
  const messages = Array.isArray(artifact.trajectory?.messages) ? artifact.trajectory.messages : []
  return {
    id: artifact.id,
    path: entry.path,
    model: artifact.source?.model ?? null,
    createdAt: artifact.createdAt ?? null,
    fingerprint: loaded.fingerprint,
    bundledDefault: entry.bundledDefault,
    category: entry.category,
    displayName: entry.displayName,
    selectable: entry.selectable,
    continuation: artifact.continuation ?? null,
    requestSettings: artifact.source?.requestSettings ?? null,
    messages,
    // Same v3 trajectory summary as request details: reasoning.cot + markers
    // for the WebUI to reuse renderMarkers / trajectoryLabel.
    trajectoryStats: summarizeMessageTrajectory(messages, 'anchor_trajectory'),
    assistantTurns: Array.isArray(artifact.trajectory?.assistantTurns)
      ? artifact.trajectory.assistantTurns
      : [],
    toolEvents: Array.isArray(artifact.trajectory?.toolEvents)
      ? artifact.trajectory.toolEvents
      : [],
    usage: artifact.trajectory?.usage ?? null,
    verification: artifact.verification ?? null,
  }
}

export async function deleteUserAnchorArtifact(
  input = {},
  directory = DEFAULT_ANCHOR_DIRECTORY,
  options = {},
) {
  const entry = await resolveAnchorArtifactEntry(input, directory)
  if (entry.category !== 'user' || entry.bundledDefault) {
    throw anchorReadError(
      409,
      'Only user-generated Anchor artifacts can be deleted.',
      'gateway_anchor_readonly',
    )
  }
  // Reference guard: still bound to a model plane → 409 with the plane names.
  // Never auto-unbind or fall back to bypass; the user must switch bindings.
  const referencedBy = collectAnchorReferences(options.bindings, entry)
  if (referencedBy.length > 0) {
    const error = anchorReadError(
      409,
      `Anchor is referenced by: ${referencedBy.join(', ')}.`,
      'gateway_anchor_in_use',
    )
    error.referencedBy = referencedBy
    throw error
  }
  const artifactPath = resolve(entry.path.split('/').join(sep))
  try {
    await unlink(artifactPath)
  } catch (error) {
    throw anchorReadError(
      500,
      `Failed to delete Anchor artifact: ${error?.message ?? String(error)}`,
    )
  }
  return {
    id: entry.id,
    path: entry.path,
    displayName: entry.displayName,
    model: entry.model,
  }
}
