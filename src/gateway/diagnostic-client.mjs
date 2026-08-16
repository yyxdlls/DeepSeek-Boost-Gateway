export function buildDiagnosticsUrl(baseUrl, options = {}) {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/v1\/?$/i, '').replace(/\/$/, '')
  url.pathname = `${basePath}${options.requestId
    ? `/__gateway/diagnostics/${encodeURIComponent(options.requestId)}`
    : '/__gateway/diagnostics'}`
  if (!options.requestId) url.searchParams.set('limit', String(options.limit ?? 10))
  return url
}
