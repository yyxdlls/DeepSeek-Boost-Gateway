import { loadEnvFile } from 'node:process'

export function loadLocalEnv(path = '.env') {
  try {
    loadEnvFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
