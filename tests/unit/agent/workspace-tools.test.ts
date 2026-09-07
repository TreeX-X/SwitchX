import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceAgentRuntime } from '../../../src/main/janus-agent/runtime/runtime'
import {
  registerWorkspaceTools,
  workspaceListTool,
} from '../../../src/main/janus-agent/runtime/tools/workspace-tools'

const fileStatHooks = vi.hoisted(() => ({
  pathStatDevice: undefined as bigint | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      if (fileStatHooks.pathStatDevice !== undefined && typeof result.dev === 'bigint') {
        result.dev = fileStatHooks.pathStatDevice
      }
      return result
    },
  }
})

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'janusx-workspace-tools-'))
  temporaryDirectories.push(directory)
  return directory
}

function autoApprove(runtime: WorkspaceAgentRuntime, approved = true) {
  runtime.onEvent((event) => {
    if (event.type !== 'approval-requested') return
    runtime.resolveApproval({
      approvalId: event.request.id,
      approved,
      workspaceId: event.request.workspaceId,
      sessionId: event.request.sessionId,
      correlationId: event.request.correlationId,
      toolName: event.request.toolName,
      actionRisk: event.request.actionRisk,
    })
  })
}

async function executeRead(root: string, path: string, maxBytes?: number, offset?: number) {
  const runtime = new WorkspaceAgentRuntime(async () => root)
  registerWorkspaceTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
  return runtime.executeTool({
    sessionId: session.id,
    call: {
      toolName: 'workspace.read',
      input: {
        workspaceId: 'workspace-1',
        path,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(offset === undefined ? {} : { offset }),
      },
    },
  })
}

async function executeList(
  root: string,
  input: Record<string, unknown> = { workspaceId: 'workspace-1' },
) {
  const runtime = new WorkspaceAgentRuntime(async () => root)
  registerWorkspaceTools(runtime.registry)
  const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
  return runtime.executeTool({
    sessionId: session.id,
    call: { toolName: 'workspace.list', input },
  })
}

afterEach(async () => {
  fileStatHooks.pathStatDevice = undefined
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('workspace.read tool', () => {
  it('registers every workspace tool once and reads UTF-8 text through the runtime executor', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const runtime = new WorkspaceAgentRuntime(async () => root)

    registerWorkspaceTools(runtime.registry)
    registerWorkspaceTools(runtime.registry)

    expect(runtime.registry.list().filter(({ name }) => name === 'workspace.read')).toHaveLength(1)
    expect(runtime.registry.list().filter(({ name }) => name === 'workspace.list')).toHaveLength(1)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    await expect(runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-1', path: 'notes.txt' } },
    })).resolves.toMatchObject({
      status: 'completed',
      output: {
        workspaceId: 'workspace-1',
        path: 'notes.txt',
        encoding: 'utf-8',
        size: 15,
        content: 'hello workspace',
        sha256: createHash('sha256').update('hello workspace').digest('hex'),
      },
    })
  })

  it('returns secret-shaped source code verbatim so hash-bound edits stay possible', async () => {
    // Regression: display-level redaction used to rewrite `apiKey: ...` lines in
    // tool output, so the model could never produce a matching oldText again.
    const source = 'const apiKey = process.env.MY_KEY\nconst token = login()\n'
    const root = await temporaryDirectory()
    await writeFile(join(root, 'config.ts'), source, 'utf-8')

    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    const read = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-1', path: 'config.ts' } },
    })
    expect(read.status).toBe('completed')
    const output = read.output as { content: string; sha256: string; contentRedacted: boolean }
    expect(output.content).toBe(source)
    expect(output.contentRedacted).toBe(false)
    expect(output.sha256).toBe(createHash('sha256').update(source).digest('hex'))

    autoApprove(runtime)
    const edit = await runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: {
          workspaceId: 'workspace-1', path: 'config.ts', expectedHash: output.sha256,
          replacements: [{ oldText: 'const apiKey = process.env.MY_KEY', newText: 'const apiKey = process.env.RENAMED_KEY' }],
        },
        preview: { summary: 'Edit config.ts', paths: ['config.ts'], truncated: false },
      },
    })
    expect(edit.status).toBe('completed')
    expect(await readFile(join(root, 'config.ts'), 'utf-8')).toBe(
      'const apiKey = process.env.RENAMED_KEY\nconst token = login()\n',
    )
  })

  it('masks embedded private keys, flags the redaction, and keeps other regions editable', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'
    const source = `const label = 'hello'\nconst pem = \`${pem}\`\n`
    const root = await temporaryDirectory()
    await writeFile(join(root, 'cert.ts'), source, 'utf-8')

    const read = await executeRead(root, 'cert.ts')
    expect(read.status).toBe('completed')
    const output = read.output as { content: string; sha256: string; contentRedacted: boolean; redactionNotice?: string }
    expect(output.contentRedacted).toBe(true)
    expect(output.redactionNotice).toContain('masked')
    expect(output.content).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(output.content).toContain("const label = 'hello'")
    // Hash still covers the on-disk original, so unmasked regions remain editable.
    expect(output.sha256).toBe(createHash('sha256').update(source).digest('hex'))
  })

  it.each([
    ['sensitive', '.env', Buffer.from('SECRET=not-exposed')],
    ['binary', 'image.bin', Buffer.from([0x00, 0x01, 0x02, 0x03])],
    ['invalid UTF-8', 'invalid.txt', Buffer.from([0xc3, 0x28])],
  ])('fails closed for %s files', async (_case, path, content) => {
    const root = await temporaryDirectory()
    await writeFile(join(root, path), content)

    const result = await executeRead(root, path)

    expect(result.status).toBe('failed')
    expect(result.output).toBeUndefined()
    expect(result.error).not.toContain(content.toString())
  })

  it('fails closed for outside files and bounds oversized reads', async () => {
    const state = await temporaryDirectory()
    const root = await temporaryDirectory()
    const outsidePath = join(state, 'outside.txt')
    await writeFile(outsidePath, 'outside secret')
    await writeFile(join(root, 'large.txt'), 'larger than limit')

    const outside = await executeRead(root, outsidePath)
    const oversized = await executeRead(root, 'large.txt', 4)

    expect(outside).toMatchObject({ status: 'failed', output: undefined })
    expect(outside.error).not.toContain('outside secret')
    expect(oversized).toMatchObject({
      status: 'completed',
      output: {
        content: 'larg',
        offset: 0,
        bytes: 4,
        size: 'larger than limit'.length,
        truncated: true,
        sha256: createHash('sha256').update('larger than limit').digest('hex'),
      },
    })
  })

  it('reads a bounded range with the complete file hash', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'large.txt'), '0123456789abcdef', 'utf-8')

    const result = await executeRead(root, 'large.txt', 4, 6)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        content: '6789',
        offset: 6,
        bytes: 4,
        size: 16,
        truncated: true,
        sha256: createHash('sha256').update('0123456789abcdef').digest('hex'),
      },
    })
  })

  it('rejects a range read whose full hash would exceed the file safety bound', async () => {
    const root = await temporaryDirectory()
    const file = join(root, 'too-large.txt')
    await writeFile(file, 'x')
    await truncate(file, 16 * 1024 * 1024 + 1)

    await expect(executeRead(root, 'too-large.txt', 1)).resolves.toMatchObject({
      status: 'failed',
      reasonCode: 'FILE_TOO_LARGE',
      output: undefined,
    })
  })

  it('requires the explicit workspace resource id to match the session', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })

    const missing = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { path: 'notes.txt' } },
    })
    const mismatched = await runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.read', input: { workspaceId: 'workspace-2', path: 'notes.txt' } },
    })

    expect(missing).toMatchObject({ status: 'failed', output: undefined })
    expect(missing.error).toContain('Invalid input for tool')
    expect(mismatched).toMatchObject({ status: 'failed', output: undefined })
    expect(mismatched.error).toContain('must match the active workspace resource')
  })
})

describe('workspace.edit tool', () => {
  async function executeEdit(root: string, expectedHash: string, approved: boolean, oldText = 'hello') {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: {
          workspaceId: 'workspace-1',
          path: 'notes.txt',
          expectedHash,
          replacements: [{ oldText, newText: 'updated' }],
        },
        preview: {
          summary: 'Edit notes.txt',
          paths: ['notes.txt'],
          detail: `- ${oldText}\n+ updated`,
          truncated: false,
        },
      },
    })
  }

  async function executeUnifiedDiff(root: string, expectedHash: string, unifiedDiff: string, approved = true) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.edit',
        input: { workspaceId: 'workspace-1', path: 'notes.txt', expectedHash, unifiedDiff },
        preview: { summary: 'Edit notes.txt with a unified diff', paths: ['notes.txt'], detail: unifiedDiff, truncated: false },
      },
    })
  }

  it('applies an approved hash-bound replacement and returns a checkpoint', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')

    const result = await executeEdit(root, expectedHash, true)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes.txt',
        changedPaths: ['notes.txt'],
        previousHash: expectedHash,
        replacements: 1,
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('updated workspace')

    const nextTurnRead = await executeRead(root, 'notes.txt')
    expect(nextTurnRead).toMatchObject({
      status: 'completed',
      output: {
        content: 'updated workspace',
        sha256: createHash('sha256').update('updated workspace').digest('hex'),
      },
    })
  })

  it('does not return partial UTF-8 characters at a byte range boundary', async () => {
    const root = await temporaryDirectory()
    const source = 'a你b好c'
    await writeFile(join(root, 'unicode.txt'), source, 'utf-8')

    const result = await executeRead(root, 'unicode.txt', 5, 2)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        content: 'b',
        offset: 4,
        bytes: 1,
        truncated: true,
        sha256: createHash('sha256').update(source).digest('hex'),
      },
    })
  })

  it('applies an edit when Electron omits the path stat device on Windows', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')
    fileStatHooks.pathStatDevice = 0n

    await expect(executeEdit(root, expectedHash, true)).resolves.toMatchObject({
      status: 'completed',
      output: { path: 'notes.txt', previousHash: expectedHash },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('updated workspace')
  })

  it('does not write when approval is denied', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello workspace', 'utf-8')
    const expectedHash = createHash('sha256').update('hello workspace').digest('hex')

    const result = await executeEdit(root, expectedHash, false)

    expect(result).toMatchObject({ status: 'cancelled', output: undefined })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('hello workspace')
  })

  it('applies an approved, hash-bound single-file unified diff atomically', async () => {
    const root = await temporaryDirectory()
    const source = 'first\nbefore\nlast\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-before',
      '+after',
      ' last',
      '',
    ].join('\n')

    const result = await executeUnifiedDiff(root, createHash('sha256').update(source).digest('hex'), diff)

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes.txt',
        changedPaths: ['notes.txt'],
        editMode: 'unified_diff',
        replacements: 1,
        sha256: createHash('sha256').update('first\nafter\nlast\n').digest('hex'),
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\nafter\nlast\n')
  })

  it('preserves the standard trailing newline when a unified diff creates a file body', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), '', 'utf-8')
    const diff = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -0,0 +1 @@', '+first', ''].join('\n')

    await expect(executeUnifiedDiff(root, createHash('sha256').update('').digest('hex'), diff)).resolves.toMatchObject({
      status: 'completed',
      output: { sha256: createHash('sha256').update('first\n').digest('hex') },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('first\n')
  })

  it('rejects unified diffs with stale content, mismatched paths, or multiple file sections without writing', async () => {
    const root = await temporaryDirectory()
    const source = 'before\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const expectedHash = createHash('sha256').update(source).digest('hex')
    const mismatchedContext = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-different', '+after', ''].join('\n')
    const mismatchedPath = ['--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@', '-before', '+after', ''].join('\n')
    const multipleFiles = [
      '--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-before', '+after',
      '--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@', '-x', '+y', '',
    ].join('\n')

    for (const diff of [mismatchedContext, mismatchedPath, multipleFiles]) {
      await expect(executeUnifiedDiff(root, expectedHash, diff)).resolves.toMatchObject({
        status: 'failed',
      })
      expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe(source)
    }
  })

  it('does not write a unified diff when the hash is stale or approval is denied', async () => {
    const root = await temporaryDirectory()
    const source = 'before\n'
    await writeFile(join(root, 'notes.txt'), source, 'utf-8')
    const diff = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1 +1 @@', '-before', '+after', ''].join('\n')

    await expect(executeUnifiedDiff(root, '0'.repeat(64), diff)).resolves.toMatchObject({
      status: 'failed',
      reasonCode: 'TARGET_CHANGED',
    })
    await expect(executeUnifiedDiff(root, createHash('sha256').update(source).digest('hex'), diff, false)).resolves.toMatchObject({
      status: 'cancelled',
      reasonCode: 'APPROVAL_DENIED',
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe(source)
  })

  it('fails closed on a stale hash or ambiguous replacement', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'hello hello', 'utf-8')
    const currentHash = createHash('sha256').update('hello hello').digest('hex')

    const stale = await executeEdit(root, '0'.repeat(64), true)
    const ambiguous = await executeEdit(root, currentHash, true)

    expect(stale).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(ambiguous).toMatchObject({ status: 'failed', reasonCode: 'TARGET_CHANGED' })
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('hello hello')
  })
})

describe('workspace.create tool', () => {
  async function executeCreate(root: string, path: string, content: string, approved = true) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    autoApprove(runtime, approved)
    return runtime.executeTool({
      sessionId: session.id,
      call: {
        toolName: 'workspace.create',
        input: { workspaceId: 'workspace-1', path, content },
        preview: { summary: `Create ${path}`, paths: [path], truncated: false },
      },
    })
  }

  it('creates an approved new file with checkpoint and hash', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'notes'))

    const result = await executeCreate(root, 'notes/test.md', '# hello\n')

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        path: 'notes/test.md',
        changedPaths: ['notes/test.md'],
        sha256: createHash('sha256').update('# hello\n').digest('hex'),
        bytes: 8,
        checkpointId: expect.any(String),
      },
    })
    expect(await readFile(join(root, 'notes/test.md'), 'utf-8')).toBe('# hello\n')
  })

  it('does not create when approval is denied', async () => {
    const root = await temporaryDirectory()
    const result = await executeCreate(root, 'test.md', 'content', false)
    expect(result).toMatchObject({ status: 'cancelled', reasonCode: 'APPROVAL_DENIED' })
    await expect(readFile(join(root, 'test.md'), 'utf-8')).rejects.toThrow()
  })

  it.each([
    ['existing file', async (root: string) => { await writeFile(join(root, 'exists.txt'), 'x') }, 'exists.txt'],
    ['missing parent', async () => {}, 'missing/child.txt'],
    ['sensitive path', async () => {}, '.env.production'],
    ['traversal', async () => {}, '../escape.txt'],
  ])('fails closed for %s', async (_case, prepare, path) => {
    const root = await temporaryDirectory()
    await prepare(root)
    const result = await executeCreate(root, path, 'content')
    expect(result.status).toBe('failed')
  })
})

describe('workspace.search tool', () => {
  async function executeSearch(root: string, input: Record<string, unknown>) {
    const runtime = new WorkspaceAgentRuntime(async () => root)
    registerWorkspaceTools(runtime.registry)
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    return runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.search', input: { workspaceId: 'workspace-1', ...input } },
    })
  }

  it('finds case-insensitive matches with paths and line numbers, skipping noise directories', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'main.ts'), 'const Needle = 1\nother\nlower needle here\n')
    await writeFile(join(root, 'node_modules', 'dep.js'), 'needle in dependency')
    await writeFile(join(root, '.env'), 'NEEDLE=secret')

    const result = await executeSearch(root, { query: 'needle' })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      truncated: false,
      matches: [
        { path: 'src/main.ts', line: 1, text: 'const Needle = 1' },
        { path: 'src/main.ts', line: 3, text: 'lower needle here' },
      ],
    })
  })

  it('caps results and reports truncation', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'many.txt'), Array.from({ length: 10 }, () => 'match').join('\n'))

    const result = await executeSearch(root, { query: 'match', maxResults: 3 })

    expect(result.status).toBe('completed')
    expect((result.output as { matches: unknown[] }).matches).toHaveLength(3)
    expect(result.output).toMatchObject({ truncated: true })
  })

  it('rejects blank or oversized queries', async () => {
    const root = await temporaryDirectory()
    expect((await executeSearch(root, { query: '   ' })).status).toBe('failed')
    expect((await executeSearch(root, { query: 'x'.repeat(300) })).status).toBe('failed')
  })
})

describe('workspace.list tool', () => {
  it('executes as a read-only list action', async () => {
    const root = await temporaryDirectory()
    const runtime = new WorkspaceAgentRuntime(async () => root)

    registerWorkspaceTools(runtime.registry)
    expect(runtime.registry.get('workspace.list')?.actionRisk).toBe('list')
    const session = await runtime.createSession({ workspaceId: 'workspace-1', workspaceRoot: root })
    await expect(runtime.executeTool({
      sessionId: session.id,
      call: { toolName: 'workspace.list', input: { workspaceId: 'workspace-1' } },
    })).resolves.toMatchObject({
      status: 'completed',
      reasonCode: 'READ_ONLY_ALLOWED',
      policyDecision: { approvalDecision: 'not-required' },
    })
  })

  it('returns a deterministic tree bounded by depth', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'root.txt'), 'root')
    await writeFile(join(root, 'src', 'index.ts'), 'index')
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'deep')

    const result = await executeList(root, {
      workspaceId: 'workspace-1',
      path: '',
      depth: 2,
      maxEntries: 20,
    })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        workspaceId: 'workspace-1',
        path: '',
        depth: 2,
        truncated: false,
        entries: [
          { path: 'src', name: 'src', type: 'directory', depth: 1 },
          { path: 'src/nested', name: 'nested', type: 'directory', depth: 2 },
          { path: 'src/index.ts', name: 'index.ts', type: 'file', depth: 2 },
          { path: 'root.txt', name: 'root.txt', type: 'file', depth: 1 },
        ],
      },
    })
  })

  it.each(['../outside', 'C:\\outside', '/outside'])(
    'rejects paths outside the workspace: %s',
    async (path) => {
      const root = await temporaryDirectory()
      const result = await executeList(root, { workspaceId: 'workspace-1', path })

      expect(result).toMatchObject({ status: 'failed', output: undefined })
      expect(['ABSOLUTE_PATH', 'PATH_TRAVERSAL']).toContain(result.reasonCode)
    },
  )

  it('omits sensitive files, directories, and git metadata', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'secrets'))
    await writeFile(join(root, '.env.local'), 'TOKEN=secret')
    await writeFile(join(root, 'id_rsa'), 'private key')
    await writeFile(join(root, '.git', 'config'), 'git config')
    await writeFile(join(root, 'secrets', 'credentials.json'), 'credentials')
    await writeFile(join(root, 'visible.txt'), 'visible')

    const result = await executeList(root, { workspaceId: 'workspace-1', depth: 4 })

    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({
      entries: [{ path: 'visible.txt', name: 'visible.txt', type: 'file', depth: 1 }],
    })
  })

  it('does not follow symbolic links', async () => {
    const state = await temporaryDirectory()
    const root = join(state, 'workspace')
    const outside = join(state, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    try {
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) return
      throw error
    }

    const result = await executeList(root, { workspaceId: 'workspace-1', depth: 4 })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        entries: [{ path: 'inside.txt' }],
      },
    })
    expect(JSON.stringify(result.output)).not.toContain('secret.txt')
  })

  it('enforces entry limits and reports truncation', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'c.txt'), 'c')

    const result = await executeList(root, { workspaceId: 'workspace-1', maxEntries: 2 })
    const invalidDepth = await executeList(root, { workspaceId: 'workspace-1', depth: 5 })
    const invalidMaxEntries = await executeList(root, { workspaceId: 'workspace-1', maxEntries: 1001 })

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        entries: [{ path: 'a.txt' }, { path: 'b.txt' }],
        truncated: true,
      },
    })
    expect(invalidDepth).toMatchObject({ status: 'failed', output: undefined })
    expect(invalidMaxEntries).toMatchObject({ status: 'failed', output: undefined })
  })

  it('stops before filesystem access when cancelled', async () => {
    const root = await temporaryDirectory()
    const controller = new AbortController()
    controller.abort()

    await expect(workspaceListTool.execute(
      { workspaceId: 'workspace-1' },
      { workspaceId: 'workspace-1', workspaceRoot: root, signal: controller.signal },
    )).rejects.toThrow('workspace.list cancelled')
  })
})
