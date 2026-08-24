import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_MICRO_ANCHOR_CONTENT,
  BUILTIN_MICRO_ANCHOR_ID,
  BUILTIN_MICRO_ANCHOR_NAME,
  appendMicroAnchorToUserContent,
  builtinMicroAnchor,
  collectMicroAnchorReferences,
  createCustomMicroAnchor,
  deleteCustomMicroAnchor,
  microAnchorContentFingerprint,
  normalizeMicroAnchorContent,
  normalizeMicroAnchorName,
  rebuildThirdPartyUserHistory,
  resolveMicroAnchorSnapshot,
  updateCustomMicroAnchor,
} from '../src/gateway/micro-anchor.mjs'
import {
  createManagedMicroAnchor,
  deleteManagedMicroAnchor,
  emptyManagedConfig,
  updateManagedMicroAnchor,
  updateManagedProfile,
} from '../src/gateway/managed-config.mjs'

const M = BUILTIN_MICRO_ANCHOR_CONTENT

test('built-in micro-anchor id, name, and text match exactly and are read-only', () => {
  const builtin = builtinMicroAnchor()
  assert.equal(builtin.id, BUILTIN_MICRO_ANCHOR_ID)
  assert.equal(builtin.id, 'builtin:initial-work-recall-v1')
  assert.equal(builtin.name, '默认微锚点')
  assert.equal(builtin.name, BUILTIN_MICRO_ANCHOR_NAME)
  assert.equal(builtin.content, M)
  assert.equal(builtin.readonly, true)
  assert.equal(builtin.deletable, false)
})

test('custom names and content are normalized and reject illegal values', () => {
  assert.equal(normalizeMicroAnchorName('  故障排查  '), '故障排查')
  assert.equal(normalizeMicroAnchorName('\u0041\u030A'), 'Å')
  assert.throws(() => normalizeMicroAnchorName(''), /1 to 80/)
  assert.throws(() => normalizeMicroAnchorName('   '), /1 to 80/)
  assert.throws(() => normalizeMicroAnchorName('x'.repeat(81)), /1 to 80/)
  assert.throws(() => normalizeMicroAnchorName('bad\u0001name'), /control or bidirectional/)
  assert.throws(() => normalizeMicroAnchorName('bad\u202Ename'), /control or bidirectional/)

  assert.equal(normalizeMicroAnchorContent('line1\r\nline2'), 'line1\nline2')
  assert.equal(normalizeMicroAnchorContent(' keep spaces \nand lines\n'), ' keep spaces \nand lines\n')
  assert.throws(() => normalizeMicroAnchorContent('   '), /empty/)
  assert.throws(() => normalizeMicroAnchorContent('\r\n\t'), /empty/)
  assert.throws(() => normalizeMicroAnchorContent('x'.repeat(4001)), /at most 4000/)
})

test('content fingerprints are stable and independent of id', () => {
  const left = microAnchorContentFingerprint('same body')
  const right = microAnchorContentFingerprint('same body')
  assert.equal(left, right)
  assert.equal(left.length, 64)
  assert.notEqual(microAnchorContentFingerprint('same body'), microAnchorContentFingerprint('other body'))
})

test('create, copy default, update, and referenced delete conflict', () => {
  let document = updateManagedProfile(emptyManagedConfig(), 'pro', { port: 9101 })
  document = createManagedMicroAnchor(document, { name: '排查', copyFromId: BUILTIN_MICRO_ANCHOR_ID })
  const customId = Object.keys(document.microAnchors.definitions)[0]
  assert.equal(document.microAnchors.definitions[customId].content, M)

  document = updateManagedMicroAnchor(document, customId, { name: '定位', content: '先定位原因。' })
  assert.equal(document.microAnchors.definitions[customId].name, '定位')
  assert.equal(document.microAnchors.definitions[customId].content, '先定位原因。')

  document = updateManagedProfile(document, 'pro', {
    microAnchor: { enabled: true, selectedId: customId },
  })
  document = updateManagedProfile(document, 'flash', {
    microAnchor: { enabled: true, selectedId: customId },
  })
  assert.deepEqual(collectMicroAnchorReferences(document.profiles, customId), ['pro', 'flash'])
  assert.throws(
    () => deleteManagedMicroAnchor(document, customId),
    /referenced by: pro, flash/,
  )
  assert.throws(
    () => deleteManagedMicroAnchor(document, BUILTIN_MICRO_ANCHOR_ID),
    /cannot be deleted/,
  )
  assert.throws(
    () => updateManagedMicroAnchor(document, BUILTIN_MICRO_ANCHOR_ID, { name: 'nope' }),
    /cannot be edited/,
  )

  document = updateManagedProfile(document, 'pro', {
    microAnchor: { selectedId: BUILTIN_MICRO_ANCHOR_ID },
  })
  document = updateManagedProfile(document, 'flash', {
    microAnchor: { selectedId: BUILTIN_MICRO_ANCHOR_ID },
  })
  const afterDelete = deleteManagedMicroAnchor(document, customId)
  assert.equal(afterDelete.microAnchors.definitions[customId], undefined)
})

test('string user content always appends a blank line plus M', () => {
  assert.equal(appendMicroAnchorToUserContent('hello', M), `hello\n\n${M}`)
  assert.equal(appendMicroAnchorToUserContent('', M), `\n\n${M}`)
})

test('multipart user content keeps original parts and only appends a trailing text part', () => {
  const image = {
    type: 'image_url',
    image_url: {
      url: 'data:image/png;base64,abc',
      detail: 'high',
    },
  }
  const original = [{ type: 'text', text: 'see' }, image]
  const clone = structuredClone(original)
  const next = appendMicroAnchorToUserContent(original, M)
  assert.deepEqual(original, clone)
  assert.equal(next.length, 3)
  assert.deepEqual(next[0], { type: 'text', text: 'see' })
  assert.deepEqual(next[1], image)
  assert.notEqual(next[1], image)
  assert.deepEqual(next[2], { type: 'text', text: `\n\n${M}` })
  assert.equal(JSON.stringify(next[1].image_url), JSON.stringify(image.image_url))
})

test('illegal user content is rejected as a whole request when enabled', () => {
  const snapshot = resolveMicroAnchorSnapshot({}, { enabled: true, selectedId: BUILTIN_MICRO_ANCHOR_ID })
  const disabled = resolveMicroAnchorSnapshot({}, { enabled: false, selectedId: BUILTIN_MICRO_ANCHOR_ID })
  const illegal = [
    { role: 'user', content: [] },
    { role: 'user', content: null },
    { role: 'user', content: ['bare'] },
    { role: 'user', content: [['nested']] },
    { role: 'user', content: [{ text: 'no type' }] },
    { role: 'user', content: 12 },
  ]
  for (const message of illegal) {
    assert.throws(
      () => rebuildThirdPartyUserHistory([message], snapshot),
      (error) => error.type === 'gateway_micro_anchor_unsupported_user_content',
    )
    const passthrough = rebuildThirdPartyUserHistory([message], disabled)
    assert.deepEqual(passthrough.messages[0], message)
  }
})

test('every third-party user is appended and other roles stay unchanged', () => {
  const snapshot = resolveMicroAnchorSnapshot({}, { enabled: true, selectedId: BUILTIN_MICRO_ANCHOR_ID })
  const input = [
    { role: 'system', content: 'sys' },
    { role: 'developer', content: 'dev' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', content: 't1' },
    { role: 'user', content: `${M}` },
  ]
  const frozen = structuredClone(input)
  const rebuilt = rebuildThirdPartyUserHistory(input, snapshot)
  assert.deepEqual(input, frozen)
  assert.equal(rebuilt.messages[0].content, 'sys')
  assert.equal(rebuilt.messages[1].content, 'dev')
  assert.equal(rebuilt.messages[2].content, `u1\n\n${M}`)
  assert.equal(rebuilt.messages[3].content, 'a1')
  assert.equal(rebuilt.messages[4].content, 't1')
  assert.equal(rebuilt.messages[5].content, `${M}\n\n${M}`)
  assert.ok(!Object.hasOwn(rebuilt.messages[2], '_origin'))
  assert.equal(rebuilt.metrics.appliedUserMessageCount, 2)
  assert.equal(rebuilt.metrics.stringUserMessageCount, 2)
})

test('domain create/update helpers do not mutate the input definition map', () => {
  const definitions = {}
  const created = createCustomMicroAnchor(definitions, { name: '独立', content: '正文' })
  assert.deepEqual(definitions, {})
  const updated = updateCustomMicroAnchor(
    { [created.id]: created.definition },
    created.id,
    { content: '新正文' },
  )
  assert.equal(created.definition.content, '正文')
  assert.equal(updated.content, '新正文')
  deleteCustomMicroAnchor({ [created.id]: created.definition }, {}, created.id)
})
