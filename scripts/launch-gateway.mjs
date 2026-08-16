import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadLocalEnv } from '../src/gateway/load-env.mjs'
import {
  DEFAULT_MANAGED_CONFIG_PATH,
  applyManagedConfig,
  loadManagedConfig,
} from '../src/gateway/managed-config.mjs'
import {
  gatewayManagementConfig,
  gatewayRuntimeProfiles,
} from '../src/gateway/runtime-config.mjs'

const NO_OPEN = process.argv.includes('--no-open') || process.env.GATEWAY_NO_OPEN === '1'

function browserHost(host) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

export function gatewayUrls(env = process.env) {
  const host = browserHost(env.GATEWAY_HOST ?? '127.0.0.1')
  const rawPort = Number(env.GATEWAY_PORT ?? 8642)
  const port = Number.isSafeInteger(rawPort) && rawPort > 0 && rawPort <= 65535
    ? rawPort
    : 8642
  const origin = `http://${host}:${port}`
  return {
    origin,
    webUi: `${origin}/`,
    health: `${origin}/__gateway/health`,
    api: `${origin}/v1`,
  }
}

export function gatewayLaunchConfiguration(env = process.env) {
  const deploymentMode = env.GATEWAY_INSTANCE_MODE ?? 'single'
  const profiles = gatewayRuntimeProfiles(env)
  if (deploymentMode === 'split') {
    const management = gatewayManagementConfig(env)
    const managementUrls = gatewayUrls({
      GATEWAY_HOST: management.host,
      GATEWAY_PORT: String(management.port),
    })
    return {
      deploymentMode,
      webUi: managementUrls.webUi,
      health: managementUrls.health,
      apis: profiles.map((profile) => ({
        profile: profile.name,
        model: profile.models[0],
        keyConfigured: Boolean(profile.gatewayApiKey),
        url: gatewayUrls({
          GATEWAY_HOST: profile.host,
          GATEWAY_PORT: String(profile.port),
        }).api,
      })),
    }
  }

  const urls = gatewayUrls(env)
  return {
    deploymentMode,
    webUi: urls.webUi,
    health: urls.health,
    apis: [{
      profile: 'single',
      model: profiles[0].models.join(','),
      keyConfigured: Boolean(profiles[0].gatewayApiKey),
      url: urls.api,
    }],
  }
}

export async function gatewayIsReady(healthUrl, timeoutMs = 800) {
  try {
    const response = await fetch(healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok || response.status === 401
  } catch {
    return false
  }
}

export async function gatewayMatchesDeployment(healthUrl, expectedMode, timeoutMs = 800) {
  try {
    const response = await fetch(healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401) return true
    if (!response.ok) return false
    const health = await response.json()
    return (health.deploymentMode ?? 'single') === expectedMode
  } catch {
    return false
  }
}

function spawnDetached(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

export async function openWebUi(url, options = {}) {
  if (options.noOpen) return false
  if (process.platform === 'win32') {
    return spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '', url])
  }
  if (process.platform === 'darwin') return spawnDetached('open', [url])
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false
  if (await spawnDetached('xdg-open', [url])) return true
  return spawnDetached('gio', ['open', url])
}

async function openWhenReady(url, healthUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await gatewayIsReady(healthUrl)) {
      const opened = await openWebUi(url, { noOpen: NO_OPEN })
      if (!opened && !NO_OPEN) {
        process.stdout.write(`请在浏览器中打开 WebUI：${url}\n`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  process.stderr.write(`Gateway 未能就绪，请检查启动输出，然后打开：${url}\n`)
}

async function main() {
  loadLocalEnv()
  const managedDocument = await loadManagedConfig(DEFAULT_MANAGED_CONFIG_PATH)
  const launchEnvironment = (process.env.GATEWAY_INSTANCE_MODE ?? 'single') === 'split'
    ? applyManagedConfig(process.env, managedDocument)
    : process.env
  const launch = gatewayLaunchConfiguration(launchEnvironment)
  for (const api of launch.apis) {
    if (!api.keyConfigured) {
      process.stderr.write(`[提示] ${api.profile} 尚未配置 Gateway Key；该数据端口会在本地返回 503。\n`)
    }
  }
  const apiLines = launch.apis
    .map((api) => `API (${api.profile}): ${api.url}`)
    .join('\n')
  if (await gatewayMatchesDeployment(launch.health, launch.deploymentMode)) {
    process.stdout.write(`Gateway 已经由另一个进程运行。\n当前页面: ${launch.webUi}\n${apiLines}\n当前终端没有重复启动 Gateway；如需让终端拥有服务，请先运行关闭脚本，再重新启动。\n`)
    const opened = await openWebUi(launch.webUi, { noOpen: NO_OPEN })
    if (!opened && !NO_OPEN) process.stdout.write(`请在浏览器中打开 WebUI：${launch.webUi}\n`)
    return
  }

  process.stdout.write(`当前页面: ${launch.webUi}\n${apiLines}\n关闭当前终端会停止本次启动的 Gateway。\n`)
  const readiness = openWhenReady(launch.webUi, launch.health)
  await import('../src/gateway/server.mjs')
  await readiness
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
