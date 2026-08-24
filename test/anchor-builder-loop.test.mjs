import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { MODEL_CATALOG } from '../src/lab/profile.mjs'
import {
  OPEN_WORKSTREAM_ANCHOR_TASK,
  OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY,
} from '../src/lab/anchor-profile.mjs'

const run = promisify(execFile)
const BUILDER = fileURLToPath(new URL('../src/lab/run-anchor-candidate.mjs', import.meta.url))

function sse(response, payloads) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const payload of payloads) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

test('open-workstream builder records a complete final answer without lexical steering', async () => {
  const requests = []
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const call = requests.length
    if (call === 1) {
      sse(response, [
        {
          model: 'deepseek-v4-pro',
          choices: [{ index: 0, delta: { reasoning_content: 'We need inspect the fixture naturally.' } }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-bash',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: 'pwd; ls -la; find /tmp/qxk_scratch -name zzq_9f3k.tmp -print',
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            completion_tokens_details: { reasoning_tokens: 10 },
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        },
      ])
      return
    }
    if (call === 2) {
      sse(response, [
        {
          choices: [{ index: 0, delta: { reasoning_content: 'The file is located; now read it.' } }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-editor',
                function: {
                  name: 'str_replace_editor',
                  arguments: JSON.stringify({ command: 'view', path: '/tmp/qxk_scratch/zzq_9f3k.tmp' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 130,
            completion_tokens: 18,
            total_tokens: 148,
            completion_tokens_details: { reasoning_tokens: 8 },
            prompt_cache_hit_tokens: 120,
            prompt_cache_miss_tokens: 10,
          },
        },
      ])
      return
    }
    sse(response, [
      {
        choices: [{
          index: 0,
          delta: {
            reasoning_content: 'The evidence is sufficient for a concise conclusion.',
            content: 'The workstream combines connected engineering constraints; I am ready to continue.',
          },
          finish_reason: 'stop',
        }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 160,
          completion_tokens: 24,
          total_tokens: 184,
          completion_tokens_details: { reasoning_tokens: 12 },
          prompt_cache_hit_tokens: 150,
          prompt_cache_miss_tokens: 10,
        },
      },
    ])
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')

  const directory = await mkdtemp(join(tmpdir(), 'anchor-builder-loop-'))
  const resultsPath = join(directory, 'results.json')
  try {
    await run(process.execPath, [BUILDER, '--open-workstream'], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_REASONING_EFFORT: 'high',
        ANCHOR_RUNS: '1',
        ANCHOR_MAX_SUBTURNS: '4',
        ANCHOR_MAX_TOKENS: '1000',
        ANCHOR_RESULTS_PATH: resultsPath,
        ANCHOR_ARTIFACT_ID: 'builder-loop-test',
        ANCHOR_USER_PROMPT: 'Inspect the synthetic workstream using both tools, then give a final answer.',
        ANCHOR_CONTINUATION_MESSAGE: 'Continue with the current Harness task.',
      },
    })

    const stored = JSON.parse(await readFile(resultsPath, 'utf8'))
    const candidate = stored.candidates[0]
    assert.equal(requests.length, 3)
    assert.equal(requests.every((item) => item.reasoning_effort === 'high'), true)
    assert.equal(requests[0].messages[1].content.includes('Use concise collective planning'), false)
    assert.equal(stored.anchor.reasoningEffort, 'high')
    assert.equal(stored.anchor.continuationMessage, 'Continue with the current Harness task.')
    assert.equal(candidate.stopReason, 'final-answer')
    assert.equal(candidate.assistantTurns.length, 3)
    assert.equal(candidate.messages.at(-1).role, 'assistant')
    assert.match(candidate.messages.at(-1).content, /ready to continue/)
    assert.equal(candidate.evaluation.checks.hasFinalAnswer, true)
    assert.equal(candidate.evaluation.eligible, true)
  } finally {
    upstream.close()
    await once(upstream, 'close')
  }
})

const PRO_LEAK_MARKERS = [
  'call_00_AUeQqHMaETvNM4ff8igG3833',
  'call_00_qsp9jK74RnKsZ1TEpHtv0927',
  'We need follow user instructions precisely',
  'a307abda487cd1b463329ccb945ce396',
]

function protocolPayloads(model) {
  return [
    [
      { model, choices: [{ index: 0, delta: { reasoning_content: 'Inspect the fixture.' } }] },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-bash',
              function: {
                name: 'bash',
                arguments: JSON.stringify({
                  command: 'pwd; ls -la; find /tmp/qxk_scratch -name zzq_9f3k.tmp -print',
                }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ],
    [
      { model, choices: [{ index: 0, delta: { reasoning_content: 'Read zzq_9f3k.tmp.' } }] },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-editor',
              function: {
                name: 'str_replace_editor',
                arguments: JSON.stringify({ command: 'view', path: '/tmp/qxk_scratch/zzq_9f3k.tmp' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ],
    [
      {
        model,
        choices: [{
          index: 0,
          delta: {
            reasoning_content: 'Enough evidence.',
            content: 'The workstream is connected; ready to continue.',
          },
          finish_reason: 'stop',
        }],
      },
      { choices: [], usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 } },
    ],
  ]
}

async function runOpenWorkstreamAgainstFake(model, payloadsForCall) {
  const requests = []
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    sse(response, payloadsForCall(requests.length, requests.at(-1)))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const directory = await mkdtemp(join(tmpdir(), 'anchor-builder-e-'))
  const resultsPath = join(directory, 'results.json')
  try {
    await run(process.execPath, [BUILDER, '--open-workstream'], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        DEEPSEEK_MODEL: model,
        DEEPSEEK_REASONING_EFFORT: 'max',
        ANCHOR_RUNS: '1',
        ANCHOR_MAX_SUBTURNS: '6',
        ANCHOR_MAX_TOKENS: '384000',
        ANCHOR_RESULTS_PATH: resultsPath,
      },
    })
    const stored = JSON.parse(await readFile(resultsPath, 'utf8'))
    return { requests, stored, resultsPath }
  } finally {
    upstream.close()
    await once(upstream, 'close')
  }
}

for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
  test(`open-workstream fake upstream keeps ${model} requests exact and fixture-identical`, async () => {
    const { requests, stored } = await runOpenWorkstreamAgainstFake(
      model,
      (call) => protocolPayloads(model)[call - 1],
    )
    assert.equal(requests.length, 3)
    assert.equal(requests.every((item) => item.model === model), true)
    assert.equal(stored.requestedModel, model)
    assert.equal(stored.model, model)
    assert.equal(stored.fixtureId, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fixtureId)
    assert.equal(stored.fixtureFingerprint, OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.fingerprint)
    assert.equal(stored.anchor.task, OPEN_WORKSTREAM_ANCHOR_TASK)
    assert.equal(stored.candidates[0].evaluation.checks.exactAcceptedSequence, true)
    assert.equal(stored.candidates[0].evaluation.checks.editorAfterBash, true)
    assert.equal(stored.candidates[0].messages.at(-1).role, 'assistant')
    assert.match(stored.candidates[0].messages.at(-1).content, /ready to continue/)
    assert.equal(
      stored.candidates[0].messages.find((message) => message.role === 'tool').content,
      OPEN_WORKSTREAM_SYNTHETIC_REPOSITORY.bashResult,
    )
    const serialized = JSON.stringify(requests)
    for (const marker of PRO_LEAK_MARKERS) {
      assert.equal(serialized.includes(marker), false, marker)
    }
    assert.equal(requests[0].messages.some((message) => message.role === 'assistant'), false)
    assert.equal(stored.candidates[0].reportedModels.every((report) => report.model === model), true)
  })
}

test('builder stops when a subturn reports an incompatible model', async () => {
  try {
    await runOpenWorkstreamAgainstFake(
      'deepseek-v4-flash',
      (call) => protocolPayloads(call === 1 ? 'deepseek-v4-pro' : 'deepseek-v4-flash')[call - 1],
    )
    assert.fail('builder should have stopped')
  } catch (error) {
    assert.match(
      `${error?.stderr ?? ''}\n${error?.message ?? ''}`,
      /not deepseek-v4-flash or DeepSeek-V4-Flash-0731/,
    )
  }
})

test('builder accepts the catalog servedVersion as a reported model', async () => {
  const served = MODEL_CATALOG['deepseek-v4-flash'].servedVersion
  const { stored } = await runOpenWorkstreamAgainstFake(
    'deepseek-v4-flash',
    (call) => protocolPayloads(served)[call - 1],
  )
  assert.equal(stored.requestedModel, 'deepseek-v4-flash')
  assert.equal(stored.candidates[0].reportedModels[0].model, served)
})
