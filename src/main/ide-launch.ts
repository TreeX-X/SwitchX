export function buildVSCodeLaunchArgs(workspacePath: string): string[] {
  return ['--new-window', workspacePath]
}
