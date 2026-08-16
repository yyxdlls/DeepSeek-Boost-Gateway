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
    `  current reasoning=${current.chars ?? 0} chars/${current.utf8Bytes ?? 0} bytes, opening=${current.openingStyle ?? 'empty'}, markers: ${countList(current.markers)}`,
    `  current tools: ${toolList(summary.tools)}; visible=${summary.content?.chars ?? 0} chars; finish=${summary.finishReasons?.join(',') || 'none'}`,
    `  anchor ${entry.transformation?.anchorId ?? 'none'}: ${anchor ? `${anchor.reasoning.chars} reasoning chars; tools ${toolList(anchor.tools)}` : 'not injected'}`,
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
