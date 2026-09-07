import { useState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { Globe, SquareTerminal, X } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAppStore } from '@/stores/app'
import { useBrowserStore } from '@/stores/browser'
import { BrowserSurface } from './browser/BrowserSurface'
import { destroyBrowserSurface, popOutBrowserSurface } from '@/services/browser'
import { QuickNote } from './note/QuickNote'
import { applyTerminalNoteLifecycle, DRAWER_VIEWS, DrawerViewTabs, getDrawerHeight, getDrawerPanelAttributes, type DrawerView } from './note/quick-note-behavior'
import { CLITerminal } from './CLITerminal'
import { HoldToConfirm } from './ui/HoldToConfirm'
import { JanusChatPane } from './janus/JanusChatPane'
import { useOptionalJanusChatController } from './janus/JanusChatProvider'
import { useI18n } from '@/i18n/useI18n'
import { getContextPopoverPosition, type PopoverAnchorRect, type PopoverSize } from './context-popover-position'
import type { TerminalPreset, Terminal } from '@/types'
import {
  clearBrowserTabDragData,
  clearTerminalDragData,
  getActiveBrowserTabDragId,
  getActiveTerminalDragId,
  hasBrowserTabDrag,
  hasTerminalDrag,
  hasWorkspaceFileDrag,
  readBrowserTabDragData,
  readTerminalDragData,
  setBrowserTabDragData,
  setTerminalDragData,
} from '@/lib/terminal-file-reference'
import {
  getLeafPanes,
  type PaneDropEdge,
  type WorkspacePaneLeaf,
  type WorkspacePaneNode,
  type WorkspacePaneSplit,
} from '@/lib/workspace-pane'
import { getPaneDropHint, paneDropHintLabel, SPLIT_RATIO_EQUAL, type PaneDropHint } from '@/lib/pane-drop-hint'
import { resolveContextWindows } from '@/lib/runtime-telemetry'
import { getTerminalPresetMeta } from '../../../shared/terminalLaunch'
import {
  launchTerminalPreset,
  retryTerminalCreate,
  warmDefaultShellCache,
  warmTerminalCreatePath,
} from '@/lib/terminal-launch'
import { useTerminalLifecycle } from '@/features/terminal/useTerminalLifecycle'
import {
  buildWorkspaceTerminalSurfaces,
  HOT_WORKSPACE_EVICTION_GRACE_MS,
  MAX_HOT_WORKSPACE_SURFACES,
  touchWorkspaceSurfaceRecency,
} from '@/lib/workspace-front-surface'

import terminalIcon from '@/assets/icons/terminal.svg'
import claudeIcon from '@/assets/icons/claude.svg'
import codexIcon from '@/assets/icons/codex.svg'
import opencodeIcon from '@/assets/icons/opencode.svg'
import janusIcon from '@/assets/icons/janus.svg'

function JanusChatTabTitle({ conversationId }: { conversationId: string }) {
  const { t } = useI18n('terminal')
  const chat = useOptionalJanusChatController()
  return chat?.conversations.find((conversation) => conversation.id === conversationId)?.title ?? t('terminal:tab.janusChatFallback')
}

const PRESET_ICONS: Record<TerminalPreset, string> = {
  shell: terminalIcon,
  claude: claudeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
  janus: janusIcon,
}

type TerminalPresetOption = { type: TerminalPreset; name: string; icon: string }

function createPreset(type: TerminalPreset): TerminalPresetOption {
  return { type, name: getTerminalPresetMeta(type).label, icon: PRESET_ICONS[type] }
}

const PRESETS: TerminalPresetOption[] = [
  createPreset('shell'),
  createPreset('claude'),
  createPreset('codex'),
  createPreset('opencode'),
  createPreset('janus'),
]

// 收起态 24×24 圆角 4,与工具栏相邻 h-6 w-6 rounded 按钮对齐
const TERMINAL_MENU_COLLAPSED_SIZE = 24
// 展开宽度与内容精确匹配: pl-2(8) + 5×28 图标 + 4×4 gap + pr-1(4) + 28 加号 + 2 边框
const TERMINAL_MENU_EXPANDED_WIDTH = 198
const TERMINAL_MENU_EXPANDED_HEIGHT = 28

function providerLabel(preset: TerminalPreset, t: (key: string) => string): string {
  switch (preset) {
    case 'claude':
      return t('terminal:provider.claude')
    case 'codex':
      return t('terminal:provider.codex')
    case 'opencode':
      return t('terminal:provider.opencode')
    case 'janus':
      return t('terminal:provider.janus')
    case 'shell':
      return t('terminal:provider.shell')
  }
}

function accentColor(status: Terminal['status']): string {
  if (status === 'running') return '#ff7830'
  if (status === 'error') return '#ff5858'
  return '#58a6ff'
}

function formatAge(updatedAt?: number): string {
  if (!updatedAt) return 'unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function formatTokenCount(value?: number): string {
  if (!value) return '0'
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}

function formatExactTokenCount(value?: number): string {
  return value === undefined ? '' : value.toLocaleString('en-US')
}

function modelLabel(terminal: Terminal, t: (k: string) => string): string {
  if (terminal.preset === 'shell') return t('terminal:model.na')
  return terminal.detectedModel ?? t('terminal:model.detecting')
}

function contextWindow(terminal: Terminal): number | undefined {
  return resolveContextWindows(
    terminal.preset,
    terminal.detectedModel,
    terminal.contextWindowTokens,
  ).effectiveWindow
}

function telemetryQualityLabel(terminal: Terminal, t: (k: string) => string): string {
  if (terminal.telemetryConfidence === 'authoritative') return t('terminal:telemetry.quality.authoritative')
  if (terminal.telemetryConfidence === 'derived') return t('terminal:telemetry.quality.derived')
  if (terminal.telemetryConfidence === 'declared') return t('terminal:telemetry.quality.declared')
  if (terminal.telemetryConfidence === 'estimated') return t('terminal:telemetry.quality.estimated')
  return t('terminal:telemetry.quality.unknown')
}

function contextRatio(terminal: Terminal): number | undefined {
  const windowTokens = contextWindow(terminal)
  if (!windowTokens || terminal.contextTokens === undefined) return undefined
  return Math.min(1, terminal.contextTokens / windowTokens)
}

/** 上下文渐变颜色：用量越多越红，越接近满越警告。
 *  0%   → 冷青蓝（#58a6ff，宽裕）
 *  50%  → 暖橙（#ff7830，正常）
 *  85%+ → 警告红（#ff5858，逼近上限） */
function contextRatioColor(ratio: number | undefined): string {
  if (ratio === undefined) return 'rgba(255,255,255,0.18)'
  const r = Math.max(0, Math.min(1, ratio))
  // 三段插值：[0,0.5] 青蓝→橙，[0.5,0.85] 橙→红，[0.85,1] 红加深
  if (r <= 0.5) {
    const t = r / 0.5
    return mixColor([0x58, 0xa6, 0xff], [0xff, 0x78, 0x30], t)
  }
  if (r <= 0.85) {
    const t = (r - 0.5) / 0.35
    return mixColor([0xff, 0x78, 0x30], [0xff, 0x58, 0x58], t)
  }
  const t = (r - 0.85) / 0.15
  return mixColor([0xff, 0x58, 0x58], [0xe0, 0x2b, 0x2b], t)
}

function mixColor(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function contextLabel(terminal: Terminal, t: (k: string) => string): string {
  if (terminal.contextTokens === undefined) return t('terminal:telemetry.contextUnknown')
  const used = terminal.contextTokens
  const windowTokens = contextWindow(terminal)
  if (!windowTokens) return `${formatTokenCount(used)} ctx`
  return `${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} ${t('terminal:telemetry.sessionSuffix')}`
}

function contextPercentLabel(terminal: Terminal): string {
  const ratio = contextRatio(terminal)
  return ratio === undefined ? '--' : `${(ratio * 100).toFixed(1)}%`
}

interface ContextUsagePopoverProps {
  terminal: Terminal
  children: ReactNode
  className: string
  style?: CSSProperties
  interactive?: boolean
  clickable?: boolean
}

type ContextPopoverRow = [label: string, value: string]

function ContextPopoverRows({ rows }: { rows: ContextPopoverRow[] }) {
  return rows.map(([label, value]) => (
    <div key={label} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-1">
      <span className="truncate text-[#858585]">{label}</span>
      <span className="min-w-0 max-w-[170px] truncate text-right text-[#ededed]">{value}</span>
    </div>
  ))
}

function ContextUsagePopover({
  terminal,
  children,
  className,
  style,
  interactive = true,
  clickable = false,
}: ContextUsagePopoverProps) {
  const { t } = useI18n('terminal')
  const popoverId = useId()
  const triggerRef = useRef<HTMLButtonElement | HTMLSpanElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [anchorRect, setAnchorRect] = useState<PopoverAnchorRect | null>(null)
  const [openMode, setOpenMode] = useState<'closed' | 'preview' | 'details'>('closed')
  const [popoverSize, setPopoverSize] = useState<PopoverSize>({ width: 320, height: 230 })
  const windows = resolveContextWindows(
    terminal.preset,
    terminal.detectedModel,
    terminal.contextWindowTokens,
  )
  const windowTokens = windows.effectiveWindow
  const remainingTokens = windowTokens !== undefined && terminal.contextTokens !== undefined
    ? Math.max(0, windowTokens - terminal.contextTokens)
    : undefined
  const compacted = terminal.compactionCountConfidence === 'exact'
    ? String(terminal.compactionCount ?? 0)
    : undefined
  const sessionSummaryRows = [
    terminal.inputTokens === undefined ? null : [t('terminal:context.row.sessionInput'), formatExactTokenCount(terminal.inputTokens)],
    terminal.outputTokens === undefined ? null : [t('terminal:context.row.sessionOutput'), formatExactTokenCount(terminal.outputTokens)],
    terminal.totalTokens === undefined ? null : [t('terminal:context.row.sessionTotal'), formatExactTokenCount(terminal.totalTokens)],
  ].filter((row): row is ContextPopoverRow => row !== null)
  const capacityRows = [
    windows.runtimeWindow === undefined ? null : [t('terminal:context.row.runtimeWindow'), formatExactTokenCount(windows.runtimeWindow)],
    windows.modelCapacity === undefined ? null : [t('terminal:context.row.modelCapacity'), formatExactTokenCount(windows.modelCapacity)],
    remainingTokens === undefined ? null : [t('terminal:context.row.remaining'), formatExactTokenCount(remainingTokens)],
    compacted === undefined ? null : [t('terminal:context.row.compactions'), compacted],
  ].filter((row): row is ContextPopoverRow => row !== null)
  const sessionDetailRows = [
    terminal.inputTokens === undefined ? null : [t('terminal:context.row.sessionInput'), formatExactTokenCount(terminal.inputTokens)],
    terminal.outputTokens === undefined ? null : [t('terminal:context.row.sessionOutput'), formatExactTokenCount(terminal.outputTokens)],
    terminal.cacheReadTokens === undefined ? null : [t('terminal:context.row.cacheRead'), formatExactTokenCount(terminal.cacheReadTokens)],
    terminal.cacheWriteTokens === undefined ? null : [t('terminal:context.row.cacheWrite'), formatExactTokenCount(terminal.cacheWriteTokens)],
    terminal.totalTokens === undefined ? null : [t('terminal:context.row.sessionTotal'), formatExactTokenCount(terminal.totalTokens)],
  ].filter((row): row is ContextPopoverRow => row !== null)
  const telemetrySource = terminal.telemetrySource
    ? t(`terminal:context.source.${terminal.telemetrySource}`)
    : null
  const telemetryRows = [
    [t('terminal:context.row.sessionBinding'), terminal.telemetrySessionBinding === 'exact' ? t('terminal:telemetry.binding.exact') : t('terminal:telemetry.binding.pending')],
    terminal.modelChangedAt === undefined ? null : [t('terminal:context.row.modelChanged'), formatAge(terminal.modelChangedAt)],
    telemetrySource === null ? null : [t('terminal:context.row.usageSource'), `${telemetryQualityLabel(terminal, t)} · ${telemetrySource}`],
    [t('terminal:context.row.windowSource'), t(`terminal:context.windowSource.${windows.effectiveSource}`)],
    terminal.telemetryUpdatedAt === undefined ? null : [t('terminal:context.row.updated'), formatAge(terminal.telemetryUpdatedAt)],
  ].filter((row): row is ContextPopoverRow => row !== null)

  const open = useCallback((mode: 'preview' | 'details') => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setAnchorRect({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width })
    setOpenMode(mode)
  }, [])

  const close = useCallback(() => {
    setOpenMode('closed')
    setAnchorRect(null)
  }, [])

  useLayoutEffect(() => {
    if (openMode === 'closed' || !popoverRef.current) return
    const rect = popoverRef.current.getBoundingClientRect()
    if (rect.width !== popoverSize.width || rect.height !== popoverSize.height) {
      setPopoverSize({ width: rect.width, height: rect.height })
    }
  }, [openMode, popoverSize.height, popoverSize.width])

  useEffect(() => {
    if (openMode === 'closed') return
    const handleViewportChange = () => close()
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [close, openMode])

  useEffect(() => {
    if (openMode !== 'details') return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, openMode])

  useEffect(() => close(), [close, terminal.id])

  const position = anchorRect
    ? getContextPopoverPosition(anchorRect, popoverSize, { width: window.innerWidth, height: window.innerHeight })
    : null

  const popover = position && createPortal(
    <div
      id={popoverId}
      ref={popoverRef}
      role={openMode === 'details' ? 'dialog' : 'tooltip'}
      aria-label={t('terminal:context.popoverTitle')}
      className={`fixed z-50 w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border px-4 py-3.5 text-left font-mono text-[11px] shadow-[0_18px_42px_rgba(0,0,0,0.48)] ${openMode === 'details' ? 'pointer-events-auto max-h-[calc(100vh-16px)]' : 'pointer-events-none'}`}
      style={{
        top: position.top,
        left: position.left,
        borderColor: 'rgba(255,255,255,0.12)',
        background: 'var(--shell-chrome-raised)',
        color: '#e8e8e8',
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-[0.12em] text-[#8c8c8c]">{t('terminal:context.popoverTitle')}</span>
          <span className="mt-1 block truncate text-[12px] text-[#d9d9d9]">
            {terminal.contextTokens === undefined || windowTokens === undefined
              ? t('terminal:telemetry.contextUnknown')
              : `${formatExactTokenCount(terminal.contextTokens)} / ${formatExactTokenCount(windowTokens)}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded border border-[rgba(255,255,255,0.08)] px-1.5 py-0.5 text-[9px] uppercase text-[#929292]">
            {telemetryQualityLabel(terminal, t)}
          </span>
          <span className="text-[18px] leading-none" style={{ color: contextRatioColor(contextRatio(terminal)) }}>
            {contextPercentLabel(terminal)}
          </span>
        </span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[rgba(255,255,255,0.07)]">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.round((contextRatio(terminal) ?? 0) * 100)}%`,
            background: contextRatioColor(contextRatio(terminal)),
          }}
        />
      </div>
      {(remainingTokens !== undefined || compacted !== undefined) && (
        <div className="grid grid-cols-2 gap-x-5 border-t border-[rgba(255,255,255,0.07)] py-2.5">
          {remainingTokens !== undefined && (
            <div className="min-w-0">
              <div className="text-[9px] uppercase text-[#777]">{t('terminal:context.row.remaining')}</div>
              <div className="mt-1 truncate text-[13px] text-[#ededed]">{formatExactTokenCount(remainingTokens)}</div>
            </div>
          )}
          {compacted !== undefined && (
            <div className="min-w-0">
              <div className="text-[9px] uppercase text-[#777]">{t('terminal:context.row.compactions')}</div>
              <div className="mt-1 truncate text-[13px] text-[#ededed]">{compacted}</div>
            </div>
          )}
        </div>
      )}
      {openMode === 'preview' ? (
        sessionSummaryRows.length > 0 && (
          <div className="border-t border-[rgba(255,255,255,0.07)] pt-2.5">
            <div className="mb-1 text-[9px] uppercase tracking-[0.1em] text-[#777]">{t('terminal:context.section.session')}</div>
            <ContextPopoverRows rows={sessionSummaryRows} />
          </div>
        )
      ) : (
        <div className="space-y-3 border-t border-[rgba(255,255,255,0.07)] pt-3">
          {capacityRows.length > 0 && (
            <section>
              <h3 className="mb-1 text-[9px] uppercase tracking-[0.1em] text-[#777]">{t('terminal:context.section.capacity')}</h3>
              <ContextPopoverRows rows={capacityRows} />
            </section>
          )}
          {sessionDetailRows.length > 0 && (
            <section className="border-t border-[rgba(255,255,255,0.07)] pt-3">
              <h3 className="mb-1 text-[9px] uppercase tracking-[0.1em] text-[#777]">{t('terminal:context.section.session')}</h3>
              <ContextPopoverRows rows={sessionDetailRows} />
            </section>
          )}
          {telemetryRows.length > 0 && (
            <section className="border-t border-[rgba(255,255,255,0.07)] pt-3">
              <h3 className="mb-1 text-[9px] uppercase tracking-[0.1em] text-[#777]">{t('terminal:context.section.telemetry')}</h3>
              <ContextPopoverRows rows={telemetryRows} />
            </section>
          )}
        </div>
      )}
      {terminal.telemetryUpdatedAt !== undefined && openMode === 'preview' && (
        <div className="mt-2.5 border-t border-[rgba(255,255,255,0.07)] pt-2 text-[9px] text-[#686868]">
          {t('terminal:context.updatedAgo', { age: formatAge(terminal.telemetryUpdatedAt) })}
        </div>
      )}
    </div>,
    document.body,
  )

  const triggerEvents = {
    onMouseEnter: () => {
      if (openMode === 'closed') open('preview')
    },
    onMouseLeave: () => {
      if (openMode === 'preview') close()
    },
  }

  if (!interactive) {
    return (
      <span
        ref={(node) => { triggerRef.current = node }}
        className={className}
        style={style}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-controls={clickable && openMode === 'details' ? popoverId : undefined}
        aria-expanded={clickable ? openMode === 'details' : undefined}
        aria-haspopup={clickable ? 'dialog' : undefined}
        aria-label={clickable ? t('terminal:context.openDetailsAria') : undefined}
        onClick={clickable ? (event) => {
          event.stopPropagation()
          openMode === 'details' ? close() : open('details')
        } : undefined}
        onKeyDown={clickable ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            openMode === 'details' ? close() : open('details')
          }
        } : undefined}
        {...triggerEvents}
      >
        {children}
        {popover}
      </span>
    )
  }

  return (
    <button
      ref={(node) => { triggerRef.current = node }}
      type="button"
      className={className}
      style={style}
      aria-controls={openMode === 'details' ? popoverId : undefined}
      aria-expanded={openMode === 'details'}
      aria-haspopup="dialog"
      aria-label={t('terminal:context.openDetailsAria')}
      onFocus={() => {
        if (openMode === 'closed') open('preview')
      }}
      onBlur={() => {
        if (openMode === 'preview') close()
      }}
      onClick={() => openMode === 'details' ? close() : open('details')}
      {...triggerEvents}
    >
      {children}
      {popover}
    </button>
  )
}

/*-- pane tab 条上的浏览器标签：标题跟随 surface 活动 tab --*/
function BrowserPaneTabLabel({ surfaceId, isActive }: { surfaceId: string; isActive: boolean }) {
  const surface = useBrowserStore((s) => s.surfaces[surfaceId])
  const activeTab = surface?.tabs.find((tab) => tab.tabId === surface.activeTabId) ?? null
  return (
    <>
      <Globe size={13} aria-hidden="true" style={{ opacity: isActive ? 0.95 : 0.55, flexShrink: 0 }} />
      <span className="min-w-0 flex-1 truncate" style={{ color: isActive ? 'var(--shell-text)' : 'inherit' }}>
        {activeTab?.title || activeTab?.url || 'Browser'}
      </span>
    </>
  )
}

interface PaneTreeViewProps {
  node: WorkspacePaneNode | null
  workspaceVisible: boolean
  terminalsById: Map<string, Terminal>
  focusedPaneId: string | null
  activeTerminalId: string | null
  showFocusChrome: boolean
  onPaneFocus: (paneId: string) => void
  onTabSelect: (paneId: string, tabId: string) => void
  onKillTerminalFromTab: (terminalId: string, e?: React.MouseEvent) => void
  onClosePaneTab: (paneId: string, tabId: string) => void
  onOpenBrowser: (paneId: string) => void
  onCloseBrowserTab: (paneId: string, tabId: string, surfaceId: string) => void
  onBrowserPopOut: (paneId: string, tabId: string, surfaceId: string) => void
  onBrowserTabDragStart: (surfaceId: string) => void
  onBrowserTabDrop: (surfaceId: string, paneId: string, edge: PaneDropEdge | null, ratio: number) => void
  activeDragBrowserSurfaceId: string | null
  activeDragBrowserSurfaceRef: React.MutableRefObject<string | null>
  onKillTerminal: (terminalId: string, event?: React.MouseEvent) => void
  onTerminalDrop: (terminalId: string, paneId: string, edge: PaneDropEdge | null, ratio: number) => void
  onTerminalDragStart: (terminalId: string) => void
  onTerminalDragEnd: () => void
  activeDragTerminalId: string | null
  activeDragTerminalRef: React.MutableRefObject<string | null>
  onResize: (splitId: string, ratio: number) => void
  terminalMenuPaneId: string | null
  onToggleTerminalMenu: (paneId: string) => void
  onCreateTerminal: (preset: TerminalPresetOption) => void
}

function PaneTreeView(props: PaneTreeViewProps) {
  const { t } = useI18n('terminal')
  if (!props.node) {
    return (
      <div className="flex h-full items-center justify-center text-sm font-mono text-[#666]">
        {t('terminal:paneTree.waitingTerminal')}
      </div>
    )
  }

  if (props.node.type === 'split') {
    return <SplitPaneNode split={props.node} {...props} />
  }

  return <LeafPane leaf={props.node} {...props} />
}

function SplitPaneNode({ split, onResize, ...props }: PaneTreeViewProps & { split: WorkspacePaneSplit }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isHorizontal = split.direction === 'horizontal'

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const container = containerRef.current
      if (!container) return

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const rect = container.getBoundingClientRect()
        const rawRatio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        onResize(split.id, rawRatio)
      }

      const handlePointerUp = () => {
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', handlePointerUp)
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
    },
    [isHorizontal, onResize, split.id]
  )

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      <div className="min-h-0 min-w-0" style={{ flexBasis: `${split.ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}>
        <PaneTreeView {...props} node={split.first} onResize={onResize} />
      </div>
      {/* Soft gutter between cards; transparent hit strip keeps resize easy */}
      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        onPointerDown={handlePointerDown}
        className="shrink-0 transition-colors hover:bg-[rgba(255,120,48,0.2)]"
        style={{
          width: isHorizontal ? 8 : '100%',
          height: isHorizontal ? '100%' : 8,
          cursor: isHorizontal ? 'col-resize' : 'row-resize',
          background: 'transparent',
        }}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaneTreeView {...props} node={split.second} onResize={onResize} />
      </div>
    </div>
  )
}

function TerminalPresetCapsule({
  open,
  onToggle,
  onSelect,
}: {
  open: boolean
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void
  onSelect: (preset: TerminalPresetOption) => void
}) {
  return (
    <div
      data-terminal-menu-root="true"
      className="flex shrink-0 items-center overflow-hidden border font-mono"
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        width: open ? TERMINAL_MENU_EXPANDED_WIDTH : TERMINAL_MENU_COLLAPSED_SIZE,
        height: open ? TERMINAL_MENU_EXPANDED_HEIGHT : TERMINAL_MENU_COLLAPSED_SIZE,
        borderRadius: open ? 999 : 4,
        borderColor: open ? 'rgba(255,120,48,0.28)' : 'var(--shell-border)',
        background: open ? 'var(--shell-active)' : 'var(--shell-chrome-raised)',
        boxShadow: open
          ? '0 8px 22px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.08)'
          : 'inset 0 1px 0 rgba(255,255,255,0.04)',
        transition:
          'width 220ms cubic-bezier(0.2, 0.8, 0.2, 1), height 220ms cubic-bezier(0.2, 0.8, 0.2, 1), border-radius 220ms cubic-bezier(0.2, 0.8, 0.2, 1), background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
      }}
    >
      <div
        className="flex min-w-0 flex-1 items-center justify-end gap-1"
        style={{
          // padding 受控:收起时归零,否则 12px 固定 padding 不参与 flex 收缩,会把加号挤出内腔
          paddingLeft: open ? 8 : 0,
          paddingRight: open ? 4 : 0,
          opacity: open ? 1 : 0,
          transform: open ? 'translateX(0)' : 'translateX(10px)',
          pointerEvents: open ? 'auto' : 'none',
          // 收回时淡出与宽度收缩同曲线,略先于收缩完成,避免图标被 overflow 硬裁切
          transition: open
            ? 'opacity 120ms ease 80ms, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1) 40ms, padding 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'
            : 'opacity 160ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), padding 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {PRESETS.map((preset) => (
          <button
            key={preset.type}
            type="button"
            title={preset.name}
            aria-label={`New ${preset.name} terminal`}
            tabIndex={open ? 0 : -1}
            className="flex h-6 w-7 shrink-0 items-center justify-center rounded-full border transition-[background,border-color,transform] hover:scale-[1.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,120,48,0.35)]"
            style={{
              borderColor: 'rgba(255,255,255,0.1)',
              background: 'var(--shell-hover)',
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(preset)
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.borderColor = 'rgba(255,120,48,0.46)'
              event.currentTarget.style.background = 'rgb(36, 27, 21)'
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
              event.currentTarget.style.background = 'var(--shell-hover)'
            }}
          >
            <img src={preset.icon} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <button
        type="button"
        title={open ? 'Close terminal menu' : 'New Terminal'}
        aria-label={open ? 'Close terminal menu' : 'New Terminal'}
        className="flex h-full shrink-0 items-center justify-center border-0 bg-transparent hover:bg-[rgba(255,255,255,0.055)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[rgba(255,120,48,0.35)]"
        style={{
          // 收起态填满 24px 胶囊(扣除边框),展开态恢复 28px,与容器同曲线过渡
          width: open ? 28 : TERMINAL_MENU_COLLAPSED_SIZE - 2,
          color: open ? '#ffb27d' : '#999',
          // hover 背景跟随胶囊圆角
          borderRadius: 'inherit',
          transition: 'width 220ms cubic-bezier(0.2, 0.8, 0.2, 1), color 180ms ease, background-color 150ms ease',
        }}
        onClick={onToggle}
      >
        {/* 用两条细条绘制 +,文本字形在行框内偏上,旋转 45° 后偏差会沿对角放大 */}
        <span
          aria-hidden="true"
          className="relative block h-[9px] w-[9px] transition-transform duration-200 ease-out"
          style={{ transform: open ? 'rotate(45deg)' : 'rotate(0deg)' }}
        >
          <span className="absolute left-0 top-[4px] h-px w-full bg-current" />
          <span className="absolute left-[4px] top-0 h-full w-px bg-current" />
        </span>
      </button>
    </div>
  )
}

function LeafPane({
  leaf,
  workspaceVisible,
  terminalsById,
  focusedPaneId,
  showFocusChrome,
  onPaneFocus,
  onTabSelect,
  onKillTerminalFromTab,
  onClosePaneTab,
  onOpenBrowser,
  onCloseBrowserTab,
  onBrowserPopOut,
  onBrowserTabDragStart,
  onBrowserTabDrop,
  activeDragBrowserSurfaceId,
  activeDragBrowserSurfaceRef,
  onKillTerminal,
  onTerminalDrop,
  onTerminalDragStart,
  onTerminalDragEnd,
  activeDragTerminalId,
  activeDragTerminalRef,
  terminalMenuPaneId,
  onToggleTerminalMenu,
  onCreateTerminal,
}: PaneTreeViewProps & { leaf: WorkspacePaneLeaf }) {
  const { t } = useI18n('terminal')
  const [dragHint, setDragHint] = useState<{ zone: PaneDropHint; ratio: number } | null>(null)
  const isFocused = leaf.id === focusedPaneId
  const showFocus = showFocusChrome && isFocused
  const activeTabId = leaf.activeTabId ?? leaf.tabs[0]?.id ?? null
  const activeTab = activeTabId ? leaf.tabs.find((tab) => tab.id === activeTabId) ?? null : null
  const activeTerminal = activeTab?.type === 'terminal' ? terminalsById.get(activeTab.terminalId) ?? null : null
  const terminalMenuOpen = terminalMenuPaneId === leaf.id

  const openMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onToggleTerminalMenu(leaf.id)
    },
    [leaf.id, onToggleTerminalMenu]
  )

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (hasWorkspaceFileDrag(event.dataTransfer)) return

    const dragTerminalId =
      readTerminalDragData(event.dataTransfer) ||
      activeDragTerminalId ||
      activeDragTerminalRef.current ||
      getActiveTerminalDragId()
    const dragBrowserSurfaceId =
      readBrowserTabDragData(event.dataTransfer) ||
      activeDragBrowserSurfaceId ||
      activeDragBrowserSurfaceRef.current ||
      getActiveBrowserTabDragId()
    if (!hasTerminalDrag(event.dataTransfer) && !dragTerminalId && !hasBrowserTabDrag(event.dataTransfer) && !dragBrowserSurfaceId) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const zone = getPaneDropHint(event.currentTarget, event.clientX, event.clientY)
    /*-- 预览比例 = 松手后实际应用的比例（预览即结果）：落点分屏固定平分 --*/
    const ratio = SPLIT_RATIO_EQUAL
    setDragHint((current) => (current && current.zone === zone && current.ratio === ratio ? current : { zone, ratio }))
  }, [activeDragTerminalId, activeDragBrowserSurfaceId])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (hasWorkspaceFileDrag(event.dataTransfer)) return

    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragHint(null)
    }
  }, [])

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (hasWorkspaceFileDrag(event.dataTransfer)) return

    const dragTerminalId =
      readTerminalDragData(event.dataTransfer) ||
      activeDragTerminalId ||
      activeDragTerminalRef.current ||
      getActiveTerminalDragId()
    const dragBrowserSurfaceId =
      readBrowserTabDragData(event.dataTransfer) ||
      activeDragBrowserSurfaceId ||
      activeDragBrowserSurfaceRef.current ||
      getActiveBrowserTabDragId()
    if (!hasTerminalDrag(event.dataTransfer) && !dragTerminalId && !hasBrowserTabDrag(event.dataTransfer) && !dragBrowserSurfaceId) return
    event.preventDefault()
    event.stopPropagation()
    const hint = getPaneDropHint(event.currentTarget, event.clientX, event.clientY)
    /*-- center = 合并到本 pane（move 语义）；边缘 = 平分分屏（与预览一致） --*/
    const edge: PaneDropEdge | null = hint === 'center' ? null : hint
    const ratio = SPLIT_RATIO_EQUAL
    setDragHint(null)
    if (dragBrowserSurfaceId && !dragTerminalId) {
      onBrowserTabDrop(dragBrowserSurfaceId, leaf.id, edge, ratio)
      return
    }
    const terminalId = dragTerminalId
    if (!terminalId) return
    onTerminalDrop(terminalId, leaf.id, edge, ratio)
  }, [activeDragTerminalId, activeDragBrowserSurfaceId, leaf.id, onTerminalDrop, onBrowserTabDrop])

  return (
      <section
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden transition-[border-color,box-shadow,background,border-radius]"
      onPointerDownCapture={() => onPaneFocus(leaf.id)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        // Multi-pane: rounded card chrome with gap-friendly silhouette.
        // Single-pane: lighter radius so it stays intentional without double-framing.
        borderRadius: showFocusChrome ? 11 : 8,
        background: showFocus ? 'var(--shell-pane-chrome)' : 'var(--shell-pane)',
        border: showFocus ? '1px solid rgba(255,120,48,0.28)' : '1px solid var(--shell-border)',
        boxShadow: showFocus
          ? '0 0 0 1px rgba(255,120,48,0.08), inset 0 0 0 1px rgba(255,120,48,0.05), 0 6px 18px rgba(0,0,0,0.28)'
          : showFocusChrome
            ? '0 1px 0 rgba(255,255,255,0.035), 0 6px 16px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.03)'
            : 'inset 0 1px 0 rgba(255,255,255,0.025)',
      }}
    >
      {dragHint && (
        <div
          className="pointer-events-none absolute z-20 flex items-center justify-center"
          style={{
            /*-- 预览区域 = 松手后新 pane 的真实占比（first/second 语义与 splitPaneTree 一致） --*/
            top: dragHint.zone === 'bottom' ? `${dragHint.ratio * 100}%` : 0,
            right: dragHint.zone === 'left' ? `${(1 - dragHint.ratio) * 100}%` : 0,
            bottom: dragHint.zone === 'top' ? `${(1 - dragHint.ratio) * 100}%` : 0,
            left: dragHint.zone === 'right' ? `${dragHint.ratio * 100}%` : 0,
            background: dragHint.zone === 'center' ? 'rgba(255,255,255,0.05)' : 'rgba(255,120,48,0.12)',
            border: dragHint.zone === 'center'
              ? '1px solid rgba(255,255,255,0.16)'
              : '1px solid rgba(255,120,48,0.58)',
            boxShadow: dragHint.zone === 'center' ? 'none' : 'inset 0 0 22px rgba(255,120,48,0.08)',
            transition: 'top 70ms ease-out, right 70ms ease-out, bottom 70ms ease-out, left 70ms ease-out',
            animation: 'pane-drop-hint-in 110ms ease-out',
          }}
        >
          {/*-- 预览语义标签：让落点结果（分屏方向/合并）在松手前自解释 --*/}
          <span
            className="rounded-full border px-2.5 py-1 font-mono text-[11px] leading-none"
            style={{
              color: dragHint.zone === 'center' ? 'rgba(255,255,255,0.82)' : '#ffc6a6',
              borderColor: dragHint.zone === 'center' ? 'rgba(255,255,255,0.2)' : 'rgba(255,120,48,0.4)',
              background: 'rgba(10,10,12,0.78)',
            }}
          >
            {paneDropHintLabel(dragHint.zone)}
          </span>
        </div>
      )}
      <div
        className="flex h-8 shrink-0 items-stretch gap-0 overflow-x-auto px-1"
        style={{
          background: showFocus ? 'rgba(244, 125, 67, 0.035)' : 'rgba(255, 255, 255, 0.018)',
          borderBottom: '1px solid var(--shell-border)',
          scrollbarWidth: 'none',
        }}
      >
        {leaf.tabs.map((tab) => {
          const terminal = tab.type === 'terminal' ? terminalsById.get(tab.terminalId) : undefined
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              draggable={tab.type === 'terminal' || tab.type === 'browser'}
              onDragStart={(event) => {
                if (tab.type === 'terminal') {
                  setTerminalDragData(event.dataTransfer, tab.terminalId)
                  onTerminalDragStart(tab.terminalId)
                  return
                }
                if (tab.type === 'browser') {
                  setBrowserTabDragData(event.dataTransfer, tab.surfaceId)
                  onBrowserTabDragStart(tab.surfaceId)
                }
              }}
              onDragEnd={() => {
                setDragHint(null)
                onTerminalDragEnd()
              }}
              onClick={() => onTabSelect(leaf.id, tab.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onTabSelect(leaf.id, tab.id)
              }}
              className="group/tab relative flex h-8 min-w-0 basis-[128px] shrink grow-0 cursor-pointer select-none items-center gap-1.5 border-0 border-r border-white/[0.06] px-2.5 text-left font-mono text-[11px] leading-none transition-colors hover:bg-white/[0.035]"
              style={{
                color: isActive ? 'var(--shell-text)' : 'var(--shell-dim)',
                /*-- 选中态与下方内容床同色，让 tab 与画布连成一体；不再是压在浅色条上的黑块。
                     未选中态刻意不写 inline background —— 内联样式会盖过 hover 类，
                     写死 transparent 等于让 hover 失效（Tailwind preflight 已把 button 置为透明）。 --*/
                background: isActive ? 'var(--shell-canvas)' : undefined,
                boxShadow: isActive ? 'inset 0 1px 0 rgba(255,255,255,0.045)' : 'none',
              }}
              title={terminal ? `${providerLabel(terminal.preset, t)} · ${terminal.cwd}` : tab.type === 'browser' ? 'Browser' : tab.terminalId}
            >
              {tab.type === 'janus-chat' && (
                <span className="janus-chat-tab-eyes" role="img" aria-label="JanusX">
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                </span>
              )}
              {terminal?.preset === 'shell' && (
                <SquareTerminal
                  size={14}
                  strokeWidth={1.65}
                  aria-hidden="true"
                  style={{ opacity: isActive ? 0.95 : 0.55 }}
                />
              )}
              {terminal && terminal.preset !== 'shell' && (
                <img
                  src={PRESET_ICONS[terminal.preset]}
                  alt=""
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ opacity: isActive ? 0.95 : 0.55 }}
                />
              )}
              {tab.type === 'browser' ? (
                <BrowserPaneTabLabel surfaceId={tab.surfaceId} isActive={isActive} />
              ) : (
                <span className="min-w-0 flex-1 truncate" style={{ color: isActive ? 'var(--shell-text)' : 'inherit' }}>
                  {tab.type === 'janus-chat'
                    ? <JanusChatTabTitle conversationId={tab.conversationId} />
                    : terminal?.name ?? (tab.type === 'terminal' ? tab.terminalId.slice(0, 8) : '')}
                </span>
              )}
              {tab.type === 'terminal' || tab.type === 'janus-chat' ? (
                <HoldToConfirm
                  as="span"
                  label={tab.type === 'terminal' ? t('terminal:tab.closeTerminal') : t('terminal:tab.closeChat')}
                  className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[13px] leading-none opacity-0 transition-[opacity,color,background] group-hover/tab:opacity-45 hover:!opacity-100 focus:opacity-100 hover:bg-[rgba(255,255,255,0.1)]"
                  style={{ color: tab.type === 'terminal' ? '#b86b6b' : '#999' }}
                  onConfirm={() => {
                    if (tab.type === 'terminal') onKillTerminalFromTab(tab.terminalId)
                    else onClosePaneTab(leaf.id, tab.id)
                  }}
                >
                  <X size={12} strokeWidth={1.8} />
                </HoldToConfirm>
              ) : (
                <span
                  tabIndex={-1}
                  title={t('terminal:tab.closeBrowser')}
                  className="ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-[13px] leading-none opacity-0 transition-[opacity,color,background] group-hover/tab:opacity-45 hover:!opacity-100 hover:bg-[rgba(255,255,255,0.1)]"
                  style={{ color: '#999' }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseBrowserTab(leaf.id, tab.id, tab.surfaceId)
                  }}
                >
                  <X size={12} strokeWidth={1.8} aria-hidden="true" />
                </span>
              )}
              {isActive && (
                <span
                  aria-hidden="true"
                  /*-- 强调条移到顶边：底边要留给 tab 与画布的无缝衔接，画一条线就等于把它们切开。 --*/
                  className="hidden"
                  style={{ background: 'var(--shell-accent)' }}
                />
              )}
            </div>
          )
        })}
        <div className="ml-auto flex h-8 shrink-0 items-center gap-1 pl-1">
          <span
            aria-hidden="true"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-[13px] leading-none font-mono"
            style={{ color: '#999', visibility: 'hidden' }}
          >
            x
          </span>
          <button
            type="button"
            title={t('terminal:tab.newBrowser')}
            aria-label={t('terminal:tab.newBrowser')}
            className="flex h-6 w-6 items-center justify-center rounded border text-[11px] leading-none transition-colors hover:bg-[rgba(255,120,48,0.1)]"
            style={{ borderColor: 'rgba(255,255,255,0.08)', color: '#999' }}
            onClick={(event) => {
              event.stopPropagation()
              onOpenBrowser(leaf.id)
            }}
          >
            <Globe size={11} />
          </button>
          <TerminalPresetCapsule open={terminalMenuOpen} onToggle={openMenu} onSelect={onCreateTerminal} />
          <HoldToConfirm
            label={t('terminal:tab.killCurrentTerminal')}
            disabled={!activeTerminal}
            className="flex h-6 w-6 items-center justify-center rounded border text-[14px] leading-none transition-colors enabled:hover:bg-[rgba(255,88,88,0.1)] disabled:cursor-not-allowed disabled:opacity-35"
            style={{ borderColor: 'rgba(255,255,255,0.08)', color: activeTerminal ? '#b86b6b' : '#666' }}
            onConfirm={() => activeTerminal && onKillTerminal(activeTerminal.id)}
          >
            -
          </HoldToConfirm>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          background: 'var(--shell-canvas)',
        }}
      >
        {leaf.tabs.map((tab) => {
          if (tab.type === 'janus-chat') {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                  zIndex: isActive ? 1 : 0,
                }}
                aria-hidden={!isActive}
              >
                <JanusChatPane
                  focused={workspaceVisible && isFocused && isActive}
                  conversationId={tab.conversationId}
                />
              </div>
            )
          }

          if (tab.type === 'browser') {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  visibility: isActive ? 'visible' : 'hidden',
                  pointerEvents: isActive ? 'auto' : 'none',
                  zIndex: isActive ? 1 : 0,
                }}
                aria-hidden={!isActive}
              >
                <BrowserSurface
                  surfaceId={tab.surfaceId}
                  carrier="pane"
                  visible={workspaceVisible && isActive}
                  onRequestPopOut={() => onBrowserPopOut(leaf.id, tab.id, tab.surfaceId)}
                />
              </div>
            )
          }

          if (tab.type !== 'terminal') return null
          const terminal = terminalsById.get(tab.terminalId)
          if (!terminal) return null
          const isActive = tab.id === activeTabId

          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
                zIndex: isActive ? 1 : 0,
              }}
              aria-hidden={!isActive}
            >
              <CLITerminal
                terminalId={terminal.id}
                visible={workspaceVisible && isActive}
                focused={workspaceVisible && isFocused && isActive}
                workspaceVisible={workspaceVisible}
              />
              {/* 仅 PTY 真死才弹模态遮罩：创建失败（errorMessage）或非零退出（exitCode）。
                  Turn 级失败（429/5xx）主进程已只上报 'wait'，此处再加一道兜底，
                  避免无 message 的裸 'error'（历史残留/误报）锁死输入。 */}
              {(terminal.status === 'error' && (terminal.errorMessage || terminal.exitCode !== undefined)) && (
                <div
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
                  style={{ background: 'rgba(10, 10, 10, 0.72)' }}
                >
                  <div
                    className="pointer-events-auto flex max-w-[320px] flex-col items-center gap-3 rounded-lg border px-5 py-4 text-center font-mono"
                    style={{
                      borderColor: 'rgba(255, 88, 88, 0.28)',
                      background: 'var(--shell-chrome-raised)',
                      boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
                    }}
                  >
                    <div className="text-[12px]" style={{ color: '#ff8585' }}>
                      Terminal failed to start
                    </div>
                    <div className="text-[11px] leading-relaxed text-[#8a8a8a]">
                      {terminal.errorMessage || t('terminal:error.unknown')}
                    </div>
                    <button
                      type="button"
                      className="rounded border px-3 py-1.5 text-[11px] transition-colors hover:bg-[rgba(255,120,48,0.08)]"
                      style={{ borderColor: 'rgba(255,120,48,0.28)', color: '#ffb27d' }}
                      onClick={() => {
                        void retryTerminalCreate(terminal.id)
                      }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {leaf.tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center font-mono text-[12px] text-[#666]">
            <div>Empty pane</div>
            <button
              type="button"
              onClick={openMenu}
              className="rounded border px-3 py-1.5 text-[11px] transition-colors hover:bg-[rgba(255,120,48,0.08)]"
              style={{ borderColor: 'rgba(255,120,48,0.22)', color: '#ffb27d' }}
            >
              New Terminal
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

export function TerminalArea() {
  const { t } = useI18n('terminal')
  useTerminalLifecycle()
  // P5: useShallow 细粒度订阅——整 store 订阅会让任意无关字段变化都重渲染这棵大组件树
  const {
    workspaces,
    terminals,
    activeTerminalId,
    activeWorkspaceId,
    terminalSnapshots,
    paneTree,
    focusedPaneId,
    setActiveTerminal,
    removeTerminal,
    setFocusedPane,
    setPaneTab,
    collapsePaneLayout,
    resizePane,
    moveTerminalToPane,
    splitPaneWithTerminal,
    moveBrowserToPane,
    splitPaneWithBrowser,
    closePaneTab,
    setTabDragInFlight,
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      terminals: s.terminals,
      activeTerminalId: s.activeTerminalId,
      activeWorkspaceId: s.activeWorkspaceId,
      terminalSnapshots: s.terminalSnapshots,
      paneTree: s.paneTree,
      focusedPaneId: s.focusedPaneId,
      setActiveTerminal: s.setActiveTerminal,
      removeTerminal: s.removeTerminal,
      setFocusedPane: s.setFocusedPane,
      setPaneTab: s.setPaneTab,
      collapsePaneLayout: s.collapsePaneLayout,
      resizePane: s.resizePane,
      moveTerminalToPane: s.moveTerminalToPane,
      splitPaneWithTerminal: s.splitPaneWithTerminal,
      moveBrowserToPane: s.moveBrowserToPane,
      splitPaneWithBrowser: s.splitPaneWithBrowser,
      closePaneTab: s.closePaneTab,
      setTabDragInFlight: s.setTabDragInFlight,
    }))
  )
  const [hotWorkspaceIds, setHotWorkspaceIds] = useState<string[]>(() =>
    touchWorkspaceSurfaceRecency([], activeWorkspaceId)
  )
  const hotWorkspaceEvictionTimerRef = useRef<number | null>(null)
  const setLoadState = useAppStore((s) => s.setLoadState)
  const terminalAreaRef = useRef<HTMLDivElement>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerView, setDrawerView] = useState<DrawerView>('runtime')
  const [terminalMenuPaneId, setTerminalMenuPaneId] = useState<string | null>(null)
  const [activeDragTerminalId, setActiveDragTerminalId] = useState<string | null>(null)
  const activeDragTerminalRef = useRef<string | null>(null)
  const [activeDragBrowserSurfaceId, setActiveDragBrowserSurfaceId] = useState<string | null>(null)
  const activeDragBrowserSurfaceRef = useRef<string | null>(null)
  // AC7: launching guard for handlePresetSelect, mirroring TerminalSelector's
  // launchingPreset pattern. Prevents double-click / rapid preset selection
  // from firing two concurrent terminal:create requests for the same preset.
  const [launchingPreset, setLaunchingPreset] = useState(false)
  const terminalsById = useMemo(() => {
    const map = new Map<string, Terminal>()
    for (const snapshot of Object.values(terminalSnapshots)) {
      for (const terminal of snapshot.terminals) {
        map.set(terminal.id, terminal)
      }
    }
    for (const terminal of terminals) {
      map.set(terminal.id, terminal)
    }
    return map
  }, [terminalSnapshots, terminals])

  const workspaceSurfaces = useMemo(() => {
    return buildWorkspaceTerminalSurfaces(terminalSnapshots, activeWorkspaceId, {
      paneTree,
      activeTerminalId,
      focusedPaneId,
    }, hotWorkspaceIds)
  }, [activeTerminalId, activeWorkspaceId, focusedPaneId, hotWorkspaceIds, paneTree, terminalSnapshots])

  useEffect(() => {
    setHotWorkspaceIds((recentWorkspaceIds) =>
      touchWorkspaceSurfaceRecency(
        recentWorkspaceIds,
        activeWorkspaceId,
        MAX_HOT_WORKSPACE_SURFACES + 1,
      )
    )

    if (hotWorkspaceEvictionTimerRef.current !== null) {
      window.clearTimeout(hotWorkspaceEvictionTimerRef.current)
    }
    hotWorkspaceEvictionTimerRef.current = window.setTimeout(() => {
      hotWorkspaceEvictionTimerRef.current = null
      setHotWorkspaceIds((recentWorkspaceIds) =>
        recentWorkspaceIds.slice(0, MAX_HOT_WORKSPACE_SURFACES)
      )
    }, HOT_WORKSPACE_EVICTION_GRACE_MS)

    return () => {
      if (hotWorkspaceEvictionTimerRef.current !== null) {
        window.clearTimeout(hotWorkspaceEvictionTimerRef.current)
        hotWorkspaceEvictionTimerRef.current = null
      }
    }
  }, [activeWorkspaceId])

  const closeTerminalMenu = useCallback(() => {
    setTerminalMenuPaneId(null)
  }, [])

  const toggleTerminalMenu = useCallback((paneId: string) => {
    setTerminalMenuPaneId((current) => (current === paneId ? null : paneId))
  }, [])

  // 点击外部关闭弹出环
  useEffect(() => {
    if (!terminalMenuPaneId) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest('[data-terminal-menu-root="true"]')) {
        closeTerminalMenu()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [closeTerminalMenu, terminalMenuPaneId])

  useEffect(() => {
    if (paneTree) return
    if (terminals.length <= 1) {
      setLoadState('no-terminal')
      return
    }
    setActiveTerminal(activeTerminalId ?? terminals[0].id)
  }, [activeTerminalId, paneTree, setActiveTerminal, setLoadState, terminals])

  const handleKillTerminal = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      try {
        await window.electron.terminal.kill(id)
      } catch {
        // ignore
      }
      removeTerminal(id)
      applyTerminalNoteLifecycle('kill-removed', id)
      if (useWorkspaceStore.getState().terminals.length === 0) {
        setLoadState('no-terminal')
      }
    },
    [removeTerminal, setLoadState]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || (!event.ctrlKey && !event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        setDrawerView('note')
        setDrawerOpen(true)
        return
      }
      /*-- Ctrl/Cmd+Shift+B：主动调用浏览器（已有则激活，否则新建） --*/
      if (key === 'b') {
        event.preventDefault()
        void useWorkspaceStore.getState().openBrowserInWorkspace()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  /*-- pane "+" 菜单新增浏览器 tab --*/
  const handleOpenBrowser = useCallback((paneId: string) => {
    void useWorkspaceStore.getState().addBrowserToPane(paneId)
  }, [])

  /*-- 关闭浏览器 pane tab：先销毁主进程 surface 再移除 pane 内容 --*/
  const handleCloseBrowserTab = useCallback(
    async (paneId: string, tabId: string, surfaceId: string) => {
      await destroyBrowserSurface(surfaceId)
      closePaneTab(paneId, tabId)
    },
    [closePaneTab]
  )

  /*-- 弹出为独立窗口：乐观更新载体后再移除 pane 内容，避免卸载时误隐藏已移交的视图 --*/
  const handleBrowserPopOut = useCallback(
    async (paneId: string, tabId: string, surfaceId: string) => {
      const result = await popOutBrowserSurface(surfaceId)
      if (!result.success) return
      useBrowserStore.getState().markCarrier(surfaceId, 'window')
      closePaneTab(paneId, tabId)
    },
    [closePaneTab]
  )

  const handleTerminalDrop = useCallback(
    (terminalId: string, paneId: string, edge: PaneDropEdge | null, ratio: number) => {
      if (edge) {
        splitPaneWithTerminal(terminalId, paneId, edge, ratio)
        return
      }
      moveTerminalToPane(terminalId, paneId)
    },
    [moveTerminalToPane, splitPaneWithTerminal]
  )

  /*-- browser tab 拖拽落点：边缘分屏，否则移入目标 pane（与 terminal 同语义） --*/
  const handleBrowserTabDrop = useCallback(
    (surfaceId: string, paneId: string, edge: PaneDropEdge | null, ratio: number) => {
      if (edge) {
        splitPaneWithBrowser(surfaceId, paneId, edge, ratio)
        return
      }
      moveBrowserToPane(surfaceId, paneId)
    },
    [moveBrowserToPane, splitPaneWithBrowser]
  )

  useEffect(() => {
    const onDragEnd = () => {
      activeDragTerminalRef.current = null
      setActiveDragTerminalId(null)
      clearTerminalDragData()
      activeDragBrowserSurfaceRef.current = null
      setActiveDragBrowserSurfaceId(null)
      clearBrowserTabDragData()
      setTabDragInFlight(false)
    }
    window.addEventListener('dragend', onDragEnd)
    return () => window.removeEventListener('dragend', onDragEnd)
  }, [setTabDragInFlight])

  const handlePresetSelect = useCallback(
    async (preset: typeof PRESETS[number]) => {
      closeTerminalMenu()
      if (!activeWorkspaceId) return
      // AC7: reject concurrent preset launches (double-click, rapid reselect).
      if (launchingPreset) return

      const workspace = useWorkspaceStore.getState().workspaces.find((w) => w.id === activeWorkspaceId)
      if (!workspace) return

      setLaunchingPreset(true)
      try {
        await launchTerminalPreset({
          preset: preset.type,
          workspaceId: activeWorkspaceId,
          workspacePath: workspace.path,
          name: preset.name.toLowerCase(),
        })
      } finally {
        setLaunchingPreset(false)
      }
    },
    [activeWorkspaceId, closeTerminalMenu, launchingPreset]
  )

  useEffect(() => {
    warmDefaultShellCache()
    warmTerminalCreatePath()
  }, [])

  const paneCount = useMemo(() => getLeafPanes(paneTree).length, [paneTree])
  const activeTerminal = activeTerminalId ? terminalsById.get(activeTerminalId) ?? null : null
  const focusedTerminalWorkspace = activeTerminal
    ? workspaces.find((workspace) => workspace.id === activeTerminal.workspaceId) ?? null
    : null
  const otherTerminals = terminals.filter((terminal) => terminal.id !== activeTerminal?.id)

  return (
      <div
        ref={terminalAreaRef}
        className="flex h-full w-full min-w-0 flex-col relative overflow-hidden"
        style={{
          background: 'var(--shell-canvas)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
      }}
    >
      {paneCount > 1 && (
        <div
          className="flex h-5 shrink-0 items-center justify-end px-3 pt-1"
          style={{ background: 'transparent' }}
        >
          <HoldToConfirm
            label={t('terminal:tab.collapseLayout')}
            onConfirm={collapsePaneLayout}
            className="flex h-4 w-5 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent font-mono text-[14px] leading-none opacity-28 transition-[opacity,background,color] hover:bg-[rgba(255,255,255,0.045)] hover:opacity-75 focus:outline-none focus:ring-1 focus:ring-[rgba(255,120,48,0.28)]"
            style={{ color: 'rgba(255,255,255,0.74)' }}
          >
            -
          </HoldToConfirm>
        </div>
      )}

      {/* Pane tree — multi-pane host stays soft so leaf cards read as floating surfaces */}
      <div
        className="relative m-2 min-h-0 min-w-0 flex-1 overflow-hidden"
        style={
          paneCount > 1
            ? {
                background: 'transparent',
                border: '1px solid transparent',
                boxShadow: 'none',
              }
            : {
                background: 'var(--shell-pane)',
                border: '1px solid var(--shell-border)',
                borderRadius: 10,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)',
              }
        }
      >
        {workspaceSurfaces.map((surface) => {
          const workspaceVisible = surface.workspaceId === activeWorkspaceId
          return (
            <div
              key={surface.workspaceId}
              className="absolute inset-0"
              style={{
                display: workspaceVisible ? 'block' : 'none',
              }}
              {...(!workspaceVisible ? { inert: '' } : {})}
              aria-hidden={!workspaceVisible}
            >
              <PaneTreeView
                node={surface.paneTree}
                workspaceVisible={workspaceVisible}
                terminalsById={terminalsById}
                focusedPaneId={surface.focusedPaneId}
                activeTerminalId={surface.activeTerminalId}
                showFocusChrome={workspaceVisible && paneCount > 1}
                onPaneFocus={setFocusedPane}
                onTabSelect={setPaneTab}
                onKillTerminalFromTab={handleKillTerminal}
                onClosePaneTab={closePaneTab}
                onOpenBrowser={handleOpenBrowser}
                onCloseBrowserTab={handleCloseBrowserTab}
                onBrowserPopOut={handleBrowserPopOut}
                onKillTerminal={handleKillTerminal}
                onTerminalDrop={handleTerminalDrop}
                onTerminalDragStart={(terminalId) => {
                  activeDragTerminalRef.current = terminalId
                  setActiveDragTerminalId(terminalId)
                  setTabDragInFlight(true)
                }}
                onTerminalDragEnd={() => {
                  activeDragTerminalRef.current = null
                  setActiveDragTerminalId(null)
                  clearTerminalDragData()
                  activeDragBrowserSurfaceRef.current = null
                  setActiveDragBrowserSurfaceId(null)
                  clearBrowserTabDragData()
                  setTabDragInFlight(false)
                }}
                onBrowserTabDragStart={(surfaceId) => {
                  activeDragBrowserSurfaceRef.current = surfaceId
                  setActiveDragBrowserSurfaceId(surfaceId)
                  setTabDragInFlight(true)
                }}
                onBrowserTabDrop={handleBrowserTabDrop}
                activeDragBrowserSurfaceId={activeDragBrowserSurfaceId}
                activeDragBrowserSurfaceRef={activeDragBrowserSurfaceRef}
                activeDragTerminalId={activeDragTerminalId}
                activeDragTerminalRef={activeDragTerminalRef}
                onResize={resizePane}
                terminalMenuPaneId={terminalMenuPaneId}
                onToggleTerminalMenu={toggleTerminalMenu}
                onCreateTerminal={handlePresetSelect}
              />
            </div>
          )
        })}
      </div>

      <div
        className="relative flex-shrink-0 overflow-hidden transition-[height,background,border-color]"
        style={{
          background: drawerOpen ? 'var(--shell-chrome)' : 'var(--shell-canvas)',
          borderTop: '1px solid var(--shell-border)',
          height: getDrawerHeight(drawerOpen, drawerView),
        }}
      >
        <div
          className={`flex h-7 w-full cursor-pointer select-none items-center justify-between gap-3 pl-3 text-left transition-colors hover:bg-[rgba(255,255,255,0.018)] ${drawerOpen ? 'pr-32' : 'pr-3'}`}
          onClick={() => setDrawerOpen((value) => !value)}
        >
          <div className="flex h-full min-w-0 items-center gap-1.5 text-[11px]">
            <button
              type="button"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded focus:outline-none focus:ring-1 focus:ring-[rgba(88,166,255,0.35)]"
              onClick={(event) => {
                event.stopPropagation()
                setDrawerOpen((value) => !value)
              }}
              aria-expanded={drawerOpen}
              aria-label={t('terminal:tab.runtimePanelToggle')}
            >
              <span
                className="h-[7px] w-[7px] transition-transform"
                style={{
                  borderRight: '1.5px solid rgba(255, 255, 255, 0.2)',
                  borderBottom: '1.5px solid rgba(255, 255, 255, 0.2)',
                  transform: drawerOpen ? 'rotate(45deg) translate(-1px, -1px)' : 'rotate(-45deg)',
                }}
              />
            </button>
            {activeTerminal ? (
              <span className="flex min-w-0 items-center gap-1.5">
                {focusedTerminalWorkspace && (
                  <span
                    className="hidden min-w-0 max-w-[150px] items-center gap-1.5 border-r pr-2 font-mono text-[10px] sm:inline-flex"
                    style={{
                      borderColor: 'rgba(255,255,255,0.055)',
                      color: 'var(--shell-dim)',
                    }}
                    title={t('terminal:tab.focusWorkspaceTitle', { name: focusedTerminalWorkspace.name, path: focusedTerminalWorkspace.path })}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1 w-1 shrink-0 rounded-full"
                      style={{ background: 'rgba(255,255,255,0.24)' }}
                    />
                    <span className="truncate">{focusedTerminalWorkspace.name}</span>
                  </span>
                )}
                <span
                  className="inline-flex h-5 min-w-0 max-w-[180px] items-center rounded border px-2 font-mono"
                  style={{
                    borderColor: 'rgba(255,255,255,0.055)',
                    background: 'rgba(255,255,255,0.014)',
                    color: '#8a8a8a',
                  }}
                >
                  <span className="truncate">{modelLabel(activeTerminal, t)}</span>
                </span>
                <ContextUsagePopover
                  terminal={activeTerminal}
                  interactive={false}
                  clickable
                  className="group relative inline-flex h-5 shrink-0 items-center rounded border px-2 font-mono"
                  style={{
                    borderColor: `${contextRatioColor(contextRatio(activeTerminal))}33`,
                    background: `${contextRatioColor(contextRatio(activeTerminal))}12`,
                    color: contextRatioColor(contextRatio(activeTerminal)),
                  }}
                >
                  {contextLabel(activeTerminal, t)}
                </ContextUsagePopover>
              </span>
            ) : (
              <span className="truncate font-mono text-[#666]">No model or context data</span>
            )}
          </div>
          <div className="flex h-full shrink-0 items-center gap-2 text-[10px]">
            <div className="hidden h-full items-center gap-1.5 md:flex">
              {otherTerminals.slice(0, 3).map((terminal) => (
                <span
                  key={terminal.id}
                  className="inline-flex h-5 max-w-[126px] items-center gap-1.5 overflow-hidden rounded border px-1.5 font-mono"
                  style={{
                    borderColor: 'rgba(255,255,255,0.055)',
                    background: 'rgba(255,255,255,0.018)',
                    color: '#777',
                  }}
                  title={`${providerLabel(terminal.preset, t)} · ${modelLabel(terminal, t)} · ${contextLabel(terminal, t)}`}
                >
                  <span
                    className="h-[5px] w-[5px] shrink-0 rounded-full"
                    style={{ background: accentColor(terminal.status) }}
                  />
                  <span className="truncate">{providerLabel(terminal.preset, t)}</span>
                </span>
              ))}
              {otherTerminals.length > 3 && (
                <span className="inline-flex h-5 items-center rounded border border-[rgba(255,255,255,0.055)] px-1.5 font-mono text-[#555]">
                  +{otherTerminals.length - 3}
                </span>
              )}
            </div>
          </div>
        </div>
        <DrawerViewTabs
          open={drawerOpen}
          activeView={drawerView}
          onSelect={setDrawerView}
        />
        {DRAWER_VIEWS.map((view) => (
          <div
            key={view}
            {...getDrawerPanelAttributes(view)}
            hidden={!drawerOpen || drawerView !== view}
            className="overflow-hidden px-3 pb-3 pt-2 text-[11px] font-mono"
            style={{ height: 'calc(100% - 28px)' }}
          >
            {drawerOpen && drawerView === view && (
              view === 'note' ? activeTerminalId ? (
              <QuickNote
                terminalId={activeTerminalId}
                onPasteToTerminal={(data) => window.electron.terminal.input(activeTerminalId, data)}
              />
            ) : (
              <div className="grid h-full place-items-center text-[#666]">{t('terminal:tab.noActiveTerminal')}</div>
            ) : (
              <section
                className="min-h-0 overflow-hidden border"
                style={{
                  borderColor: 'rgba(255,255,255,0.07)',
                  background: 'rgba(255,255,255,0.012)',
                }}
                aria-label={t('terminal:tab.runtimeAria')}
              >
              <div className="flex h-8 items-center justify-between border-b px-2.5" style={{ borderColor: 'rgba(255,255,255,0.055)' }}>
                <span className="text-[#8a8a8a]">{t('terminal:tab.terminalRuntime')}</span>
                <span className="text-[#666]">{terminals.length} {t('terminal:sessions.countSuffix')}</span>
              </div>
              <div className="max-h-[141px] overflow-auto">
                {terminals.length === 0 ? (
                  <div className="px-2.5 py-4 text-[#555]">{t('terminal:tab.noTelemetryData')}</div>
                ) : (
                  terminals.map((terminal) => (
                    <button
                      key={terminal.id}
                      type="button"
                      className="grid w-full cursor-pointer grid-cols-[92px_minmax(96px,140px)_minmax(140px,1fr)_86px] items-center gap-2 border-b px-2.5 py-2 text-left transition-colors hover:bg-[rgba(255,255,255,0.03)] focus:outline-none focus:ring-1 focus:ring-[rgba(88,166,255,0.35)]"
                      style={{
                        borderColor: 'rgba(255,255,255,0.035)',
                        background: terminal.id === activeTerminalId ? 'rgba(255,255,255,0.05)' : 'transparent',
                      }}
                      onClick={() => setActiveTerminal(terminal.id)}
                      title={`${providerLabel(terminal.preset, t)} · ${terminal.cwd}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5 text-[#d4d4d4]">
                        <span
                          className="h-[6px] w-[6px] shrink-0 rounded-full"
                          style={{
                            background: accentColor(terminal.status),
                            boxShadow: `0 0 8px ${accentColor(terminal.status)}66`,
                          }}
                        />
                        <span className="truncate">{providerLabel(terminal.preset, t)}</span>
                      </span>
                      <span
                        className="inline-flex h-5 min-w-0 items-center border px-2"
                        style={{
                          borderColor: 'rgba(255,255,255,0.055)',
                          background: 'rgba(255,255,255,0.014)',
                          color: '#8a8a8a',
                        }}
                      >
                        <span className="truncate">{modelLabel(terminal, t)}</span>
                      </span>
                      <ContextUsagePopover
                        terminal={terminal}
                        interactive={false}
                        className="group relative grid min-w-0 grid-cols-[1fr_auto] items-center gap-2"
                      >
                        <span
                          className="h-1 overflow-hidden rounded-full"
                          style={{ background: 'rgba(255,255,255,0.06)' }}
                        >
                          <span
                            className="block h-full rounded-full transition-[width,background] duration-300"
                            style={{
                              width: `${Math.round((contextRatio(terminal) ?? 0) * 100)}%`,
                              background: contextRatioColor(contextRatio(terminal)),
                            }}
                          />
                        </span>
                        <span className="whitespace-nowrap" style={{ color: contextRatioColor(contextRatio(terminal)) }}>{contextLabel(terminal, t)}</span>
                      </ContextUsagePopover>
                      <span className="text-right text-[#555]" title={t('terminal:tab.tokenSummaryTitle', { input: formatTokenCount(terminal.inputTokens), output: formatTokenCount(terminal.outputTokens) })}>
                        {formatAge(terminal.telemetryUpdatedAt)}
                      </span>
                    </button>
                  ))
                )}
              </div>
              </section>
              )
            )}
          </div>
        ))}
      </div>

    </div>
  )
}
