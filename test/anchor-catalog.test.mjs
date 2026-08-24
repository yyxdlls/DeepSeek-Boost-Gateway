import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bindingMatchesArtifact,
  collectAnchorReferences,
  deleteUserAnchorArtifact,
  listAnchorArtifacts,
  readAnchorArtifactContent,
  scanAnchorArtifacts,
  toCatalogAnchorPath,
} from '../src/gateway/anchor-catalog.mjs'

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validArtifact(id, overrides = {}) {
  const core = {
    schemaVersion: 1,
    kind: 'deepseek-v4-anchor-artifact',
    id,
    createdAt: '2026-08-24T00:00:00.000Z',
    source: {
      model: 'deepseek-v4-flash-vision-exp',
      requestSettings: { reasoningEffort: 'high', maxTokens: 8192 },
    },
    trajectory: {
      selectedCandidate: 1,
      messages: [
        { role: 'user', content: 'Begin.' },
        {
          role: 'assistant',
          content: 'done',
          reasoning_content: 'We need check.',
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
      assistantTurns: [{
        subturn: 1,
        reasoning: 'We need check.',
        content: 'done',
        finishReason: 'stop',
        toolNames: [],
      }],
      toolEvents: [],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        reasoningTokens: 2,
        cacheHitTokens: 0,
        cacheMissTokens: 10,
      },
    },
    verification: { eligible: true },
    ...overrides,
  }
  return { ...core, artifactFingerprint: fingerprint(core) }
}

async function tempAnchorDirectory() {
  return mkdtemp(join(tmpdir(), 'deepseek-anchor-catalog-test-'))
}

test('offers only the Pro bundled default and never copied baselines', async () => {
  const anchors = await listAnchorArtifacts()
  const pro = anchors.find((anchor) => (
    anchor.bundledDefault && anchor.model === 'deepseek-v4-pro'
  ))
  const flash = anchors.find((anchor) => (
    anchor.bundledDefault && anchor.model === 'deepseek-v4-flash'
  ))
  const vision = anchors.find((anchor) => (
    anchor.bundledDefault && anchor.model === 'deepseek-v4-flash-vision-exp'
  ))

  assert.ok(pro)
  assert.equal(pro.model, 'deepseek-v4-pro')
  assert.equal(pro.copiedBaseline, false)
  assert.match(pro.path, /^anchors\/.+\.json$/)

  assert.ok(flash)
  assert.equal(flash.displayName, 'DeepSeek V4 Flash 默认 Anchor')
  assert.equal(flash.selectable, true)
  assert.equal(flash.copiedBaseline, false)
  assert.ok(vision)
  assert.equal(vision.displayName, 'DeepSeek V4 Flash Vision 默认 Anchor')
  assert.equal(vision.selectable, true)
  assert.equal(vision.copiedBaseline, false)
  assert.equal(anchors.some((anchor) => anchor.copiedBaseline), false)
  assert.equal(anchors.every((anchor) => anchor.immutable), true)
  assert.equal(pro.category, 'default')
  assert.equal(pro.displayName, 'DeepSeek V4 Pro 默认 Anchor')
  assert.equal(pro.selectable, true)
  assert.equal(
    anchors.some((anchor) => anchor.id === 'dsh-minimal-two-tool-v1' || anchor.category === 'control'),
    false,
  )
})

test('reads a legal Anchor read-only by path or id without any key material', async () => {
  const catalog = await listAnchorArtifacts()
  const pro = catalog.find((anchor) => (
    anchor.bundledDefault && anchor.model === 'deepseek-v4-pro'
  ))
  assert.ok(pro)

  for (const input of [{ path: pro.path }, { id: pro.id }]) {
    const content = await readAnchorArtifactContent(input)
    assert.equal(content.id, pro.id)
    assert.equal(content.path, pro.path)
    assert.equal(content.model, pro.model)
    assert.equal(content.fingerprint, pro.fingerprint)
    assert.equal(content.bundledDefault, true)
    assert.equal(content.category, 'default')
    assert.equal(content.displayName, 'DeepSeek V4 Pro 默认 Anchor')
    assert.equal(content.selectable, true)
    assert.ok(Array.isArray(content.messages))
    assert.ok(Array.isArray(content.assistantTurns))
    assert.ok(Array.isArray(content.toolEvents))
    assert.ok(content.usage)
    assert.ok(content.verification)
    // The content API serves the same v3 trajectory summary as request details.
    assert.equal(content.trajectoryStats.scope, 'anchor_trajectory')
    assert.equal(typeof content.trajectoryStats.reasoning.cot.label, 'string')
    assert.ok(content.trajectoryStats.reasoning.markers)
    assert.equal(content.requestSettings.reasoningEffort, 'max')
    assert.equal(typeof content.continuation.message, 'string')

    // The bundled Pro default is a complete native trajectory ending on the
    // final assistant; the content API must not pad or rewrite it.
    assert.equal(content.messages.at(-1).role, 'assistant')
    assert.ok(String(content.messages.at(-1).content ?? '').trim())

    // Only the documented read-only fields are exposed; no schema internals,
    // no bootstrap fixtures, no endpoints, and nothing credential-like.
    assert.equal('bootstrap' in content, false)
    assert.equal('artifactFingerprint' in content, false)
    assert.equal('endpoint' in content, false)
    assert.equal(JSON.stringify(content).includes('apiKey'), false)
    assert.equal(JSON.stringify(content).includes('authorization'), false)
    assert.equal(JSON.stringify(content).includes('Bearer'), false)
  }
})

test('rejects every path traversal and absolute-path form with 400', async () => {
  const rejectedForms = [
    '../outside.json',
    'anchors/../outside.json',
    'anchors\\..\\outside.json',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'C:/Windows/system.ini',
    '//server/share/secret.json',
    'x\u0000.json',
  ]
  for (const path of rejectedForms) {
    await assert.rejects(
      readAnchorArtifactContent({ path }),
      (error) => error.statusCode === 400,
      `expected ${JSON.stringify(path)} to be rejected as 400`,
    )
  }
})

test('rejects unknown paths and ids with 404', async () => {
  await assert.rejects(
    readAnchorArtifactContent({ path: 'anchors/does-not-exist.json' }),
    (error) => error.statusCode === 404,
  )
  await assert.rejects(
    readAnchorArtifactContent({ id: 'no-such-anchor-id' }),
    (error) => error.statusCode === 404,
  )
})

test('rejects corrupted artifacts and ambiguous ids with 400/404', async () => {
  const directory = await tempAnchorDirectory()
  try {
    await writeFile(
      join(directory, 'corrupt.json'),
      '{"kind":"deepseek-v4-anchor-artifact","trajectory":{}}',
      'utf8',
    )
    // A corrupted file is not a legal catalog entry and is never served.
    await assert.rejects(
      readAnchorArtifactContent({ path: 'corrupt.json' }, directory),
      (error) => error.statusCode === 404,
    )

    await writeFile(
      join(directory, 'duplicate-a.json'),
      `${JSON.stringify(validArtifact('duplicate-id', { source: { model: 'deepseek-v4-flash' } }), null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(directory, 'duplicate-b.json'),
      `${JSON.stringify(validArtifact('duplicate-id', { source: { model: 'deepseek-v4-flash-vision-exp' } }), null, 2)}\n`,
      'utf8',
    )
    await assert.rejects(
      readAnchorArtifactContent({ id: 'duplicate-id' }, directory),
      (error) => error.statusCode === 400 && /ambiguous/.test(error.message),
    )

    const byPath = await readAnchorArtifactContent({ path: 'duplicate-a.json' }, directory)
    assert.equal(byPath.id, 'duplicate-id')
    assert.equal(byPath.model, 'deepseek-v4-flash')
    assert.equal(byPath.category, 'user')
    assert.equal(byPath.displayName, 'duplicate-id')
    assert.equal(byPath.selectable, true)
    assert.equal(
      JSON.stringify(byPath).includes('apiKey') ||
      JSON.stringify(byPath).includes('authorization'),
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('hides control from the product list but still serves it through content lookup', async () => {
  const listed = await listAnchorArtifacts()
  assert.equal(listed.some((anchor) => anchor.id === 'dsh-minimal-two-tool-v1'), false)

  const scanned = await scanAnchorArtifacts({ includeControls: true })
  const control = scanned.find((anchor) => anchor.id === 'dsh-minimal-two-tool-v1')
  assert.ok(control)
  assert.equal(control.category, 'control')
  assert.equal(control.selectable, false)
  assert.equal(control.displayName, 'DeepSeek V4 Pro two-tool control')
  assert.equal(
    control.fingerprint,
    '81ad9c24a57b7583b30aa24553c14e92fca69683ea0c9e814ee1dc59dbc5a601',
  )

  const content = await readAnchorArtifactContent({ id: 'dsh-minimal-two-tool-v1' })
  assert.equal(content.id, 'dsh-minimal-two-tool-v1')
  assert.equal(content.category, 'control')
  assert.equal(content.selectable, false)
  assert.ok(Array.isArray(content.messages))
})

test('excludes copied baselines from scan, list, and content lookup', async () => {
  const directory = await tempAnchorDirectory()
  try {
    const copied = validArtifact('copied-flash', {
      source: { model: 'deepseek-v4-flash' },
      verification: { eligible: true, copiedBaseline: true },
    })
    await writeFile(join(directory, 'copied.json'), `${JSON.stringify(copied, null, 2)}\n`, 'utf8')
    const listed = await listAnchorArtifacts(directory)
    const scanned = await scanAnchorArtifacts({ directory, includeControls: true })
    assert.equal(listed.length, 0)
    assert.equal(scanned.length, 0)
    await assert.rejects(
      readAnchorArtifactContent({ path: 'copied.json' }, directory),
      (error) => error.statusCode === 404,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('deletes a user-generated Anchor and returns the removed entry summary', async () => {
  const directory = await tempAnchorDirectory()
  try {
    const artifact = validArtifact('user-deletable', { source: { model: 'deepseek-v4-flash' } })
    await writeFile(
      join(directory, 'user-deletable.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    )

    const deleted = await deleteUserAnchorArtifact({ path: 'user-deletable.json' }, directory)
    assert.equal(deleted.id, 'user-deletable')
    assert.equal(deleted.path.endsWith('user-deletable.json'), true)
    assert.equal(deleted.displayName, 'user-deletable')
    assert.equal(deleted.model, 'deepseek-v4-flash')

    // The artifact is gone from the catalog and from the content API.
    assert.deepEqual(await listAnchorArtifacts(directory), [])
    await assert.rejects(
      readAnchorArtifactContent({ id: 'user-deletable' }, directory),
      (error) => error.statusCode === 404,
    )
    // Deleting again is a 404: the file is already gone.
    await assert.rejects(
      deleteUserAnchorArtifact({ path: 'user-deletable.json' }, directory),
      (error) => error.statusCode === 404,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects deletion of bundled defaults and control artifacts with 409', async () => {
  const catalog = await listAnchorArtifacts()
  const pro = catalog.find((anchor) => (
    anchor.bundledDefault && anchor.model === 'deepseek-v4-pro'
  ))
  assert.ok(pro)

  await assert.rejects(
    deleteUserAnchorArtifact({ path: pro.path }),
    (error) => error.statusCode === 409 && /user-generated/i.test(error.message),
  )
  await assert.rejects(
    deleteUserAnchorArtifact({ id: 'dsh-minimal-two-tool-v1' }),
    (error) => error.statusCode === 409 && /user-generated/i.test(error.message),
  )

  // Nothing was removed: the default still serves and the control still scans.
  const stillThere = await readAnchorArtifactContent({ path: pro.path })
  assert.equal(stillThere.id, pro.id)
  const scanned = await scanAnchorArtifacts({ includeControls: true })
  assert.ok(scanned.some((item) => item.id === 'dsh-minimal-two-tool-v1'))
})

test('rejects traversal, absolute, and drive-letter deletion paths with 400', async () => {
  const rejectedForms = [
    '../outside.json',
    'anchors/../outside.json',
    'anchors\\..\\outside.json',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'C:/Windows/system.ini',
    '//server/share/secret.json',
  ]
  for (const path of rejectedForms) {
    await assert.rejects(
      deleteUserAnchorArtifact({ path }),
      (error) => error.statusCode === 400,
      `expected ${JSON.stringify(path)} to be rejected as 400`,
    )
  }
})

test('rejects ambiguous ids and nested legacy paths on delete without touching them', async () => {
  const directory = await tempAnchorDirectory()
  try {
    await writeFile(
      join(directory, 'dup-a.json'),
      `${JSON.stringify(validArtifact('shared-id', { source: { model: 'deepseek-v4-flash' } }), null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(directory, 'dup-b.json'),
      `${JSON.stringify(validArtifact('shared-id', { source: { model: 'deepseek-v4-pro' } }), null, 2)}\n`,
      'utf8',
    )
    await assert.rejects(
      deleteUserAnchorArtifact({ id: 'shared-id' }, directory),
      (error) => error.statusCode === 400 && /ambiguous/.test(error.message),
    )
    // Both files survive an ambiguous-id rejection.
    assert.equal((await listAnchorArtifacts(directory)).length, 2)

    // anchors/legacy/ is never scanned → not resolvable → 404, never deleted.
    await mkdir(join(directory, 'legacy'), { recursive: true })
    await writeFile(
      join(directory, 'legacy', 'leftover.json'),
      `${JSON.stringify(validArtifact('legacy-leftover', { source: { model: 'deepseek-v4-pro' } }), null, 2)}\n`,
      'utf8',
    )
    await assert.rejects(
      deleteUserAnchorArtifact({ path: 'legacy/leftover.json' }, directory),
      (error) => error.statusCode === 404,
    )
    const leftover = JSON.parse(await readFile(join(directory, 'legacy', 'leftover.json'), 'utf8'))
    assert.equal(leftover.id, 'legacy-leftover')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('refuses to delete user Anchors still bound to model planes', async () => {
  const directory = await tempAnchorDirectory()
  try {
    const artifact = validArtifact('bound-anchor', { source: { model: 'deepseek-v4-flash' } })
    await writeFile(
      join(directory, 'bound.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    )
    const entry = (await listAnchorArtifacts(directory)).find((item) => item.id === 'bound-anchor')
    assert.ok(entry)

    // Bindings that only match by path → 409 listing the plane.
    await assert.rejects(
      deleteUserAnchorArtifact({ path: 'bound.json' }, directory, {
        bindings: [
          { profile: 'pro', path: entry.path, fingerprint: null },
          { profile: 'vision', path: 'somewhere/else.json', fingerprint: 'other' },
        ],
      }),
      (error) => error.statusCode === 409
        && error.type === 'gateway_anchor_in_use'
        && error.referencedBy.join(',') === 'pro',
    )
    // A fingerprint-only match (path written differently) also 409s.
    await assert.rejects(
      deleteUserAnchorArtifact({ path: 'bound.json' }, directory, {
        bindings: [
          { profile: 'flash', path: 'somewhere/entirely/other.json', fingerprint: entry.fingerprint },
        ],
      }),
      (error) => error.statusCode === 409 && error.referencedBy.join(',') === 'flash',
    )
    // Not referenced → deletion proceeds.
    const deleted = await deleteUserAnchorArtifact({ path: 'bound.json' }, directory, {
      bindings: [{ profile: 'flash', path: 'other.json', fingerprint: 'no-match' }],
    })
    assert.equal(deleted.id, 'bound-anchor')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('toCatalogAnchorPath collapses cwd-absolute bindings to catalog form', () => {
  const cwd = process.cwd()
  assert.equal(toCatalogAnchorPath(''), '')
  assert.equal(toCatalogAnchorPath('anchors/foo.json', cwd), 'anchors/foo.json')
  assert.equal(
    toCatalogAnchorPath(`${cwd}\\anchors\\foo.json`, cwd),
    'anchors/foo.json',
  )
  assert.equal(
    toCatalogAnchorPath(`${cwd}/anchors/foo.json`, cwd),
    'anchors/foo.json',
  )
})

test('bindingMatchesArtifact aligns with the WebUI path/fingerprint semantics', () => {
  // Job activation stores a Windows absolute path; catalog entries are relative.
  assert.equal(
    bindingMatchesArtifact(
      { path: `${process.cwd()}\\anchors\\bound.json` },
      { path: 'anchors/bound.json' },
    ),
    true,
  )
  // Backslash path normalizes to the same artifact path.
  assert.equal(
    bindingMatchesArtifact(
      { path: 'anchors\\deep\\bound.json', fingerprint: 'f1' },
      { path: 'anchors/deep/bound.json', fingerprint: 'f2' },
    ),
    true,
  )
  // Fingerprint equality wins even when paths differ.
  assert.equal(
    bindingMatchesArtifact(
      { path: 'anchors/a.json', fingerprint: 'f1' },
      { path: 'anchors/b.json', fingerprint: 'f1' },
    ),
    true,
  )
  // Neither matching rule applies → not a reference.
  assert.equal(
    bindingMatchesArtifact(
      { path: 'anchors/a.json', fingerprint: 'f1' },
      { path: 'anchors/b.json', fingerprint: 'f2' },
    ),
    false,
  )
  assert.deepEqual(
    collectAnchorReferences([
      { profile: 'pro', path: 'anchors/a.json' },
      { profile: 'pro', path: 'anchors/a.json' },
      { profile: 'flash', path: 'anchors/b.json' },
    ], { path: 'anchors/a.json' }),
    ['pro'],
  )
})
