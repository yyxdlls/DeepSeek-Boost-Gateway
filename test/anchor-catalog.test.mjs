import assert from 'node:assert/strict'
import test from 'node:test'
import { listAnchorArtifacts } from '../src/gateway/anchor-catalog.mjs'

test('lists valid bundled anchors with model-safe selectable paths', async () => {
  const anchors = await listAnchorArtifacts()
  const pro = anchors.find((anchor) => anchor.model === 'deepseek-v4-pro')
  const flash = anchors.find((anchor) => anchor.model === 'deepseek-v4-flash')

  assert.ok(pro)
  assert.ok(flash)
  assert.match(pro.path, /^anchors\/.+\.json$/)
  assert.match(flash.path, /^anchors\/.+\.json$/)
  assert.equal(flash.copiedBaseline, true)
  assert.equal(pro.bundledDefault, true)
  assert.equal(flash.bundledDefault, true)
  assert.equal(anchors.every((anchor) => anchor.immutable), true)
})
