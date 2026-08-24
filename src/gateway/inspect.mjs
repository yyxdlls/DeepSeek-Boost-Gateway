import { loadLocalEnv } from './load-env.mjs'
import { buildDiagnosticsUrl } from './diagnostic-client.mjs'

loadLocalEnv()

function parseArguments(argv) {
  const options = {
    baseUrl: process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8642',
    limit: 10,
    requestId: null,
    json: false,
    managementToken: process.env.GATEWAY_MANAGEMENT_TOKEN ?? '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--url') options.baseUrl = argv[++index]
    else if (argument === '--limit') options.limit = Number(argv[++index])
    else if (argument === '--id') options.requestId = argv[++index]
    else if (argument === '--json') options.json = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive integer.')
  }
  return options
}

function countList(markers = {}) {
  return Object.entries(markers)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(', ') || 'none'
}

function toolList(tools = {}) {
  return tools.names?.length ? tools.names.join(' -> ') : 'none'
}

function normalizeUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const firstNumber = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue
      const number = Number(value)
      if (Number.isFinite(number) && number >= 0) return number
    }
    return null
  }
  const input = firstNumber(usage.prompt_tokens, usage.input_tokens)
  const output = firstNumber(usage.completion_tokens, usage.output_tokens)
  const reasoning = firstNumber(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
  )
  return {
    total: firstNumber(usage.total_tokens)
      ?? (input !== null && output !== null ? input + output : null),
    input,
    output,
    reasoning,
    content: output !== null && reasoning !== null ? Math.max(0, output - reasoning) : null,
  }
}

// Human-readable token stats. The Gateway never tokenizes the replay itself:
// a summary without provider usage reports tokens=未返回 instead of a derived
// character or byte figure.
function tokenStats(summary) {
  const tokens = (summary?.tokens && typeof summary.tokens === 'object')
    ? summary.tokens
    : normalizeUsageTokens(summary?.usage)
  if (!tokens || Object.values(tokens).every((value) => value == null)) {
    return 'tokens=未返回'
  }
  const field = (value) =>
    value != null && Number.isFinite(Number(value)) ? String(Number(value)) : '未返回'
  return `tokens=total=${field(tokens.total)} input=${field(tokens.input)} output=${field(tokens.output)} reasoning=${field(tokens.reasoning)} content=${field(tokens.content)}`
}

function renderEntry(entry) {
  const response = entry.response ?? {}
  const summary = response.summary ?? {}
  const anchor = entry.transformation?.anchorHistory
  const current = summary.reasoning ?? {}
  const status = response.abortedByClient
    ? 'client-aborted'
    : response.transportError
      ? 'transport-error'
      : summary.complete
        ? 'complete'
        : response.error
          ? 'error'
          : 'incomplete'
  return [
    `${entry.requestId}  ${entry.profile ?? 'single'}  ${entry.request?.model ?? '-'}  ${entry.mode}  HTTP ${response.status ?? '-'}  ${status}  ${entry.durationMs ?? '-'}ms`,
    `  current ${tokenStats(summary)}; opening=${current.openingStyle ?? 'empty'}, markers: ${countList(current.markers)}`,
    `  current tools: ${toolList(summary.tools)}; finish=${summary.finishReasons?.join(',') || 'none'}`,
    `  anchor ${entry.transformation?.anchorId ?? 'none'}: ${anchor ? `${tokenStats(anchor)}; tools ${toolList(anchor.tools)}` : 'not injected'}`,
  ].join('\n')
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const response = await fetch(buildDiagnosticsUrl(options.baseUrl, options), {
    headers: options.managementToken
      ? { 'x-gateway-management-token': options.managementToken }
      : {},
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload?.error?.type ?? `Gateway returned HTTP ${response.status}`)
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const entries = options.requestId ? [payload] : payload.entries
  if (!entries?.length) {
    process.stdout.write('No completed Gateway requests are retained.\n')
    return
  }
  process.stdout.write(`${entries.map(renderEntry).join('\n\n')}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
