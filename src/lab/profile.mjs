export const ARM_NAMES = Object.freeze({
  dshMinimal: 'dsh-minimal',
  standardControl: 'dsh-standard-control',
})

const SHARED_V4_CAPABILITIES = Object.freeze({
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 384_000,
  thinking: Object.freeze({
    defaultEnabled: true,
    efforts: Object.freeze(['low', 'high', 'max']),
  }),
  inputModalities: Object.freeze(['text']),
  protocols: Object.freeze([
    'openai-chat-completions',
    'openai-responses',
    'anthropic-messages',
  ]),
  features: Object.freeze([
    'json-output',
    'tool-calls',
    'chat-prefix-completion-beta',
    'fim-completion-beta-non-thinking-only',
  ]),
})

export const MODEL_CATALOG = Object.freeze({
  'deepseek-v4-pro': Object.freeze({
    ...SHARED_V4_CAPABILITIES,
    servedVersion: 'DeepSeek-V4-Pro-0813',
    concurrencyLimit: 500,
  }),
  'deepseek-v4-flash': Object.freeze({
    ...SHARED_V4_CAPABILITIES,
    servedVersion: 'DeepSeek-V4-Flash-0731',
    concurrencyLimit: 2_500,
  }),
})

export const DSH_REPRODUCTION_MAX_TOKENS = 256_000

export function capabilitiesForModel(model) {
  const capabilities = MODEL_CATALOG[model]
  if (!capabilities) throw new Error(`Unknown official DeepSeek V4 model: ${model}`)
  return structuredClone(capabilities)
}

export const DEFAULT_PROFILE = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  system: 'You are a helpful software engineer assistant.',
  userPrompt: `Inspect the current repository before answering.
First determine its top-level structure, then locate and read the project README.
Do not guess from prior knowledge. Use the available tools first.`,
  thinking: Object.freeze({ type: 'enabled' }),
  reasoningEffort: 'max',
  // Full official V4 API output capacity. The earlier DSH reproduction used
  // 256000; keep that as an explicit historical profile, not the model limit.
  maxTokens: MODEL_CATALOG['deepseek-v4-pro'].maxOutputTokens,
})

const DSH_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

const STANDARD_PWSH_DESCRIPTION =
  'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. Each call runs in a fresh pwsh process: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment variables with `$env:NAME`. Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed `$env:DSH_*` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. Set `run_in_background: true` for long-running commands: the call returns a task id immediately; read its output with `task_output` and stop it with `task_kill`.'

const DSH_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``

function buildDshBashTool() {
  return {
    type: 'function',
    function: {
      name: 'bash',
      description: DSH_BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            description:
              'The bash command to run. Relative path is preferred in the command.',
            type: 'string',
          },
        },
        required: ['command'],
      },
    },
  }
}

function buildDshEditorTool() {
  return {
    type: 'function',
    function: {
      name: 'str_replace_editor',
      description: DSH_EDITOR_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            description:
              'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.',
            enum: ['view', 'create', 'str_replace', 'insert'],
            type: 'string',
          },
          path: {
            description:
              'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.',
            type: 'string',
          },
          file_text: {
            description:
              'Required parameter of `create` command, with the content of the file to be created.',
            type: 'string',
          },
          insert_line: {
            description:
              'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.',
            type: 'integer',
          },
          new_str: {
            description:
              'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.',
            type: 'string',
          },
          old_str: {
            description:
              'Required parameter of `str_replace` command containing the string in `path` to replace.',
            type: 'string',
          },
          view_range: {
            description:
              'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.',
            type: 'array',
            items: { type: 'integer' },
          },
        },
        required: ['command', 'path'],
      },
    },
  }
}

export function buildDshMinimalTools() {
  return [buildDshBashTool(), buildDshEditorTool()]
}

// Windows DSH Standard-family control. The schema is projected from the
// published rc.1 pwsh/fs tool declarations; no tool execution occurs here.
export function buildStandardControlTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'pwsh',
        description: STANDARD_PWSH_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The PowerShell command to execute.',
            },
            description: {
              type: 'string',
              description:
                'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "Get-Process" → "List running processes".',
            },
            timeoutMs: {
              type: 'number',
              description:
                'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
            },
            workdir: {
              type: 'string',
              description:
                'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
            },
            run_in_background: {
              type: 'boolean',
              description:
                'Run in the background and return a task id immediately (collect with task_output, stop with task_kill). No timeout applies.',
            },
          },
          required: ['command', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a UTF-8 text file and return line-numbered content.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to read, resolved by the filesystem backend.',
            },
            offset: {
              type: 'number',
              description: '1-based first line to return. Defaults to 1.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of lines to return. Defaults to 2000.',
            },
          },
          required: ['file_path'],
        },
      },
    },
  ]
}

export function toolsForArm(arm) {
  if (arm === ARM_NAMES.dshMinimal) return buildDshMinimalTools()
  if (arm === ARM_NAMES.standardControl) return buildStandardControlTools()
  throw new Error(`Unknown probe arm: ${arm}`)
}

export function makeChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/chat/completions')) {
    url.pathname = `${path}/chat/completions`
  }
  return url.toString()
}

export function buildTrajectoryProbeRequest(options = {}) {
  const profile = {
    ...DEFAULT_PROFILE,
    ...options,
  }
  const arm = options.arm ?? ARM_NAMES.dshMinimal

  return {
    model: profile.model,
    messages: [
      { role: 'system', content: profile.system },
      { role: 'user', content: profile.userPrompt },
    ],
    thinking: { ...profile.thinking },
    reasoning_effort: profile.reasoningEffort,
    tools: toolsForArm(arm),
    max_tokens: profile.maxTokens,
  }
}
