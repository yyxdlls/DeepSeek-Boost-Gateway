import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function moveIfPresent(source, target) {
  try {
    await rename(source, target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export class RotatingJsonlWriter {
  constructor(path, options = {}) {
    this.path = path
    this.maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : 64 * 1024 * 1024
    this.maxFiles = Number.isSafeInteger(options.maxFiles) && options.maxFiles > 0
      ? options.maxFiles
      : 5
    this.queue = Promise.resolve()
  }

  append(value) {
    const line = `${JSON.stringify(value)}\n`
    const operation = this.queue.then(() => this.#appendLine(line))
    this.queue = operation.catch(() => {})
    return operation
  }

  async #appendLine(line) {
    await mkdir(dirname(this.path), { recursive: true })
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if ((await fileSize(this.path)) + lineBytes > this.maxBytes) {
      await this.#rotate()
    }
    await appendFile(this.path, line, 'utf8')
  }

  async #rotate() {
    if (this.maxFiles === 1) {
      await rm(this.path, { force: true })
      return
    }
    await rm(`${this.path}.${this.maxFiles - 1}`, { force: true })
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await moveIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`)
    }
    await moveIfPresent(this.path, `${this.path}.1`)
  }
}
