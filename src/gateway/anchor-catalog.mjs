import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { loadAnchorArtifact } from './anchor.mjs'

export const DEFAULT_ANCHOR_DIRECTORY = resolve('anchors')

const BUNDLED_DEFAULT_FILES = new Set([
  'dsh-minimal-open-workstream-two-tool-v2.json',
  'dsh-minimal-open-workstream-two-tool-v2-flash-copy.json',
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
