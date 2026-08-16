import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { measureAnchorArtifact } from '../src/lab/anchor-metrics.mjs'

const artifactUrl = new URL(
  '../anchors/dsh-minimal-two-tool-v1.json',
  import.meta.url,
)

test('reports exact anchor sizes without pretending to know replay tokens', async () => {
  const serialized = await readFile(artifactUrl, 'utf8')
  const artifact = JSON.parse(serialized)
  const metrics = measureAnchorArtifact(artifact, serialized)

  assert.equal(metrics.anchorId, 'dsh-minimal-two-tool-v1')
  assert.equal(metrics.integrity.matches, true)
  assert.equal(
    metrics.file.formattedJsonBytes,
    Buffer.byteLength(serialized, 'utf8'),
  )
  assert.ok(metrics.file.formattedJsonBytes > metrics.file.compactJsonBytes)
  assert.ok(metrics.replayBundle.canonicalBundleJsonBytes > 0)
  assert.equal(metrics.replayBundle.exactProviderReplayTokens, null)
  assert.match(metrics.replayBundle.tokenCountStatus, /provider tokenizer/)
  assert.equal(
    metrics.interpretation.providerReportedBuildUsageIsReplayLength,
    false,
  )
})

test('breaks the frozen trajectory length down by assistant subturn', async () => {
  const serialized = await readFile(artifactUrl, 'utf8')
  const artifact = JSON.parse(serialized)
  const metrics = measureAnchorArtifact(artifact, serialized)

  assert.equal(metrics.trajectory.messages, 7)
  assert.equal(metrics.trajectory.assistantSubturns, 3)
  assert.equal(metrics.trajectory.toolCalls, 2)
  assert.equal(metrics.trajectory.toolResults, 2)
  assert.deepEqual(metrics.trajectory.distinctTools, [
    'bash',
    'str_replace_editor',
  ])
  assert.deepEqual(
    metrics.trajectory.subturns.map((subturn) => subturn.toolCallNames),
    [['bash'], ['str_replace_editor'], []],
  )
  assert.ok(metrics.trajectory.reasoningChars > 0)
  assert.ok(metrics.trajectory.toolResultChars > 0)
  assert.equal(metrics.providerReportedBuildUsage.totalTokens, 4_993)
})
