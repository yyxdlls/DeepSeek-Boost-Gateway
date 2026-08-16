import { readFileSync } from 'node:fs'

const WEB_ROOT = new URL('./web/', import.meta.url)

const ASSETS = new Map([
  ['/__gateway/', {
    contentType: 'text/html; charset=utf-8',
    body: readFileSync(new URL('index.html', WEB_ROOT)),
  }],
  ['/__gateway/app.css', {
    contentType: 'text/css; charset=utf-8',
    body: readFileSync(new URL('app.css', WEB_ROOT)),
  }],
  ['/__gateway/app.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: readFileSync(new URL('app.js', WEB_ROOT)),
  }],
])

function applySecurityHeaders(response) {
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  )
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('cross-origin-resource-policy', 'same-origin')
}

export function serveWebUiRequest(request, response, pathname) {
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) return false

  if (pathname === '/' || pathname === '/__gateway') {
    response.statusCode = 302
    response.setHeader('location', '/__gateway/')
    response.setHeader('cache-control', 'no-store')
    applySecurityHeaders(response)
    response.end()
    return true
  }

  if (pathname === '/favicon.ico') {
    response.statusCode = 204
    response.setHeader('cache-control', 'public, max-age=86400')
    applySecurityHeaders(response)
    response.end()
    return true
  }

  const asset = ASSETS.get(pathname)
  if (!asset) return false

  response.statusCode = 200
  response.setHeader('content-type', asset.contentType)
  response.setHeader('content-length', asset.body.length)
  response.setHeader('cache-control', 'no-store')
  applySecurityHeaders(response)
  response.end(request.method === 'HEAD' ? undefined : asset.body)
  return true
}
