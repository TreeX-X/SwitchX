import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'fs/promises'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readWorkspaceFile,
  resolveWorkspaceTarget,
  WorkspacePathGuardError,
} from '../../../src/main/janus-agent/runtime/path-guard'
import { evaluateWorkspaceReadPolicy } from '../../../src/main/janus-agent/runtime/policy-gate'

const fileOpenHooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | (() => Promise<void>),
  afterOpen: undefined as undefined | (() => Promise<void>),
  pathStatDevice: undefined as bigint | undefined,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      if (fileOpenHooks.pathStatDevice !== undefined && typeof result.dev === 'bigint') {
        result.dev = fileOpenHooks.pathStatDevice
      }
      return result
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      await fileOpenHooks.beforeOpen?.()
      const handle = await actual.open(...args)
      await fileOpenHooks.afterOpen?.()
      return handle
    },
  }
})

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'janusx-path-guard-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  fileOpenHooks.beforeOpen = undefined
  fileOpenHooks.afterOpen = undefined
  fileOpenHooks.pathStatDevice = undefined
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('workspace path guard', () => {
  it('resolves existing files and directories beneath the canonical root', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.ts'), 'export {}')

    await expect(resolveWorkspaceTarget(root, '')).resolves.toMatchObject({
      relativePath: '',
      kind: 'directory',
    })
    await expect(resolveWorkspaceTarget(root, 'src\\index.ts')).resolves.toMatchObject({
      relativePath: 'src/index.ts',
      kind: 'file',
    })
  })

  it('reads a regular file through the guard-owned handle within a caller limit', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'inside content')

    await expect(readWorkspaceFile(root, 'notes.txt', 64, evaluateWorkspaceReadPolicy))
      .resolves.toEqual(Buffer.from('inside content'))
    await expect(readWorkspaceFile(root, 'notes.txt', 5, evaluateWorkspaceReadPolicy)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    })
    await expect(readWorkspaceFile(root, '', 64, evaluateWorkspaceReadPolicy)).rejects.toMatchObject({
      code: 'TARGET_NOT_REGULAR',
    })
  })

  it('retries once when an atomic save replaces the file during validation', async () => {
    const root = await temporaryDirectory()
    const target = join(root, 'notes.txt')
    await writeFile(target, 'before')

    fileOpenHooks.afterOpen = async () => {
      fileOpenHooks.afterOpen = undefined
      await rename(target, join(root, 'notes-before.txt'))
      await writeFile(target, 'after')
    }

    await expect(readWorkspaceFile(root, 'notes.txt', 64, evaluateWorkspaceReadPolicy))
      .resolves.toEqual(Buffer.from('after'))
  })

  it('accepts a matching inode when Electron omits the path stat device on Windows', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'inside content')
    fileOpenHooks.pathStatDevice = 0n

    await expect(readWorkspaceFile(root, 'notes.txt', 64, evaluateWorkspaceReadPolicy))
      .resolves.toEqual(Buffer.from('inside content'))
  })

  it('rejects different devices when both file identities provide them', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'inside content')
    fileOpenHooks.pathStatDevice = 1n

    await expect(readWorkspaceFile(root, 'notes.txt', 64, evaluateWorkspaceReadPolicy)).rejects.toMatchObject({
      code: 'TARGET_CHANGED',
    })
  })

  it('rejects invalid read limits before opening a target', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'inside content')

    await expect(readWorkspaceFile(root, 'notes.txt', -1, evaluateWorkspaceReadPolicy)).rejects.toMatchObject({
      code: 'INVALID_READ_LIMIT',
    })
  })

  it('does not read an outside file when the target is replaced during authorization', async () => {
    const state = await temporaryDirectory()
    const root = join(state, 'workspace')
    const slot = join(root, 'slot')
    const originalSlot = join(root, 'original-slot')
    const outside = join(state, 'outside')
    await mkdir(slot, { recursive: true })
    await mkdir(outside)
    await writeFile(join(slot, 'notes.txt'), 'inside content')
    await writeFile(join(outside, 'notes.txt'), 'outside secret')

    fileOpenHooks.beforeOpen = async () => {
      await rename(slot, originalSlot)
      await symlink(outside, slot, process.platform === 'win32' ? 'junction' : 'dir')
    }
    fileOpenHooks.afterOpen = async () => {
      await rm(slot, { recursive: true, force: true })
      await rename(originalSlot, slot)
    }

    await expect(readWorkspaceFile(root, 'slot/notes.txt', 64, evaluateWorkspaceReadPolicy)).rejects.toMatchObject({
      code: 'TARGET_CHANGED',
    })
  })

  it('re-authorizes the fresh in-workspace path before reading an opened file', async () => {
    const root = await temporaryDirectory()
    const slot = join(root, 'slot')
    const originalSlot = join(root, 'original-slot')
    const secrets = join(root, 'secrets')
    await mkdir(slot)
    await mkdir(secrets)
    await writeFile(join(slot, 'config.json'), 'sensitive content')
    await link(join(slot, 'config.json'), join(secrets, 'config.json'))

    fileOpenHooks.beforeOpen = async () => {
      await rename(slot, originalSlot)
      await symlink(secrets, slot, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const authorize = vi.fn(evaluateWorkspaceReadPolicy)

    await expect(readWorkspaceFile(root, 'slot/config.json', 64, authorize)).rejects.toMatchObject({
      name: 'WorkspaceReadDeniedError',
      code: 'SENSITIVE_PATH',
    })
    expect(authorize).toHaveBeenCalledWith({
      relativePath: 'secrets/config.json',
      kind: 'file',
    })
  })

  it.each([
    ['POSIX', '/outside.txt'],
    ['Windows drive', 'C:\\outside.txt'],
    ['Windows drive with forward slash', 'C:/outside.txt'],
    ['UNC', '\\\\server\\share\\outside.txt'],
    ['Windows root relative', '\\outside.txt'],
  ])('rejects %s absolute paths with a stable reason', async (_name, requestedPath) => {
    const root = await temporaryDirectory()
    await expect(resolveWorkspaceTarget(root, requestedPath)).rejects.toMatchObject({
      code: 'ABSOLUTE_PATH',
    })
  })

  it.each(['../outside.txt', 'src/../../outside.txt', 'src\\..\\..\\outside.txt', 'src/..\\../outside.txt'])(
    'rejects traversal variant %s',
    async (requestedPath) => {
      const root = await temporaryDirectory()
      await expect(resolveWorkspaceTarget(root, requestedPath)).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL',
      })
    },
  )

  it('rejects unavailable roots and targets with distinct stable reasons', async () => {
    const state = await temporaryDirectory()
    const fileRoot = join(state, 'file-root')
    await writeFile(fileRoot, 'not a workspace')
    await expect(resolveWorkspaceTarget(join(state, 'missing-root'), 'file.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
    await expect(resolveWorkspaceTarget(fileRoot, '')).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
    await expect(resolveWorkspaceTarget(state, 'missing.txt')).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    })
  })

  it('rejects a symlink or junction that resolves outside the workspace', async () => {
    const state = await temporaryDirectory()
    const root = join(state, 'workspace')
    const outside = join(state, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')

    try {
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return
      throw error
    }

    await expect(resolveWorkspaceTarget(root, 'linked/secret.txt')).rejects.toMatchObject({
      code: 'OUTSIDE_WORKSPACE',
    })
  })

  it.runIf(process.platform === 'win32')('rejects a mixed-case sibling-prefix junction escape', async () => {
    const state = await temporaryDirectory()
    const root = join(state, 'Workspace')
    const outside = join(state, 'wORKSPACE-copy')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'linked'), 'junction')

    await expect(resolveWorkspaceTarget(join(state, 'wORKSPACE'), 'linked/secret.txt')).rejects.toMatchObject({
      code: 'OUTSIDE_WORKSPACE',
    })
  })

  it.runIf(process.platform !== 'win32')('rejects non-file and non-directory targets', async () => {
    const root = await temporaryDirectory()
    const socketPath = join(root, 'agent.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(resolveWorkspaceTarget(root, 'agent.sock')).rejects.toMatchObject({
        code: 'TARGET_NOT_REGULAR',
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('exposes typed guard errors for callers', () => {
    const error = new WorkspacePathGuardError('OUTSIDE_WORKSPACE', 'outside')
    expect(error).toMatchObject({ name: 'WorkspacePathGuardError', code: 'OUTSIDE_WORKSPACE' })
  })
})
