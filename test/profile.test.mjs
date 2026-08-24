import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ARM_NAMES,
  DEFAULT_PROFILE,
  DSH_REPRODUCTION_MAX_TOKENS,
  buildTrajectoryProbeRequest,
  capabilitiesForModel,
  makeChatCompletionsUrl,
} from '../src/lab/profile.mjs'

test('builds the official base URL without inventing a version segment', () => {
  assert.equal(
    makeChatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions',
  )
})

test('preserves an explicit compatible API version segment', () => {
  assert.equal(
    makeChatCompletionsUrl('https://provider.example/v1/'),
    'https://provider.example/v1/chat/completions',
  )
})

test('builds an exact DSH Minimal max-thinking probe', () => {
  const request = buildTrajectoryProbeRequest({
    arm: ARM_NAMES.dshMinimal,
    model: 'deepseek-v4-flash',
  })

  assert.equal(request.model, 'deepseek-v4-flash')
  assert.deepEqual(request.thinking, { type: 'enabled' })
  assert.equal(request.reasoning_effort, 'max')
  assert.equal(request.max_tokens, 384_000)
  assert.deepEqual(
    request.tools.map((tool) => tool.function.name),
    ['bash', 'str_replace_editor'],
  )
  assert.equal(
    request.tools[0].function.description,
    `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`,
  )
  assert.equal(request.tools[0].function.parameters.title, undefined)
  assert.equal(
    request.tools[0].function.parameters.additionalProperties,
    undefined,
  )
  assert.equal(request.tool_choice, undefined)
})

test('changes only the tools when constructing the control arm', () => {
  const minimal = buildTrajectoryProbeRequest({ arm: ARM_NAMES.dshMinimal })
  const control = buildTrajectoryProbeRequest({ arm: ARM_NAMES.standardControl })

  assert.deepEqual(minimal.messages, control.messages)
  assert.equal(minimal.max_tokens, control.max_tokens)
  assert.deepEqual(minimal.thinking, control.thinking)
  assert.equal(minimal.reasoning_effort, control.reasoning_effort)
  assert.deepEqual(
    control.tools.map((tool) => tool.function.name),
    ['pwsh', 'read'],
  )
  assert.deepEqual(
    control.tools[0].function.parameters.required,
    ['command', 'description'],
  )
  assert.deepEqual(
    control.tools[1].function.parameters.required,
    ['file_path'],
  )
  assert.equal(DEFAULT_PROFILE.system, 'You are a helpful software engineer assistant.')
})

test('records the exact current DeepSeek V4 capacity separately from requests', () => {
  const pro = capabilitiesForModel('deepseek-v4-pro')
  const flash = capabilitiesForModel('deepseek-v4-flash')

  assert.equal(pro.servedVersion, 'DeepSeek-V4-Pro-0813')
  assert.equal(flash.servedVersion, 'DeepSeek-V4-Flash-0731')
  assert.equal(pro.contextWindowTokens, 1_000_000)
  assert.equal(pro.maxOutputTokens, 384_000)
  assert.deepEqual(pro.thinking.efforts, ['low', 'high', 'max'])
  assert.ok(pro.protocols.includes('openai-responses'))
  assert.equal(pro.concurrencyLimit, 500)
  assert.equal(flash.concurrencyLimit, 2_500)
  assert.equal(DSH_REPRODUCTION_MAX_TOKENS, 256_000)
})

test('labels the experimental Vision model with its own ID, modalities, and flag', () => {
  const vision = capabilitiesForModel('deepseek-v4-flash-vision-exp')

  assert.equal(vision.servedVersion, 'deepseek-v4-flash-vision-exp')
  assert.deepEqual(vision.inputModalities, ['text', 'image'])
  assert.equal(vision.experimental, true)
  assert.equal(
    capabilitiesForModel('deepseek-v4-pro').inputModalities.includes('image'),
    false,
  )
  assert.equal(
    capabilitiesForModel('deepseek-v4-flash').inputModalities.includes('image'),
    false,
  )
})

test('rejects unknown models instead of attaching incorrect capability metadata', () => {
  assert.throws(
    () => capabilitiesForModel('deepseek-v4-unknown'),
    /Unknown official DeepSeek V4 model/,
  )
})
