import { classifyTrajectory } from './classifier.mjs'
import {
  ARM_NAMES,
  DEFAULT_PROFILE,
  buildTrajectoryProbeRequest,
} from './profile.mjs'

export const ANCHOR_ID = 'dsh-minimal-two-tool-v1'
export const OPEN_WORKSTREAM_ANCHOR_ID =
  'dsh-minimal-open-workstream-pro'

export const ANCHOR_TASK = `Work only with the synthetic repository exposed by the tools.
Before answering, complete this sequence in order:
1. Make exactly one bash call to determine the repository's top-level structure and locate its README.
2. After receiving the bash result, make exactly one str_replace_editor call in a later assistant turn with command "view" to read that README by absolute path. Do not call both tools in the same assistant turn, and do not use bash to read the README contents.
3. Summarize the repository in one concise sentence.
You must use both tools. Do not create, edit, or delete files.`

export const OPEN_WORKSTREAM_ANCHOR_TASK = `We have a long, interconnected software engineering problem with many different requirements involving architecture, debugging, implementation, testing, security, performance, compatibility, and release work.

First, let's test your ability to investigate this kind of problem carefully and keep several constraints in mind. Work only with the synthetic repository exposed by the tools:
1. Make exactly one bash call to inspect the repository's top-level structure and locate WORKSTREAM.md. Use bash only for structure and location; do not read that file's contents with shell commands.
2. After receiving the bash result, make exactly one str_replace_editor call in a later assistant turn with command "view" and the absolute path of WORKSTREAM.md.

Use both tools in sequence and carry what you learn into our continuing work. Do not create, edit, or delete files.`

export const OPEN_WORKSTREAM_CONTINUATION_MESSAGE = `Let's continue working on the same long, interconnected software engineering problem.
Follow the current Harness instructions below and use the tools they provide. Keep the same careful inspect-before-act approach, integrate the conversation that follows with the work already in progress, and never invent tool results.`

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

export const OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY = Object.freeze({
  root: '/repo',
  documentPath: '/repo/WORKSTREAM.md',
  bashResult: `/repo
WORKSTREAM.md
package.json
src/
test/
docs/
config/`,
  readmeResult: `     1\t# Interconnected Engineering Problem
     2\t
     3\tThe work combines several concerns that must remain consistent with one another.
     4\t
     5\t## Concerns
     6\t- architecture and cross-module invariants
     7\t- defect diagnosis and implementation changes
     8\t- tests, security, performance, and compatibility
     9\t- release readiness and operational diagnostics
    10\t
    11\t## Working discipline
    12\t- Treat new requirements as connected parts of the same overall problem.
    13\t- Preserve relevant constraints and unresolved findings while working.
    14\t- Inspect real evidence before choosing an implementation path.
    15\t- Use the currently supplied tool schemas; never invent tool results.
    16\t- Keep hidden analysis proportional to uncertainty and keep visible answers concise.
    17\t- Re-check assumptions when the repository, tool surface, or requirements change.
    18\t- Reconcile new evidence with earlier findings instead of restarting the analysis.`,
})

export function buildInitialAnchorRequest(options = {}) {
  return buildTrajectoryProbeRequest({
    arm: ARM_NAMES.dshMinimal,
    model: options.model ?? DEFAULT_PROFILE.model,
    maxTokens: options.maxTokens ?? DEFAULT_PROFILE.maxTokens,
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
    (sum, classification) => sum + classification.metrics.letMe,
    0,
  )
  const unsafeAttempts = candidate.toolEvents.filter(
    (event) => event.unsafeAttempt,
  ).length
  const acceptedToolSequence = accepted.map((event) => event.name)
  const exactAcceptedSequence =
    acceptedToolSequence.length === 2 &&
    acceptedToolSequence[0] === 'bash' &&
    acceptedToolSequence[1] === 'str_replace_editor'
  const firstClassification = reasoningClassifications[0] ?? null
  const checks = {
    bashCalled: Boolean(bash),
    editorViewCalled: Boolean(editor),
    editorAfterBash:
      Boolean(bash && editor) && editor.subturn > bash.subturn,
    noUnsafeAttempts: unsafeAttempts === 0,
    exactTwoToolCalls: candidate.toolEvents.length === 2,
    exactAcceptedSequence,
    noFinalAnswer: String(candidate.finalAnswer ?? '').trim().length === 0,
    remainsOpenAfterSecondToolResult:
      candidate.stopReason === 'open-after-second-tool-result' &&
      candidate.messages.at(-1)?.role === 'tool',
  }
  return {
    eligible: Object.values(checks).every(Boolean),
    eligibilityBasis: 'protocol-only',
    checks,
    observations: {
      firstTurnLabel: firstClassification?.label ?? 'unclassified',
      firstTurnMinimalLike: firstClassification?.label === 'minimal-like',
      letMeFree: letMeTotal === 0,
    },
    firstClassification,
    reasoningClassifications,
    letMeTotal,
    unsafeAttempts,
    acceptedToolSequence,
    totalToolCalls: candidate.toolEvents.length,
  }
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
    (sum, classification) => sum + classification.metrics.letMe,
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
    firstTurnLabel: firstClassification?.label ?? 'unclassified',
    firstTurnMinimalLike: firstClassification?.label === 'minimal-like',
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
