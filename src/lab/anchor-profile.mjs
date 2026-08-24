import { createHash } from 'node:crypto'
import { classifyTrajectory } from './classifier.mjs'
import {
  ARM_NAMES,
  DEFAULT_PROFILE,
  buildTrajectoryProbeRequest,
} from './profile.mjs'

function fixtureFingerprintOf(identity) {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export const ANCHOR_ID = 'dsh-minimal-two-tool-v1'
export const OPEN_WORKSTREAM_ANCHOR_ID =
  'dsh-minimal-open-workstream-pro'

export const ANCHOR_TASK = `Work only with the synthetic repository exposed by the tools.
Before answering, complete this sequence in order:
1. Make exactly one bash call to determine the repository's top-level structure and locate its README.
2. After receiving the bash result, make exactly one str_replace_editor call in a later assistant turn with command "view" to read that README by absolute path. Do not call both tools in the same assistant turn, and do not use bash to read the README contents.
3. Summarize the repository in one concise sentence.
You must use both tools. Do not create, edit, or delete files.`

export const OPEN_WORKSTREAM_ANCHOR_TASK = `Do this in order. Do not combine steps in the same turn:

1. Make exactly one bash call to find zzq_9f3k.tmp under /tmp/qxk_scratch. Use bash only to list the directory and locate the file; do not read the file with the shell.
2. After the bash result, make exactly one later str_replace_editor call with command view and the absolute path from the previous step. This file will be removed later.
3. After both tools return, handle this: an online service sees more timeouts at peak traffic, database CPU is not high, and the cache hit rate drops suddenly. From this information only, give two or three of the most likely causes, and say which you would check first and why. Think thoroughly internally; keep the visible reply short; do not call tools again.

Do not create, edit, or delete any files.`

export const OPEN_WORKSTREAM_CONTINUATION_MESSAGE = "Let's continue our work."

export const SYNTHETIC_REPOSITORY = Object.freeze({
  root: '/repo',
  documentPath: '/repo/README.md',
  bashResult: `/repo
README.md
package.json
src/`,
  readmeResult: `     1\t# Anchor Protocol Fixture
     2\t
     3\tThis synthetic repository is a deterministic protocol laboratory.
     4\tRun its local checks with npm test.`,
})

export const OPEN_WORKSTREAM_FIXTURE_ID = 'dsh-open-workstream-canonical-v2'

const OPEN_WORKSTREAM_FIXTURE_CORE = Object.freeze({
  fixtureId: OPEN_WORKSTREAM_FIXTURE_ID,
  root: '/tmp/qxk_scratch',
  documentPath: '/tmp/qxk_scratch/zzq_9f3k.tmp',
  bashResult: `/tmp/qxk_scratch
zzq_9f3k.tmp`,
  readmeResult: `     1\tok`,
})

export const OPEN_WORKSTREAM_FIXTURE_FINGERPRINT = fixtureFingerprintOf({
  fixtureId: OPEN_WORKSTREAM_FIXTURE_CORE.fixtureId,
  root: OPEN_WORKSTREAM_FIXTURE_CORE.root,
  documentPath: OPEN_WORKSTREAM_FIXTURE_CORE.documentPath,
  bashResult: OPEN_WORKSTREAM_FIXTURE_CORE.bashResult,
  readmeResult: OPEN_WORKSTREAM_FIXTURE_CORE.readmeResult,
})

export const OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY = Object.freeze({
  ...OPEN_WORKSTREAM_FIXTURE_CORE,
  fingerprint: OPEN_WORKSTREAM_FIXTURE_FINGERPRINT,
})

export function buildInitialAnchorRequest(options = {}) {
  return buildTrajectoryProbeRequest({
    arm: ARM_NAMES.dshMinimal,
    model: options.model ?? DEFAULT_PROFILE.model,
    maxTokens: options.maxTokens ?? DEFAULT_PROFILE.maxTokens,
    reasoningEffort: options.reasoningEffort ?? DEFAULT_PROFILE.reasoningEffort,
    userPrompt: options.userPrompt ?? ANCHOR_TASK,
  })
}

export function initialAnchorMessages(options = {}) {
  return structuredClone(buildInitialAnchorRequest(options).messages)
}

export function normalizeAssistantMessage(message) {
  const normalized = {
    role: 'assistant',
    content: message.content ?? '',
    // DeepSeek thinking-mode tool loops require reasoning_content to be
    // replayed alongside every assistant tool-call message. Keep an explicit
    // empty string if an upstream response omits it.
    reasoning_content: message.reasoning_content ?? '',
  }
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    normalized.tool_calls = structuredClone(message.tool_calls)
  }
  return normalized
}

function parseArguments(call) {
  try {
    const parsed = JSON.parse(call.function?.arguments ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { args: {}, valid: false }
    }
    return { args: parsed, valid: true }
  } catch {
    return { args: {}, valid: false }
  }
}

function shellAttemptIsUnsafe(command) {
  const withoutNullRedirects = command.replace(
    /(?:^|\s)\d?>\s*\/dev\/null\b/gi,
    ' ',
  )
  return /(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|truncate|tee|dd|git\s+(?:clean|reset|checkout)|npm\s+(?:install|uninstall)|pip\s+install)\b|(?:^|[^<])>{1,2}(?!>)/i.test(
    withoutNullRedirects,
  )
}

function shellReadsFixtureDocument(command, documentPath) {
  const name = documentPath.split('/').at(-1) ?? documentPath
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\b(?:cat|sed|head|tail|less|more|awk|perl|python\\d*|grep|rg)\\b[^\\r\\n;&|]*${escaped}`,
    'i',
  ).test(command)
}

export function syntheticToolResult(
  call,
  state,
  subturn,
  fixture = SYNTHETIC_REPOSITORY,
) {
  const name = call.function?.name ?? ''
  const parsed = parseArguments(call)
  const args = parsed.args
  const base = {
    callId: call.id,
    name,
    args,
    subturn,
    accepted: false,
    unsafeAttempt: false,
  }

  if (!parsed.valid) {
    return {
      event: { ...base, rejection: 'invalid-json-arguments' },
      message: {
        role: 'tool',
        tool_call_id: call.id,
        content: 'Tool arguments must be a JSON object.',
      },
    }
  }

  if (name === 'bash') {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (!command) {
      return {
        event: { ...base, rejection: 'bash-command-required' },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content: 'A non-empty bash command is required.',
        },
      }
    }
    if (shellAttemptIsUnsafe(command)) {
      return {
        event: {
          ...base,
          unsafeAttempt: true,
          rejection: 'bash-must-be-read-only',
        },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content: 'Read-only fixture: mutating shell commands are not permitted.',
        },
      }
    }
    if (shellReadsFixtureDocument(command, fixture.documentPath)) {
      return {
        event: { ...base, rejection: 'readme-must-use-editor' },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content:
            `Protocol error: use bash only to locate ${fixture.documentPath}; read its contents with str_replace_editor.`,
        },
      }
    }
    return {
      event: { ...base, accepted: true },
      message: {
        role: 'tool',
        tool_call_id: call.id,
        content: fixture.bashResult,
      },
    }
  }

  if (name === 'str_replace_editor') {
    if (!state.bashCompletedBeforeSubturn) {
      return {
        event: { ...base, rejection: 'bash-must-complete-first' },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content:
            'Protocol order error: complete the bash inspection first, then call str_replace_editor in a later assistant turn.',
        },
      }
    }
    if (args.command !== 'view') {
      return {
        event: {
          ...base,
          unsafeAttempt: true,
          rejection: 'editor-must-be-read-only-view',
        },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content: 'Read-only fixture: str_replace_editor only permits command "view".',
        },
      }
    }
    if (args.path !== fixture.documentPath) {
      return {
        event: { ...base, rejection: 'unexpected-readme-path' },
        message: {
          role: 'tool',
          tool_call_id: call.id,
          content: `File not found. The bash result located the document at ${fixture.documentPath}.`,
        },
      }
    }
    return {
      event: { ...base, accepted: true },
      message: {
        role: 'tool',
        tool_call_id: call.id,
        content: fixture.readmeResult,
      },
    }
  }

  return {
    event: { ...base, rejection: 'unknown-tool' },
    message: {
      role: 'tool',
      tool_call_id: call.id,
      content: `Unknown synthetic tool: ${name}`,
    },
  }
}

export function evaluateOpenWorkstreamCandidate(candidate) {
  // Open-workstream Anchors are complete conversations too. The continuation
  // bridge is metadata used after replay, not a reason to truncate the source
  // conversation at the second tool result.
  return evaluateAnchorCandidate(candidate)
}

export function evaluateAnchorCandidate(candidate) {
  const accepted = candidate.toolEvents.filter((event) => event.accepted)
  const bash = accepted.find((event) => event.name === 'bash')
  const editor = accepted.find(
    (event) =>
      event.name === 'str_replace_editor' && event.args.command === 'view',
  )
  const reasoningClassifications = candidate.assistantTurns.map((turn) =>
    classifyTrajectory(
      turn.reasoning,
      Boolean(String(turn.content ?? '').trim() && turn.toolNames.length > 0),
    ),
  )
  const letMeTotal = reasoningClassifications.reduce(
    (sum, classification) =>
      sum + classification.metrics.letMe + classification.metrics.letMeZh,
    0,
  )
  const unsafeAttempts = candidate.toolEvents.filter(
    (event) => event.unsafeAttempt,
  ).length
  const finalAnswer = candidate.finalAnswer ?? ''
  const firstClassification = reasoningClassifications[0] ?? null
  const acceptedToolSequence = accepted.map((event) => event.name)
  const exactAcceptedSequence =
    acceptedToolSequence.length === 2 &&
    acceptedToolSequence[0] === 'bash' &&
    acceptedToolSequence[1] === 'str_replace_editor'

  // Eligibility is deliberately protocol-only. Lexical trajectory markers
  // are observations for the user, not a product decision about anchor quality.
  const checks = {
    bashCalled: Boolean(bash),
    editorViewCalled: Boolean(editor),
    editorAfterBash:
      Boolean(bash && editor) && editor.subturn > bash.subturn,
    noUnsafeAttempts: unsafeAttempts === 0,
    exactTwoToolCalls: candidate.toolEvents.length === 2,
    exactAcceptedSequence,
    hasFinalAnswer: finalAnswer.trim().length > 0,
    completedWithinTurnLimit: candidate.stopReason === 'final-answer',
  }
  const observations = {
    firstTurnStyle: firstClassification?.label ?? 'unclassified',
    firstTurnMinimal: firstClassification?.label === 'minimal',
    letMeFree: letMeTotal === 0,
  }

  return {
    eligible: Object.values(checks).every(Boolean),
    eligibilityBasis: 'protocol-only',
    checks,
    observations,
    firstClassification,
    reasoningClassifications,
    letMeTotal,
    unsafeAttempts,
    acceptedToolSequence,
    totalToolCalls: candidate.toolEvents.length,
  }
}
