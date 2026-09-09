import { useWorkspaceStore } from '@/stores/workspace'
import { useAppStore } from '@/stores/app'
import { useI18n } from '@/i18n/useI18n'

export function StatusBar() {
  const { t } = useI18n('common')
  const terminals = useWorkspaceStore((s) => s.terminals)
  const activeTerminalId = useWorkspaceStore((s) => s.activeTerminalId)
  const loadState = useAppStore((s) => s.loadState)
  const blueprintMode = useAppStore((s) => s.blueprintMode)

  const focusedTerminal = activeTerminalId ? terminals.find((terminal) => terminal.id === activeTerminalId) ?? null : null

  const statusText: Record<string, string> = {
    'no-workspace': t('common:statusBar.waitingWorkspace'),
    'workspace-loaded': t('common:statusBar.workspaceLoaded'),
    'no-terminal': t('common:statusBar.waitingTerminal'),
    'terminal-active': focusedTerminal
      ? t('common:statusBar.terminalActiveFocused', { name: focusedTerminal.name, status: focusedTerminal.status })
      : t('common:statusBar.terminalActiveNoFocus', { count: terminals.length }),
  }

  return (
    <footer
      className="col-span-3 flex items-center px-3.5 text-[10px]"
      style={{
        background: 'var(--shell-chrome)',
        borderTop: '1px solid var(--shell-border)',
        color: 'var(--shell-dim)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <div
          className="h-[5px] w-[5px] rounded-full animate-pulse"
          style={{
            background: '#ff7830',
            boxShadow: '0 0 6px rgba(255, 120, 48, 0.6)',
          }}
        />
        <span>{blueprintMode ? t('common:statusBar.blueprintRunning') : (statusText[loadState] ?? t('common:statusBar.ready'))}</span>
      </div>
    </footer>
  )
}
