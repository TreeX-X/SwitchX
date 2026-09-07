import { createHash } from 'crypto'
import { readFile, writeFile, mkdir, access, readdir, unlink, rm } from 'fs/promises'
import { join } from 'path'

export class BlobStore {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  async initialize(): Promise<void> {
    await mkdir(this.basePath, { recursive: true })
  }

  async store(content: Buffer): Promise<string> {
    const hash = createHash('sha1').update(content).digest('hex')
    const filePath = join(this.basePath, hash)
    try {
      await access(filePath)
      // File exists, skip write (dedup)
    } catch {
      await writeFile(filePath, content)
    }
    return hash
  }

  async retrieve(hash: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.basePath, hash))
    } catch {
      return null
    }
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await access(join(this.basePath, hash))
      return true
    } catch {
      return false
    }
  }

  async listHashes(): Promise<string[]> {
    try {
      const entries = await readdir(this.basePath, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  async delete(hash: string): Promise<void> {
    try {
      await unlink(join(this.basePath, hash))
    } catch {}
  }

  async clear(): Promise<void> {
    await rm(this.basePath, { recursive: true, force: true })
    await mkdir(this.basePath, { recursive: true })
  }
}
