import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15000 })
  return stdout.trim()
}

export class GitAdapter {
  async getCurrentBranch(cwd: string): Promise<string> {
    return git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  }

  async hashObject(cwd: string, filePath: string): Promise<string> {
    return git(cwd, 'hash-object', filePath)
  }

  async listTrackedFiles(cwd: string): Promise<string[]> {
    try {
      const output = await git(cwd, 'ls-files', '--cached', '--others', '--exclude-standard')
      return output ? output.split('\n').filter(Boolean) : []
    } catch {
      return []
    }
  }

  async diff(cwd: string, ...paths: string[]): Promise<string> {
    try {
      return await git(cwd, 'diff', '--', ...paths)
    } catch {
      return ''
    }
  }
}
