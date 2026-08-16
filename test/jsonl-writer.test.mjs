import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
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
