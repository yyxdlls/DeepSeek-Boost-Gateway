import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { measureAnchorArtifact } from './anchor-metrics.mjs'

async function main() {
  const artifactPath = resolve(
    process.argv[2] ?? 'anchors/dsh-minimal-two-tool-v1.json',
  )
  const serialized = await readFile(artifactPath, 'utf8')
  const artifact = JSON.parse(serialized)
  const measurement = measureAnchorArtifact(artifact, serialized)

  process.stdout.write(
    `${JSON.stringify({ artifactPath, ...measurement }, null, 2)}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
