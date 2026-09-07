import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JanusWorkspaceFs } from '../../../src/main/janus-agent/environment/janus-workspace-fs'

const execFileAsync = promisify(execFile)

describe('JanusWorkspaceFs', () => {
  const workspaceFs = new JanusWorkspaceFs()
  let root = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'janusx-workspace-fs-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('distinguishes UTF-8 text from binary content and enforces size bounds', async () => {
    const textPath = join(root, 'text.md')
    const binaryPath = join(root, 'binary.dat')
    await fs.writeFile(textPath, '# JanusX\n')
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]))

    const text = await workspaceFs.readText(textPath)
    const binaryAsText = await workspaceFs.readText(binaryPath)
    const oversized = await workspaceFs.readBinary(textPath, 2)

    expect(text).toMatchObject({ ok: true, value: { content: '# JanusX\n' } })
    expect(binaryAsText).toMatchObject({ ok: false })
    expect(oversized).toMatchObject({ ok: false })
  })

  it('writes text atomically and creates missing parent directories', async () => {
    const target = join(root, 'nested', 'state.json')
    expect(await workspaceFs.writeText(target, '{"revision":1}')).toEqual({ ok: true, value: undefined })
    expect(await fs.readFile(target, 'utf8')).toBe('{"revision":1}')
    expect((await fs.readdir(join(root, 'nested'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('collects bounded text context while excluding ignored and sensitive files', async () => {
    await execFileAsync('git', ['init', '--quiet'], { cwd: root })
    await fs.writeFile(join(root, '.gitignore'), 'ignored.md\n')
    await fs.writeFile(join(root, 'included.md'), 'included evidence')
    await fs.writeFile(join(root, 'ignored.md'), 'ignored evidence')
    await fs.writeFile(join(root, '.env'), 'SECRET=hidden')
    await fs.writeFile(join(root, 'private.pem'), 'hidden key')
    await fs.writeFile(join(root, 'binary.md'), Buffer.from([0, 1, 2]))

    const context = await workspaceFs.collectTextContext(root, new AbortController().signal)

    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.value).toContain('included evidence')
    expect(context.value).not.toContain('ignored evidence')
    expect(context.value).not.toContain('SECRET=hidden')
    expect(context.value).not.toContain('hidden key')
  })

  it('stops before exceeding the context byte budget', async () => {
    await fs.writeFile(join(root, 'one.md'), '1234567890')
    await fs.writeFile(join(root, 'two.md'), 'abcdefghij')

    const context = await workspaceFs.collectTextContext(root, new AbortController().signal, {
      maxContextBytes: 40,
    })

    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(Buffer.byteLength(context.value)).toBeLessThanOrEqual(40)
    expect((context.value.match(/--- /g) ?? [])).toHaveLength(1)
  })

  it('does not include symlinked files in collected evidence', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'janusx-workspace-outside-'))
    try {
      await fs.writeFile(join(outside, 'secret.md'), 'outside evidence')
      try {
        await fs.symlink(join(outside, 'secret.md'), join(root, 'linked.md'))
      } catch {
        return
      }
      const context = await workspaceFs.collectTextContext(root, new AbortController().signal)
      expect(context).toMatchObject({ ok: true, value: expect.not.stringContaining('outside evidence') })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('returns hashes and source state for collected evidence', async () => {
    await fs.writeFile(join(root, 'evidence.md'), 'stable evidence')
    const result = await workspaceFs.collectTextEvidence(root, 'workspace-1', new AbortController().signal)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.manifest.workspaceId).toBe('workspace-1')
    expect(result.value.manifest.workspaceRootFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.value.manifest.files).toEqual([
      expect.objectContaining({ path: 'evidence.md', role: 'critical', sourceState: 'untracked', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ])
  })
})
