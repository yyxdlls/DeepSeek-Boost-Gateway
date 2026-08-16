import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const artifactUrl = new URL(
  '../anchors/dsh-minimal-two-tool-v1.json',
  import.meta.url,
)
const openArtifactUrl = new URL(
  '../anchors/dsh-minimal-open-workstream-pro.json',
  import.meta.url,
)

test('frozen two-tool anchor passes independent integrity and shape checks', async () => {
  const serialized = await readFile(artifactUrl, 'utf8')
  const artifact = JSON.parse(serialized)
  const storedFingerprint = artifact.artifactFingerprint
  delete artifact.artifactFingerprint
  const computedFingerprint = createHash('sha256')
    .update(JSON.stringify(artifact))
    .digest('hex')

  assert.equal(storedFingerprint, computedFingerprint)
  assert.equal(artifact.id, 'dsh-minimal-two-tool-v1')
  assert.equal(artifact.source.model, 'deepseek-v4-pro')
  assert.equal(artifact.source.modelCapabilities.contextWindowTokens, 1_000_000)
  assert.equal(artifact.source.requestSettings.maxTokens, 384_000)
  assert.equal(artifact.bootstrap.executesHostTools, false)
  assert.equal(
    artifact.bootstrap.system,
    'You are a helpful software engineer assistant.',
  )
  assert.deepEqual(
    artifact.bootstrap.tools.map((tool) => tool.function.name),
    ['bash', 'str_replace_editor'],
  )
  assert.deepEqual(artifact.verification.acceptedToolSequence, [
    'bash',
    'str_replace_editor',
  ])
  assert.equal(artifact.verification.eligible, true)
  assert.equal(artifact.verification.totalToolCalls, 2)
  assert.equal(artifact.verification.letMeTotal, 0)
  assert.ok(Object.values(artifact.verification.checks).every(Boolean))

  const messages = artifact.trajectory.messages
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'],
  )
  for (const message of messages.filter(
    (candidate) => candidate.role === 'assistant',
  )) {
    assert.equal(typeof message.content, 'string')
    assert.equal(typeof message.reasoning_content, 'string')
  }
  const toolCalls = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? [])
  const toolResults = messages.filter((message) => message.role === 'tool')
  assert.deepEqual(
    toolCalls.map((call) => call.function.name),
    ['bash', 'str_replace_editor'],
  )
  assert.deepEqual(
    toolResults.map((message) => message.tool_call_id),
    toolCalls.map((call) => call.id),
  )
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]+/)
})

test('frozen open-workstream anchor remains unfinished and internally valid', async () => {
  const serialized = await readFile(openArtifactUrl, 'utf8')
  const artifact = JSON.parse(serialized)
  const storedFingerprint = artifact.artifactFingerprint
  delete artifact.artifactFingerprint
  const computedFingerprint = createHash('sha256')
    .update(JSON.stringify(artifact))
    .digest('hex')

  assert.equal(
    storedFingerprint,
    '63f691b0bdfdb5788cdf1bd0ee4f0bc98d0f24c7e09f492cde5eda2a61ed42df',
  )
  assert.equal(storedFingerprint, computedFingerprint)
  assert.equal(artifact.id, 'dsh-minimal-open-workstream-pro')
  assert.deepEqual(
    artifact.trajectory.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'assistant', 'tool'],
  )
  assert.equal(artifact.trajectory.messages.at(-1).role, 'tool')
  assert.equal(
    artifact.trajectory.messages
      .filter((message) => message.role === 'assistant')
      .reduce((sum, message) => sum + message.content.length, 0),
    0,
  )
  assert.match(artifact.bootstrap.task, /test your ability to investigate/)
  assert.match(artifact.continuation.message, /continue working/)
  assert.doesNotMatch(
    `${artifact.bootstrap.task}\n${artifact.continuation.message}`,
    /\b(?:phase|stage|environment|bootstrap|completed?)\b/i,
  )
  assert.equal(artifact.verification.eligible, true)
  assert.equal(artifact.verification.letMeTotal, 0)
  assert.equal(artifact.verification.checks.noFinalAnswer, true)
  assert.equal(
    artifact.verification.checks.remainsOpenAfterSecondToolResult,
    true,
  )
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]+/)
})
