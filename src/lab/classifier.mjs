import { cotStyleFromCounts } from '../gateway/trajectory-stats.mjs'

function countMatches(text, pattern) {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].length
}

// Aligned with COT_MARKER_PROFILE v3 in src/gateway/trajectory-stats.mjs:
// a single "I'm xxxing" / 我正在 marks the gray-test chain of thought;
// collective we-need / let's wording with little "let me" marks the formal
// strong (Minimal) CoT; a large amount of "let me" marks the formal weak
// (let me) CoT.
export function classifyTrajectory(reasoning, visibleBeforeTool = false) {
  const text = String(reasoning ?? '').trim()
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const markers = {
    imIng: countMatches(text, /\bi['\u2019]m\s+[a-z]+ing\b/gi),
    imIngZh: countMatches(text, /我正在/g),
    weNeed: countMatches(text, /\bwe\s+need\b/gi),
    weNeedZh: countMatches(text, /我们需要/g),
    lets: countMatches(text, /\blet['\u2019]s\b/gi),
    letsZh: countMatches(text, /让我们/g),
    letMe: countMatches(text, /\blet\s+me\b/gi),
    letMeZh: countMatches(text, /让我(?!们)/g),
  }
  const metrics = {
    firstLine,
    chars: text.length,
    ...markers,
    markerFirstLine: /^(good|great|excellent)\.?$/i.test(firstLine.trim()),
    visibleBeforeTool: Boolean(visibleBeforeTool),
  }

  const cot = cotStyleFromCounts(markers)
  return {
    label: cot.label,
    counts: cot.counts,
    metrics,
  }
}

export function summarizeRuns(runs) {
  const labels = runs.map((run) => run.classification.label)
  const minimalRuns = labels.filter((label) => label === 'minimal').length
  const letMeRuns = labels.filter((label) => label === 'let-me').length
  const mixedRuns = labels.filter((label) => label === 'mixed').length
  const letMeTotal = runs.reduce(
    (sum, run) =>
      sum + run.classification.metrics.letMe + run.classification.metrics.letMeZh,
    0,
  )
  const toolCallRuns = runs.filter((run) => run.toolNames.length > 0).length

  return {
    diagnosticOnly: true,
    stableMinimal:
      runs.length > 0 &&
      minimalRuns === runs.length &&
      letMeTotal === 0 &&
      toolCallRuns === runs.length,
    stableLetMe:
      runs.length > 0 &&
      letMeRuns === runs.length &&
      toolCallRuns === runs.length,
    minimalRuns,
    letMeRuns,
    mixedRuns,
    toolCallRuns,
    totalRuns: runs.length,
    letMeTotal,
  }
}

export function compareArms(dshMinimalRuns, controlRuns) {
  const dshMinimal = summarizeRuns(dshMinimalRuns)
  const standardControl = summarizeRuns(controlRuns)

  let verdict = 'inconclusive'
  if (!dshMinimal.stableMinimal) {
    verdict = 'dsh-minimal-not-reproduced'
  } else if (standardControl.stableLetMe) {
    verdict = 'strict-cot-shift-observed'
  } else if (standardControl.stableMinimal) {
    verdict = 'no-arm-separation'
  } else {
    verdict = 'mixed-control-results'
  }

  return {
    diagnosticOnly: true,
    verdict,
    strictCotShiftObserved: dshMinimal.stableMinimal && standardControl.stableLetMe,
    dshMinimal,
    standardControl,
  }
}
