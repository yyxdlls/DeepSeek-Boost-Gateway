import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadLocalEnv } from '../src/gateway/load-env.mjs'
import { stopGateway } from '../src/gateway/pid-file.mjs'

async function main() {
  loadLocalEnv()
  const result = await stopGateway({
    managementToken: process.env.GATEWAY_MANAGEMENT_TOKEN ?? '',
  })
  if (result.status === 'not-running') {
    process.stdout.write('Gateway 未在运行（没有 PID 文件）。\n')
    return
  }
  if (result.status === 'stale') {
    process.stdout.write(`已清理失效的 Gateway PID 文件（旧 PID ${result.pid}）。\n`)
    return
  }
  process.stdout.write(`Gateway 已安全关闭（PID ${result.pid}）。\n`)
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`[错误] ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
