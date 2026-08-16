import assert from 'node:assert/strict'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RotatingJsonlWriter } from '../src/gateway/jsonl-writer.mjs'

test('serializes concurrent appends and rotates bounded JSONL files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-jsonl-test-'))
  const path = join(directory, 'traffic.jsonl')
  const writer = new RotatingJsonlWriter(path, { maxBytes: 45, maxFiles: 2 })

  await Promise.all([
    writer.append({ sequence: 1, value: 'aaaaaaaaaa' }),
    writer.append({ sequence: 2, value: 'bbbbbbbbbb' }),
    writer.append({ sequence: 3, value: 'cccccccccc' }),
  ])

  const current = JSON.parse((await readFile(path, 'utf8')).trim())
  const previous = JSON.parse((await readFile(`${path}.1`, 'utf8')).trim())
  assert.equal(current.sequence, 3)
  assert.equal(previous.sequence, 2)
  await assert.rejects(readFile(`${path}.2`, 'utf8'), { code: 'ENOENT' })
})

test('clears the active and rotated JSONL files through the writer queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-jsonl-clear-test-'))
  const path = join(directory, 'traffic.jsonl')
  const writer = new RotatingJsonlWriter(path, { maxBytes: 24, maxFiles: 3 })
  await writer.append({ id: 1, value: 'rotate-me' })
  await writer.append({ id: 2, value: 'rotate-me' })
  await writer.clear()

  for (const candidate of [path, `${path}.1`, `${path}.2`]) {
    await assert.rejects(access(candidate), /ENOENT/)
  }
})
