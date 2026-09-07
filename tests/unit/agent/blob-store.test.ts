import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { BlobStore } from '../../../src/main/janus-agent/checkpoint/blob-store'

let tmpDir: string
let store: BlobStore

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'blob-test-'))
  store = new BlobStore(join(tmpDir, 'blobs'))
  await store.initialize()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('BlobStore', () => {
  it('initialize() creates the directory', async () => {
    const fresh = new BlobStore(join(tmpDir, 'fresh-blobs'))
    expect(existsSync(join(tmpDir, 'fresh-blobs'))).toBe(false)
    await fresh.initialize()
    expect(existsSync(join(tmpDir, 'fresh-blobs'))).toBe(true)
  })

  it('store() returns a 40-char hex SHA1 hash and dedups identical content', async () => {
    const content = Buffer.from('duplicate test content')
    const hash1 = await store.store(content)
    const hash2 = await store.store(content)
    expect(hash1).toHaveLength(40)
    expect(hash1).toMatch(/^[0-9a-f]{40}$/)
    expect(hash1).toBe(hash2)
  })

  it('store() returns different hash for different content', async () => {
    const hash1 = await store.store(Buffer.from('content A'))
    const hash2 = await store.store(Buffer.from('content B'))
    expect(hash1).not.toBe(hash2)
  })

  it('retrieve() returns the stored content and null for nonexistent hash', async () => {
    const content = Buffer.from('retrieve test')
    const hash = await store.store(content)
    const retrieved = await store.retrieve(hash)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.toString()).toBe('retrieve test')
    expect(await store.retrieve('0000000000000000000000000000000000000000')).toBeNull()
  })

  it.each([
    ['stored hash', Buffer.from('exists test'), true],
    ['missing hash', null, false],
  ])('exists() returns %s for %s', async (_label, content, expected) => {
    let hash = '0000000000000000000000000000000000000000'
    if (content) {
      hash = await store.store(content)
    }
    expect(await store.exists(hash)).toBe(expected)
  })

  it('listHashes() returns stored blob hashes', async () => {
    const hash = await store.store(Buffer.from('list test'))
    expect(await store.listHashes()).toEqual([hash])
  })

  it('delete() removes a stored blob', async () => {
    const hash = await store.store(Buffer.from('delete test'))
    await store.delete(hash)
    expect(await store.exists(hash)).toBe(false)
  })

  it('clear() removes all blobs and keeps the store usable', async () => {
    await store.store(Buffer.from('clear test'))
    await store.clear()
    expect(await store.listHashes()).toEqual([])
    const hash = await store.store(Buffer.from('after clear'))
    expect(await store.exists(hash)).toBe(true)
  })
})