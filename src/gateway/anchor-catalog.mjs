import { readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { loadAnchorArtifact } from './anchor.mjs'

export const DEFAULT_ANCHOR_DIRECTORY = resolve('anchors')

function anchorReadError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

const BUNDLED_DEFAULT_FILES = new Set([
  'dsh-minimal-open-workstream-pro.json',
])

function portablePath(path) {
  return path.split(sep).join('/')
}

export async function listAnchorArtifacts(directory = DEFAULT_ANCHOR_DIRECTORY) {
  const absoluteDirectory = resolve(directory)
  const entries = await readdir(absoluteDirectory, { withFileTypes: true })
  const artifacts = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const absolutePath = resolve(absoluteDirectory, entry.name)
    try {
      const loaded = await loadAnchorArtifact(absolutePath)
      // Copied baselines were useful as an experiment, but must not appear as
      // selectable model-native Anchors in production configuration.
      if (loaded.artifact.verification?.copiedBaseline) continue
      artifacts.push({
        id: loaded.id,
        path: portablePath(relative(process.cwd(), absolutePath)),
        model: loaded.artifact.source?.model ?? null,
        createdAt: loaded.artifact.createdAt ?? null,
        fingerprint: loaded.fingerprint,
        immutable: true,
        bundledDefault: BUNDLED_DEFAULT_FILES.has(entry.name),
        copiedBaseline: Boolean(loaded.artifact.verification?.copiedBaseline),
        derivedFrom: loaded.artifact.source?.derivedFrom ?? null,
      })
    } catch {
      // Invalid or partial artifacts are not offered as selectable bindings.
    }
  }

  return artifacts.sort((left, right) =>
    String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) ||
    left.id.localeCompare(right.id),
  )
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

export async function readAnchorArtifactContent(input = {}, directory = DEFAULT_ANCHOR_DIRECTORY) {
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

  // Only artifacts already listed by the catalog are legal; the requested file
  // must map onto one of them exactly (same portable path or same resolved file).
  const artifacts = await listAnchorArtifacts(directory)
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
  return {
    id: artifact.id,
    path: entry.path,
    model: artifact.source?.model ?? null,
    createdAt: artifact.createdAt ?? null,
    fingerprint: loaded.fingerprint,
    bundledDefault: entry.bundledDefault,
    continuation: artifact.continuation ?? null,
    requestSettings: artifact.source?.requestSettings ?? null,
    messages: Array.isArray(artifact.trajectory?.messages) ? artifact.trajectory.messages : [],
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
