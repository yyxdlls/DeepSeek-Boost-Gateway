import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiagnosticsUrl } from '../src/gateway/diagnostic-client.mjs'

test('builds the diagnostics URL from root and /v1 Harness base URLs', () => {
  assert.equal(
    buildDiagnosticsUrl('http://127.0.0.1:8642', { limit: 5 }).toString(),
    'http://127.0.0.1:8642/__gateway/diagnostics?limit=5',
  )
  assert.equal(
    buildDiagnosticsUrl('http://127.0.0.1:8642/v1', { requestId: 'abc-123' }).toString(),
    'http://127.0.0.1:8642/__gateway/diagnostics/abc-123',
  )
})
