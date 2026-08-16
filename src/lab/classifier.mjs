function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length
}

export function classifyTrajectory(reasoning, visibleBeforeTool = false) {
  const text = String(reasoning ?? '').trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const metrics = {
    firstLine,
    chars: text.length,
    we: occurrences(text, /\bwe\b/gi),
    letMe: occurrences(text, /\blet me\b/gi),
    i: occurrences(text, /\bi\b/gi),
    markerFirstLine: /^(good|great|excellent)\.?$/i.test(firstLine.trim()),
    visibleBeforeTool: Boolean(visibleBeforeTool),
  }

  let score = 0
  if (/^we need\b/i.test(firstLine)) score += 3
  if (/^let me\b/i.test(firstLine)) score -= 3
  if (/^the user wants\b/i.test(firstLine)) score -= 3
  if (/^i (need|should|will)\b/i.test(firstLine)) score -= 3
  if (metrics.we > 0 && metrics.letMe === 0) score += 2
  if (metrics.letMe > 0) score -= 2
  if (metrics.markerFirstLine) score += 1
  if (metrics.visibleBeforeTool) score -= 1

  return {
    label: score >= 4 ? 'minimal-like' : score <= -4 ? 'standard-like' : 'ambiguous',
    score,
    metrics,
  }
}

export function summarizeRuns(runs) {
  const labels = runs.map((run) => run.classification.label)
  const minimalLikeRuns = labels.filter((label) => label === 'minimal-like').length
  const standardLikeRuns = labels.filter((label) => label === 'standard-like').length
  const ambiguousRuns = labels.filter((label) => label === 'ambiguous').length
  const letMeTotal = runs.reduce(
    (sum, run) => sum + run.classification.metrics.letMe,
    0,
  )
  const toolCallRuns = runs.filter((run) => run.toolNames.length > 0).length

  return {
    diagnosticOnly: true,
    stableMinimalLike:
      runs.length > 0 &&
      minimalLikeRuns === runs.length &&
      letMeTotal === 0 &&
      toolCallRuns === runs.length,
    stableStandardLike:
      runs.length > 0 &&
      standardLikeRuns === runs.length &&
      toolCallRuns === runs.length,
    minimalLikeRuns,
    standardLikeRuns,
    ambiguousRuns,
    toolCallRuns,
    totalRuns: runs.length,
    letMeTotal,
  }
}

export function compareArms(dshMinimalRuns, controlRuns) {
  const dshMinimal = summarizeRuns(dshMinimalRuns)
  const standardControl = summarizeRuns(controlRuns)

  let verdict = 'inconclusive'
  if (!dshMinimal.stableMinimalLike) {
    verdict = 'dsh-minimal-not-reproduced'
  } else if (standardControl.stableStandardLike) {
    verdict = 'strict-trajectory-shift-observed'
  } else if (standardControl.stableMinimalLike) {
    verdict = 'no-arm-separation'
  } else {
    verdict = 'mixed-control-results'
  }

  return {
    diagnosticOnly: true,
    verdict,
    strictTrajectoryShiftObserved:
      dshMinimal.stableMinimalLike && standardControl.stableStandardLike,
    dshMinimal,
    standardControl,
  }
}
