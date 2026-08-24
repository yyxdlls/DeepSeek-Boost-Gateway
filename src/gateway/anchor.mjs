import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  findAnchorManifestEntry,
  normalizeAnchorDisplayName,
} from './anchor-manifest.mjs'
import { summarizeMessageTrajectory } from './trajectory-stats.mjs'

export const DEFAULT_ANCHOR_PATH = resolve(
  'anchors',
  'deepseek-v4-pro-open-workstream-20260824101411-f2a74161.json',
)

export const ENVIRONMENT_SWITCH_MESSAGE = `The bootstrap episode above is complete.
Its synthetic repository and bootstrap tools are no longer available. Do not repeat or continue that task.
Only the tool schemas supplied with the current API request are available now.
Keep the concise think-act discipline demonstrated by the prior trajectory.
The next message contains the current Harness instructions, followed by the current conversation. Follow them for the current task.`

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function hasCompleteFinalAssistant(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false
  const last = messages.at(-1)
  return last?.role === 'assistant' && String(last.content ?? '').trim().length > 0
}

function schemaVersionOf(artifact) {
  const version = Number(artifact?.schemaVersion ?? 1)
  return Number.isSafeInteger(version) && version > 0 ? version : 1
}

function validateManifestBinding(artifact, absolutePath) {
  const entry = findAnchorManifestEntry(absolutePath)
  if (!entry) return
  const sourceModel = artifact.source?.model ?? null
  if (sourceModel !== entry.model) {
    throw new Error(
      `Manifest Anchor ${entry.id} was generated for ${entry.model}, not ${sourceModel ?? '(unknown)'}.`,
    )
  }
  if (artifact.artifactFingerprint !== entry.expectedFingerprint) {
    throw new Error(
      `Manifest Anchor fingerprint mismatch for ${entry.id}: stored=${artifact.artifactFingerprint} expected=${entry.expectedFingerprint}`,
    )
  }
}

export function validateAnchorArtifact(artifact, options = {}) {
  if (!artifact || artifact.kind !== 'deepseek-v4-anchor-artifact') {
    throw new Error('Anchor artifact kind is invalid.')
  }
  if (!Array.isArray(artifact.trajectory?.messages)) {
    throw new Error('Anchor artifact has no trajectory messages.')
  }
  if (!artifact.artifactFingerprint) {
    throw new Error('Anchor artifact has no fingerprint.')
  }
  if (artifact.verification?.copiedBaseline) {
    throw new Error('Copied baseline Anchor artifacts cannot be loaded at runtime.')
  }
  const core = structuredClone(artifact)
  const stored = core.artifactFingerprint
  delete core.artifactFingerprint
  const computed = fingerprint(core)
  if (computed !== stored) {
    throw new Error(`Anchor fingerprint mismatch: stored=${stored} computed=${computed}`)
  }
  const schemaVersion = schemaVersionOf(artifact)
  if (schemaVersion >= 2) {
    normalizeAnchorDisplayName(artifact.displayName)
    if (!hasCompleteFinalAssistant(artifact.trajectory.messages)) {
      throw new Error('v2 Anchor artifacts must end with a non-empty final assistant message.')
    }
  }
  if (options.path) validateManifestBinding(artifact, options.path)
  return artifact
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return JSON.stringify(part)
      })
      .join('\n')
  }
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

export async function loadAnchorArtifact(path = DEFAULT_ANCHOR_PATH) {
  const absolutePath = resolve(path)
  const artifact = validateAnchorArtifact(
    JSON.parse(await readFile(absolutePath, 'utf8')),
    { path: absolutePath },
  )
  return {
    path: absolutePath,
    id: artifact.id,
    fingerprint: artifact.artifactFingerprint,
    artifact,
  }
}

export function resolveContinuationBridge(artifact) {
  const stored = artifact?.continuation?.message
  if (typeof stored === 'string') return stored
  if (schemaVersionOf(artifact) >= 2) return ''
  return ENVIRONMENT_SWITCH_MESSAGE
}

function currentHarnessMessage(systemMessages, continuous = false, bridge = '') {
  const blocks = systemMessages.map((message, index) => {
    const label = message.role === 'developer' ? 'developer' : 'system'
    return `--- ${label} instruction ${index + 1} ---\n${contentToText(message.content)}`
  })
  return {
    role: 'user',
    content: `${bridge ? `${bridge}\n\n` : ''}${continuous
      ? 'Harness instructions to follow as we continue working:'
      : 'Current Harness instructions (authoritative for the current task):'}\n\n${
      blocks.length > 0 ? blocks.join('\n\n') : '(none supplied)'
    }`,
  }
}

export function applyAnchorToChatRequest(payload, loadedAnchor) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Chat Completions request must be a JSON object.')
  }
  if (!Array.isArray(payload.messages)) {
    throw new Error('Chat Completions request has no messages array.')
  }
  const artifact = loadedAnchor?.artifact ?? loadedAnchor
  validateAnchorArtifact(artifact)

  const originalMessages = structuredClone(payload.messages)
  const systemMessages = originalMessages.filter(
    (message) => message?.role === 'system' || message?.role === 'developer',
  )
  const conversationMessages = originalMessages.filter(
    (message) => message?.role !== 'system' && message?.role !== 'developer',
  )
  const anchorMessages = structuredClone(artifact.trajectory.messages)
  const transitionMessage = resolveContinuationBridge(artifact)
  const harnessMessage = currentHarnessMessage(
    systemMessages,
    artifact.continuation?.mode === 'same-active-workstream',
    transitionMessage,
  )
  const messages = [
    ...anchorMessages,
    harnessMessage,
    ...conversationMessages,
  ]

  const transformed = {
    ...structuredClone(payload),
    messages,
  }
  return {
    payload: transformed,
    metrics: {
      anchorId: artifact.id,
      anchorFingerprint: artifact.artifactFingerprint,
      anchorMessageCount: anchorMessages.length,
      anchorMessageChars: JSON.stringify(anchorMessages).length,
      anchorMessageBytes: Buffer.byteLength(JSON.stringify(anchorMessages), 'utf8'),
      anchorHistory: summarizeMessageTrajectory(anchorMessages, 'anchor_history'),
      environmentSwitchChars: transitionMessage.length,
      bridgeMessageChars: harnessMessage.content.length,
      continuationMode: artifact.continuation?.mode ?? 'completed-bootstrap',
      originalMessageCount: originalMessages.length,
      originalSystemMessageCount: systemMessages.length,
      originalSystemChars: systemMessages.reduce(
        (sum, message) => sum + contentToText(message.content).length,
        0,
      ),
      originalConversationMessageCount: conversationMessages.length,
      transformedMessageCount: messages.length,
      currentToolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      bootstrapToolsAddedToCurrentRequest: 0,
    },
  }
}
