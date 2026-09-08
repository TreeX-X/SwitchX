import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '@/stores/workspace'
import type { TerminalPreset } from '@/types'
import { getTerminalPresetMeta } from '../../../shared/terminalLaunch'
import {
  launchTerminalPreset,
  warmDefaultShellCache,
  warmTerminalCreatePath,
} from '@/lib/terminal-launch'
import { useI18n } from '@/i18n/useI18n'

import terminalIcon from '@/assets/icons/terminal.svg'
import claudeIcon from '@/assets/icons/claude.svg'
import codexIcon from '@/assets/icons/codex.svg'
import opencodeIcon from '@/assets/icons/opencode.svg'
import janusIcon from '@/assets/icons/janus.svg'

const ICONS: Record<TerminalPreset, string> = {
  shell: terminalIcon,
  claude: claudeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
  janus: janusIcon,
}

interface TerminalOptionProps {
  preset: TerminalPreset
  name: string
  busy: boolean
  onClick: () => void
  onHover?: () => void
}

function TerminalOption({ preset, name, busy, onClick, onHover }: TerminalOptionProps) {
  const { t } = useI18n('terminal')
  return (
    <div
      onClick={busy ? undefined : onClick}
      className="w-full rounded-lg transition-all flex flex-col items-center justify-center gap-3 px-4 py-5 min-h-[132px]"
      style={{
        background: 'var(--shell-pane-chrome)',
        border: busy ? '1px solid rgba(255, 120, 48, 0.35)' : '1px solid var(--shell-border)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.72 : 1,
      }}
      onMouseEnter={(e) => {
        if (busy) return
        onHover?.()
        e.currentTarget.style.background = 'var(--shell-active)'
        e.currentTarget.style.borderColor = 'rgba(255, 120, 48, 0.3)'
        e.currentTarget.style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--shell-pane-chrome)'
        e.currentTarget.style.borderColor = busy
          ? 'rgba(255, 120, 48, 0.35)'
          : 'var(--shell-border)'
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      <div className="w-12 h-12 flex items-center justify-center">
        <img src={ICONS[preset]} alt={name} className="w-9 h-9" />
      </div>
      <div className="text-[13px] font-medium text-[#d4d4d4] leading-none text-center">
        {busy ? t('terminal:selector.starting') : name}
      </div>
    </div>
  )
}

export function TerminalSelector() {
  const { t } = useI18n('terminal')
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [launchingPreset, setLaunchingPreset] = useState<TerminalPreset | null>(null)

  useEffect(() => {
    warmDefaultShellCache()
    warmTerminalCreatePath()
  }, [])

  const handleSelect = useCallback(
    async (preset: TerminalPreset) => {
      if (!activeWorkspaceId || launchingPreset) return

      const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === activeWorkspaceId)
      if (!workspace) return

      setLaunchingPreset(preset)
      try {
        await launchTerminalPreset({
          preset,
          workspaceId: activeWorkspaceId,
          workspacePath: workspace.path,
        })
      } finally {
        setLaunchingPreset(null)
      }
    },
    [activeWorkspaceId, launchingPreset]
  )

  const handleHover = useCallback((preset: TerminalPreset) => {
    if (preset === 'shell') {
      warmDefaultShellCache()
      return
    }
    warmTerminalCreatePath([preset])
  }, [])

  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-6 px-4 py-8 sm:px-6 md:px-10"
      style={{
        background: 'var(--bg-deep)',
      }}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="text-sm text-[#8a8a8a] font-medium">{t('terminal:selector.title')}</div>
        <div className="text-[11px] text-[#5f5f5f] max-w-[520px] leading-relaxed">
          {t('terminal:selector.hint')}
        </div>
      </div>
      <div
        className="grid w-full max-w-[880px] gap-3 sm:gap-4"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 148px), 1fr))',
        }}
      >
        {(['shell', 'claude', 'codex', 'opencode', 'janus'] as TerminalPreset[]).map((preset) => (
          <TerminalOption
            key={preset}
            preset={preset}
            name={getTerminalPresetMeta(preset).label}
            busy={launchingPreset === preset}
            onClick={() => handleSelect(preset)}
            onHover={() => handleHover(preset)}
          />
        ))}
      </div>
    </div>
  )
}
