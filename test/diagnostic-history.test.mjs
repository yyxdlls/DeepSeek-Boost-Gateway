import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { currentInputMessages, loadDiagnosticHistory } from '../src/gateway/diagnostic-history.mjs'

function exchange(requestId, startedAt) {
  return {
    requestId,
    startedAt,
    mode: 'anchor',
    request: {
      credentialSource: 'gateway',
      summary: { model: 'deepseek-v4-pro', history: { reasoning: { chars: 10 } } },
      body: { secret: 'must not be restored' },
      rawMessages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'again' },
      ],
    },
    response: {
      status: 200,
      summary: { complete: true, usage: { prompt_cache_hit_tokens: 8 } },
      body: { reasoning_content: 'must not be restored' },
    },
  }
}

test('restores newest bounded diagnostics from rotated logs without raw bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-history-'))
  const path = join(directory, 'traffic.jsonl')
  await writeFile(`${path}.1`, `${JSON.stringify(exchange('old', '1'))}\n`, 'utf8')
  await writeFile(path, `${JSON.stringify(exchange('new-one', '2'))}\n${JSON.stringify(exchange('new-two', '3'))}\n`, 'utf8')

  const restored = await loadDiagnosticHistory({
    profile: 'pro',
    logFile: path,
    limit: 2,
    maxFiles: 3,
  })

  assert.deepEqual(restored.map((entry) => entry.requestId), ['new-one', 'new-two'])
  assert.equal(restored.every((entry) => entry.profile === 'pro'), true)
  assert.equal(JSON.stringify(restored).includes('must not be restored'), false)
  assert.deepEqual(restored[0].messages.currentInput, [{ role: 'user', content: 'again' }])
})

test('currentInputMessages keeps only the user/tool tail after the last assistant', () => {
  assert.deepEqual(currentInputMessages([
    { role: 'system', content: 'You are precise.' },
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: 'Let me check.' },
    { role: 'tool', tool_call_id: 'c1', content: 'out' },
    { role: 'user', content: 'continue' },
  ]), [
    { role: 'tool', tool_call_id: 'c1', content: 'out' },
    { role: 'user', content: 'continue' },
  ])
})

test('currentInputMessages excludes system/developer when there is no assistant', () => {
  assert.deepEqual(currentInputMessages([
    { role: 'system', content: 'sys' },
    { role: 'developer', content: 'dev' },
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 't', content: 'out' },
  ]), [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 't', content: 'out' },
  ])
})

test('currentInputMessages returns null for empty tails and malformed input', () => {
  assert.equal(currentInputMessages([{ role: 'user' }, { role: 'assistant' }]), null)
  assert.equal(currentInputMessages([]), null)
  assert.equal(currentInputMessages('x'), null)
  assert.equal(currentInputMessages(undefined), null)
})
