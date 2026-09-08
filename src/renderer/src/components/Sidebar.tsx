import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import { Activity, ChevronRight, CirclePause, PanelLeftClose, PanelLeftOpen, Plus, TriangleAlert } from 'lucide-react'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAppStore } from '@/stores/app'
import { useI18n } from '@/i18n/useI18n'
import { ProjectLauncher } from './ProjectLauncher'
import { ModalCloseButton } from './ModalCloseButton'
import type { Workspace, WorkspaceSidebarGroup, Terminal } from '@/types'
import { clearTerminalDragData, setTerminalDragData } from '@/lib/terminal-file-reference'
import { chooseAndCreateWorkspace, getActiveWorkspacePath, loadWorkspaceFileTree } from '@/features/workspace/actions'
import { invalidateEditorFileCache } from '@/stores/editor'
import { getTerminalStatusVisual, summarizeTerminalActivity } from '@/lib/terminal-sidebar-visual'
import terminalIcon from '@/assets/icons/terminal.svg'
import claudeIcon from '@/assets/icons/claude.svg'
import codexIcon from '@/assets/icons/codex.svg'
import opencodeIcon from '@/assets/icons/opencode.svg'
import janusIcon from '@/assets/icons/janus.svg'
import {
  clearWorkspaceSidebarGroup,
  groupWorkspaceInSidebar,
  moveWorkspaceInSidebar,
  moveWorkspaceToSidebarBoundary,
  nextWorkspaceSidebarGroupName,
  normalizeWorkspaceSidebarLayout,
  removeWorkspaceFromSidebarGroup,
  renameWorkspaceSidebarGroup,
  sortWorkspaceSidebar,
  workspaceSidebarLayoutsEqual,
  type WorkspaceSidebarBoundary,
  type WorkspaceSidebarDropPosition,
} from '../../../shared/workspace-sidebar'
import {
  JANUS_PROJECT_CANDIDATE_EVENT,
  type JanusProjectCandidate,
} from './janus/janusProjectCandidate'

const WORKSPACE_DRAG_TYPE = 'application/x-janus-workspace'
const GROUP_HOVER_DELAY = 300
const MENU_MARGIN = 8

type WorkspaceDropIntent =
  | { mode: WorkspaceSidebarDropPosition | 'group-pending' | 'group'; targetId: string }
  | { mode: WorkspaceSidebarBoundary; targetId: null }

type WorkspaceContextMenuState = {
  x: number
  y: number
  target:
    | { kind: 'workspace'; workspace: Workspace }
    | { kind: 'group'; group: WorkspaceSidebarGroup }
}

interface WorkspaceContextMenuProps {
  menu: WorkspaceContextMenuState
  onRunConfiguration: (workspace: Workspace) => void
  onRenameGroup: (group: WorkspaceSidebarGroup) => void
  onRemoveFromGroup: (workspaceId: string) => void
  onClearGroup: (groupId: string) => void
  onDelete: (workspace: Workspace) => void
}

function WorkspaceContextMenu({
  menu,
  onRunConfiguration,
  onRenameGroup,
  onRemoveFromGroup,
  onClearGroup,
  onDelete,
}: WorkspaceContextMenuProps) {
  const { t } = useI18n('common')
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: menu.x, y: menu.y })

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPosition({
      x: Math.max(MENU_MARGIN, Math.min(menu.x, window.innerWidth - rect.width - MENU_MARGIN)),
      y: Math.max(MENU_MARGIN, Math.min(menu.y, window.innerHeight - rect.height - MENU_MARGIN)),
    })
  }, [menu.x, menu.y])

  const itemClassName = 'block w-full border-0 bg-transparent px-3 py-1.5 text-left text-[12px] text-[#c4c4c4] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-white'
  const target = menu.target

  return createPortal(
    <div
      ref={menuRef}
      className="fixed overflow-hidden rounded-md py-1"
      style={{
        left: position.x,
        top: position.y,
        width: 188,
        zIndex: 1200,
        background: 'rgba(25,25,25,0.98)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '0 14px 36px rgba(0,0,0,0.55)',
        backdropFilter: 'blur(16px)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {target.kind === 'workspace' ? (
        <>
          <button type="button" className={itemClassName} onClick={() => onRunConfiguration(target.workspace)}>
            {t('common:workspace.runConfiguration')}
          </button>
          {target.workspace.sidebarGroup && (
            <>
              <div className="my-1 h-px bg-[rgba(255,255,255,0.07)]" />
              <button type="button" className={itemClassName} onClick={() => onRenameGroup(target.workspace.sidebarGroup!)}>
                {t('common:workspace.renameGroup')}
              </button>
              <button type="button" className={itemClassName} onClick={() => onRemoveFromGroup(target.workspace.id)}>
                {t('common:workspace.removeFromGroup')}
              </button>
            </>
          )}
          <div className="my-1 h-px bg-[rgba(255,255,255,0.07)]" />
          <button
            type="button"
            className={`${itemClassName} !text-[#ff7777] hover:!bg-[rgba(255,88,88,0.1)]`}
            onClick={() => onDelete(target.workspace)}
          >
            {t('common:workspace.deleteWorkspace')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className={itemClassName} onClick={() => onRenameGroup(target.group)}>
            {t('common:workspace.renameGroup')}
          </button>
          <button type="button" className={itemClassName} onClick={() => onClearGroup(target.group.id)}>
            {t('common:workspace.ungroup')}
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

function createWorkspaceSidebarGroupId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `workspace-group-${crypto.randomUUID()}`
  }
  return `workspace-group-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function terminalPresetLabel(preset: Terminal['preset'], t: (key: string) => string): string {
  switch (preset) {
    case 'claude':
      return t('terminal:provider.claude')
    case 'codex':
      return t('terminal:provider.codex')
    case 'opencode':
      return t('terminal:provider.opencode')
    case 'janus':
      return t('terminal:provider.janus')
    default:
      return t('terminal:provider.shell')
  }
}

const TERMINAL_PRESET_ICONS: Record<Terminal['preset'], string> = {
  shell: terminalIcon,
  claude: claudeIcon,
  codex: codexIcon,
  opencode: opencodeIcon,
  janus: janusIcon,
}

function TerminalStatusIndicator({ status }: { status: Terminal['status'] }) {
  const { t } = useI18n('terminal')
  const visual = getTerminalStatusVisual(status)
  const Icon = status === 'running' ? Activity : status === 'error' ? TriangleAlert : CirclePause
  const label = t(visual.labelKey)

  return (
    <span
      className="relative inline-flex h-5 shrink-0 items-center gap-1 overflow-hidden rounded-[3px] px-1.5 font-mono text-[9px] font-medium"
      style={{ color: visual.color, background: visual.background }}
      title={t('common:workspace.terminalStatusTitle', { label })}
    >
      {status === 'running' && <span className="term-status-orbit" aria-hidden="true" />}
      <span className="relative flex h-2.5 w-2.5 items-center justify-center">
        <Icon size={10} strokeWidth={2} className="relative" aria-hidden="true" />
      </span>
      {label}
    </span>
  )
}

function workspaceInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

export function Sidebar() {
  const { t } = useI18n()
  // P5: useShallow 细粒度订阅，避免整 store 任意变化带动整个侧栏重渲染
  const { workspaces, activeWorkspaceId, terminals, activeTerminalId, terminalSnapshots, setWorkspaces, setActiveWorkspace, addWorkspace, removeWorkspace } =
    useWorkspaceStore(
      useShallow((s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        terminals: s.terminals,
        activeTerminalId: s.activeTerminalId,
        terminalSnapshots: s.terminalSnapshots,
        setWorkspaces: s.setWorkspaces,
        setActiveWorkspace: s.setActiveWorkspace,
        addWorkspace: s.addWorkspace,
        removeWorkspace: s.removeWorkspace,
      }))
    )
  const orderedWorkspaces = useMemo(() => sortWorkspaceSidebar(workspaces), [workspaces])
  const setLoadState = useAppStore((s) => s.setLoadState)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)

  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null)
  const [configTarget, setConfigTarget] = useState<Workspace | null>(null)
  const [projectCandidate, setProjectCandidate] = useState<JanusProjectCandidate | null>(null)
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>([])
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([])
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenuState | null>(null)
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null)
  const [dropIntent, setDropIntent] = useState<WorkspaceDropIntent | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const suppressClickRef = useRef<string | null>(null)
  const draggedWorkspaceIdRef = useRef<string | null>(null)
  const dropIntentRef = useRef<WorkspaceDropIntent | null>(null)
  const groupHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const groupHoverTargetRef = useRef<string | null>(null)
  const layoutSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const skipRenameBlurRef = useRef(false)

  const groupMembersById = useMemo(() => {
    const groups = new Map<string, Workspace[]>()
    for (const workspace of orderedWorkspaces) {
      const id = workspace.sidebarGroup?.id
      if (!id) continue
      const members = groups.get(id) ?? []
      members.push(workspace)
      groups.set(id, members)
    }
    return groups
  }, [orderedWorkspaces])

  useEffect(() => {
    const openCandidate = (event: Event) => {
      const detail = (event as CustomEvent<JanusProjectCandidate>).detail
      const workspace = workspaces.find((item) => item.id === detail?.workspaceId)
      if (!workspace || !detail) return
      setProjectCandidate(detail)
      setConfigTarget(workspace)
    }
    window.addEventListener(JANUS_PROJECT_CANDIDATE_EVENT, openCandidate)
    return () => window.removeEventListener(JANUS_PROJECT_CANDIDATE_EVENT, openCandidate)
  }, [workspaces])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useEffect(() => () => {
    if (groupHoverTimerRef.current) clearTimeout(groupHoverTimerRef.current)
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    try {
      const workspace = await chooseAndCreateWorkspace()
      if (!workspace) return
      addWorkspace(workspace)
      setActiveWorkspace(workspace.id)
      setLoadState('no-terminal')
    } catch (err) {
      console.error('Failed to create workspace:', err)
    }
  }, [addWorkspace, setActiveWorkspace, setLoadState])

  const persistWorkspaceLayout = useCallback((nextWorkspaces: Workspace[]) => {
    setWorkspaces(nextWorkspaces)
    layoutSaveQueueRef.current = layoutSaveQueueRef.current
      .then(async () => {
        await Promise.all(nextWorkspaces.map((workspace) => window.electron.workspace.update(workspace.id, {
          sidebarOrder: workspace.sidebarOrder,
          sidebarGroup: workspace.sidebarGroup,
        })))
      })
      .catch((error) => {
        console.error('Failed to persist workspace sidebar layout:', error)
      })
  }, [setWorkspaces])

  const updateWorkspaceLayout = useCallback((
    update: (current: Workspace[]) => Workspace[],
  ): boolean => {
    const current = sortWorkspaceSidebar(useWorkspaceStore.getState().workspaces)
    const next = normalizeWorkspaceSidebarLayout(update(current))
    if (workspaceSidebarLayoutsEqual(current, next)) return false
    persistWorkspaceLayout(next)
    return true
  }, [persistWorkspaceLayout])

  const handleDeleteClick = useCallback(
    (ws: Workspace, e: React.MouseEvent) => {
      e.stopPropagation()
      setDeleteTarget(ws)
    },
    [],
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await window.electron.workspace.delete(deleteTarget.id)
      removeWorkspace(deleteTarget.id)
      updateWorkspaceLayout((current) => current)
      setExpandedWorkspaceIds((current) => current.filter((id) => id !== deleteTarget.id))
      if (workspaces.length <= 1) {
        setLoadState('no-workspace')
        useWorkspaceStore.setState({
          fileTree: [],
          terminals: [],
          activeTerminalId: null,
          paneTree: null,
          focusedPaneId: null,
          focusedTabId: null,
        })
      }
    } catch (err) {
      console.error('Failed to delete workspace:', err)
    }
    setDeleteTarget(null)
  }, [deleteTarget, removeWorkspace, workspaces.length, setLoadState, updateWorkspaceLayout])

  const handleSelect = useCallback(
    async (id: string) => {
      if (suppressClickRef.current === id) {
        suppressClickRef.current = null
        return
      }
      setActiveWorkspace(id)
      // 根据目标工作区是否有终端来设置状态
      const stateAfterSwitch = useWorkspaceStore.getState()
      setLoadState(stateAfterSwitch.terminals.length > 0 ? 'terminal-active' : 'no-terminal')
      // 加载文件树(统一入口,带工作区未再切换的竞态守卫)
      const ws = workspaces.find((w) => w.id === id)
      if (!ws) return
      invalidateEditorFileCache(ws.path)
      await loadWorkspaceFileTree(ws.path, () => getActiveWorkspacePath() === ws.path, { visualTransition: true }).catch((err) => {
        console.error('Failed to load file tree:', err)
      })
    },
    [setActiveWorkspace, setLoadState, workspaces]
  )

  const handleToggleWorkspaceExpand = useCallback((id: string, event: React.MouseEvent) => {
    event.stopPropagation()
    setExpandedWorkspaceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }, [])

  const handleTerminalPreviewDragStart = useCallback(
    (terminal: Terminal, event: React.DragEvent<HTMLDivElement>) => {
      event.stopPropagation()
      setTerminalDragData(event.dataTransfer, terminal.id)
      event.dataTransfer.setDragImage(event.currentTarget, 12, 12)
    },
    []
  )

  const setDropIntentValue = useCallback((intent: WorkspaceDropIntent | null) => {
    dropIntentRef.current = intent
    setDropIntent(intent)
  }, [])

  const clearGroupHover = useCallback(() => {
    if (groupHoverTimerRef.current) {
      clearTimeout(groupHoverTimerRef.current)
      groupHoverTimerRef.current = null
    }
    groupHoverTargetRef.current = null
  }, [])

  const resetWorkspaceDrag = useCallback(() => {
    clearGroupHover()
    draggedWorkspaceIdRef.current = null
    setDraggedWorkspaceId(null)
    setDropIntentValue(null)
  }, [clearGroupHover, setDropIntentValue])

  const handleWorkspaceDragStart = useCallback((workspace: Workspace, event: React.DragEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input')) {
      event.preventDefault()
      return
    }
    clearGroupHover()
    setContextMenu(null)
    draggedWorkspaceIdRef.current = workspace.id
    setDraggedWorkspaceId(workspace.id)
    suppressClickRef.current = workspace.id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(WORKSPACE_DRAG_TYPE, workspace.id)
    event.dataTransfer.setData('text/plain', workspace.id)
    event.dataTransfer.setDragImage(event.currentTarget, 18, 14)
  }, [clearGroupHover])

  const handleWorkspaceDragOver = useCallback((target: Workspace, event: React.DragEvent<HTMLDivElement>) => {
    const sourceId = draggedWorkspaceIdRef.current || event.dataTransfer.getData(WORKSPACE_DRAG_TYPE)
    if (!sourceId) return
    if (sourceId === target.id) {
      clearGroupHover()
      setDropIntentValue(null)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'

    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1)
    if (ratio < 0.25 || ratio > 0.75) {
      clearGroupHover()
      setDropIntentValue({ mode: ratio < 0.25 ? 'before' : 'after', targetId: target.id })
      return
    }

    const currentIntent = dropIntentRef.current
    if (currentIntent?.targetId === target.id && (currentIntent.mode === 'group-pending' || currentIntent.mode === 'group')) return
    clearGroupHover()
    groupHoverTargetRef.current = target.id
    setDropIntentValue({ mode: 'group-pending', targetId: target.id })
    groupHoverTimerRef.current = setTimeout(() => {
      groupHoverTimerRef.current = null
      if (!draggedWorkspaceIdRef.current || groupHoverTargetRef.current !== target.id) return
      setDropIntentValue({ mode: 'group', targetId: target.id })
    }, GROUP_HOVER_DELAY)
  }, [clearGroupHover, setDropIntentValue])

  const handleGroupDragOver = useCallback((targetId: string, event: React.DragEvent<HTMLDivElement>) => {
    const sourceId = draggedWorkspaceIdRef.current || event.dataTransfer.getData(WORKSPACE_DRAG_TYPE)
    if (!sourceId) return
    if (sourceId === targetId) {
      clearGroupHover()
      setDropIntentValue(null)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    clearGroupHover()
    setDropIntentValue({ mode: 'group', targetId })
  }, [clearGroupHover, setDropIntentValue])

  const handleBoundaryDragOver = useCallback((boundary: WorkspaceSidebarBoundary, event: React.DragEvent<HTMLDivElement>) => {
    if (!draggedWorkspaceIdRef.current) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    clearGroupHover()
    setDropIntentValue({ mode: boundary, targetId: null })
  }, [clearGroupHover, setDropIntentValue])

  const handleWorkspaceDrop = useCallback((target: Workspace, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = draggedWorkspaceIdRef.current || event.dataTransfer.getData(WORKSPACE_DRAG_TYPE)
    const intent = dropIntentRef.current
    if (!sourceId || sourceId === target.id || !intent || intent.targetId !== target.id) {
      resetWorkspaceDrag()
      return
    }

    if (intent.mode === 'group') {
      const currentTarget = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === target.id)
      if (currentTarget) {
        const group = currentTarget.sidebarGroup ?? {
          id: createWorkspaceSidebarGroupId(),
          name: nextWorkspaceSidebarGroupName(useWorkspaceStore.getState().workspaces),
        }
        updateWorkspaceLayout((current) => groupWorkspaceInSidebar(current, sourceId, target.id, group))
        if (!currentTarget.sidebarGroup) {
          setCollapsedGroupIds((current) => current.filter((id) => id !== group.id))
          setGroupNameDraft(group.name)
          setRenamingGroupId(group.id)
        }
      }
      resetWorkspaceDrag()
      return
    }

    const targetRect = event.currentTarget.getBoundingClientRect()
    const position: WorkspaceSidebarDropPosition = intent.mode === 'group-pending'
      ? event.clientY < targetRect.top + targetRect.height / 2
        ? 'before'
        : 'after'
      : intent.mode
    updateWorkspaceLayout((current) => moveWorkspaceInSidebar(current, sourceId, target.id, position))
    resetWorkspaceDrag()
  }, [resetWorkspaceDrag, updateWorkspaceLayout])

  const handleBoundaryDrop = useCallback((boundary: WorkspaceSidebarBoundary, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = draggedWorkspaceIdRef.current || event.dataTransfer.getData(WORKSPACE_DRAG_TYPE)
    if (sourceId) updateWorkspaceLayout((current) => moveWorkspaceToSidebarBoundary(current, sourceId, boundary))
    resetWorkspaceDrag()
  }, [resetWorkspaceDrag, updateWorkspaceLayout])

  const handleWorkspaceDragEnd = useCallback((sourceId: string) => {
    resetWorkspaceDrag()
    window.setTimeout(() => {
      if (suppressClickRef.current === sourceId) suppressClickRef.current = null
    }, 0)
  }, [resetWorkspaceDrag])

  const handleWorkspaceListDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!draggedWorkspaceIdRef.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const edge = 28
    if (event.clientY < rect.top + edge) event.currentTarget.scrollTop -= 12
    else if (event.clientY > rect.bottom - edge) event.currentTarget.scrollTop += 12
  }, [])

  const openWorkspaceContextMenu = useCallback((workspace: Workspace, x: number, y: number) => {
    resetWorkspaceDrag()
    setContextMenu({ x, y, target: { kind: 'workspace', workspace } })
  }, [resetWorkspaceDrag])

  const handleWorkspaceContextMenu = useCallback((workspace: Workspace, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    openWorkspaceContextMenu(workspace, event.clientX, event.clientY)
  }, [openWorkspaceContextMenu])

  const handleWorkspaceKeyDown = useCallback((workspace: Workspace, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openWorkspaceContextMenu(workspace, rect.left + 18, rect.top + 18)
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void handleSelect(workspace.id)
  }, [handleSelect, openWorkspaceContextMenu])

  const startRenamingGroup = useCallback((group: WorkspaceSidebarGroup) => {
    setContextMenu(null)
    setCollapsedGroupIds((current) => current.filter((id) => id !== group.id))
    setGroupNameDraft(group.name)
    setRenamingGroupId(group.id)
  }, [])

  const commitGroupRename = useCallback((groupId: string) => {
    if (skipRenameBlurRef.current) {
      skipRenameBlurRef.current = false
      return
    }
    const name = groupNameDraft.trim()
    setRenamingGroupId(null)
    setGroupNameDraft('')
    if (name) updateWorkspaceLayout((current) => renameWorkspaceSidebarGroup(current, groupId, name))
  }, [groupNameDraft, updateWorkspaceLayout])

  const handleGroupNameKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    skipRenameBlurRef.current = true
    setRenamingGroupId(null)
    setGroupNameDraft('')
    event.currentTarget.blur()
  }, [])

  const handleGroupContextMenu = useCallback((group: WorkspaceSidebarGroup, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    resetWorkspaceDrag()
    setContextMenu({ x: event.clientX, y: event.clientY, target: { kind: 'group', group } })
  }, [resetWorkspaceDrag])

  const handleRunConfiguration = useCallback((workspace: Workspace) => {
    setContextMenu(null)
    setProjectCandidate(null)
    setConfigTarget(workspace)
  }, [])

  const handleRemoveFromGroup = useCallback((workspaceId: string) => {
    setContextMenu(null)
    updateWorkspaceLayout((current) => removeWorkspaceFromSidebarGroup(current, workspaceId))
  }, [updateWorkspaceLayout])

  const handleClearGroup = useCallback((groupId: string) => {
    setContextMenu(null)
    setCollapsedGroupIds((current) => current.filter((id) => id !== groupId))
    updateWorkspaceLayout((current) => clearWorkspaceSidebarGroup(current, groupId))
  }, [updateWorkspaceLayout])

  const handleContextDelete = useCallback((workspace: Workspace) => {
    setContextMenu(null)
    setDeleteTarget(workspace)
  }, [])

  const dropTargetGroupId = dropIntent?.targetId
    ? orderedWorkspaces.find((workspace) => workspace.id === dropIntent.targetId)?.sidebarGroup?.id ?? null
    : null

  return (
    <aside
      className="workspace-sidebar flex flex-col overflow-hidden"
      style={{
        background: 'var(--shell-chrome)',
        borderRight: '1px solid var(--shell-border)',
      }}
      data-collapsed={sidebarCollapsed}
      aria-label={t('common:workspace.ariaLabel')}
    >
      {/* 展开态 */}
      <div id="workspace-sidebar-content" className="workspace-sidebar__expanded" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
          <div
            className="flex h-9 items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: 'var(--shell-muted)', borderBottom: '1px solid var(--shell-border)' }}
          >
            <span>{t('common:workspace.label')}</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={handleAddWorkspace}
                className="flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{
                  color: 'var(--shell-accent-strong)',
                }}
                title={t('common:workspace.add')}
                aria-label={t('common:workspace.add')}
              >
                <Plus size={15} strokeWidth={1.7} aria-hidden="true" />
              </button>
              <button
                onClick={toggleSidebar}
                title={t('common:workspace.collapse')}
                aria-expanded={!sidebarCollapsed}
                aria-controls="workspace-sidebar-content"
                className="flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{ color: 'var(--shell-dim)' }}
                aria-label={t('common:workspace.collapseAria')}
              >
                <PanelLeftClose size={15} strokeWidth={1.6} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-1.5 py-1" onDragOverCapture={handleWorkspaceListDragOver}>
            {orderedWorkspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 opacity-30">
                <div className="text-xs text-[#666]">{t('common:workspace.empty')}</div>
              </div>
            ) : (
              <>
                <div
                  className="relative h-1.5"
                  onDragOver={(event) => handleBoundaryDragOver('start', event)}
                  onDrop={(event) => handleBoundaryDrop('start', event)}
                >
                  {dropIntent?.mode === 'start' && (
                    <div className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-[#ff7830] shadow-[0_0_7px_rgba(255,120,48,0.7)]" />
                  )}
                </div>
                {orderedWorkspaces.map((ws, workspaceIndex) => {
                  const isActive = ws.id === activeWorkspaceId
                  const group = ws.sidebarGroup
                  const isGroupStart = !!group && orderedWorkspaces[workspaceIndex - 1]?.sidebarGroup?.id !== group.id
                  const isGroupCollapsed = !!group && collapsedGroupIds.includes(group.id)
                  if (group && isGroupCollapsed && !isGroupStart) return null
                  const groupMembers = group ? groupMembersById.get(group.id) ?? [ws] : []
                  const workspaceTerminals = (isActive ? terminals : terminalSnapshots[ws.id]?.terminals ?? []).filter(
                    (terminal) => terminal.workspaceId === ws.id
                  )
                const isExpanded = expandedWorkspaceIds.includes(ws.id)
                const terminalCount = workspaceTerminals.length
                  const terminalActivity = summarizeTerminalActivity(workspaceTerminals)
                  const isDragged = draggedWorkspaceId === ws.id
                  const isDropBefore = dropIntent?.targetId === ws.id && dropIntent.mode === 'before'
                  const isDropAfter = dropIntent?.targetId === ws.id && dropIntent.mode === 'after'
                  const isGroupPending = dropIntent?.targetId === ws.id && dropIntent.mode === 'group-pending'
                  const isGroupTarget = dropIntent?.targetId === ws.id && dropIntent.mode === 'group'
                  const isHeaderGroupTarget = !!group && dropIntent?.mode === 'group' && dropTargetGroupId === group.id
                  const hasActiveGroupMember = groupMembers.some((member) => member.id === activeWorkspaceId)

                  return (
                    <div key={ws.id}>
                      {isGroupStart && (
                        <div
                          className="group/group-header mx-1 mb-0.5 mt-1 flex h-7 items-center gap-1 rounded px-1.5 text-[11px] transition-colors"
                          style={{
                            color: hasActiveGroupMember ? 'var(--shell-text)' : 'var(--shell-dim)',
                            background: isHeaderGroupTarget ? 'var(--shell-accent-soft)' : 'transparent',
                            boxShadow: isHeaderGroupTarget ? 'inset 0 0 0 1px var(--shell-accent-border)' : 'none',
                          }}
                          onContextMenu={(event) => handleGroupContextMenu(group, event)}
                          onDragOver={(event) => handleGroupDragOver(groupMembers[0]!.id, event)}
                          onDrop={(event) => handleWorkspaceDrop(groupMembers[0]!, event)}
                        >
                          <button
                            type="button"
                            draggable={false}
                            aria-label={isGroupCollapsed ? t('common:workspace.groupExpand', { name: group.name }) : t('common:workspace.groupCollapse', { name: group.name })}
                            onDragStart={(event) => event.preventDefault()}
                            onClick={() => setCollapsedGroupIds((current) => current.includes(group.id)
                              ? current.filter((id) => id !== group.id)
                              : [...current, group.id])}
                            className="flex h-5 w-4 shrink-0 items-center justify-center border-0 bg-transparent text-[#666] transition-colors hover:text-[#aaa]"
                          >
                            <span
                              className="h-1.5 w-1.5 border-b border-r border-current transition-transform"
                              style={{ transform: isGroupCollapsed ? 'rotate(-45deg)' : 'rotate(45deg)' }}
                            />
                          </button>
                          {renamingGroupId === group.id ? (
                            <input
                              autoFocus
                              value={groupNameDraft}
                              onFocus={(event) => event.currentTarget.select()}
                              onChange={(event) => setGroupNameDraft(event.target.value)}
                              onKeyDown={handleGroupNameKeyDown}
                              onBlur={() => commitGroupRename(group.id)}
                              onClick={(event) => event.stopPropagation()}
                              className="min-w-0 flex-1 rounded-sm border border-[rgba(255,120,48,0.35)] bg-[rgba(0,0,0,0.28)] px-1.5 py-0.5 text-[11px] text-[#ddd] outline-none"
                              aria-label={t('common:workspace.groupNameAria')}
                            />
                          ) : (
                            <button
                              type="button"
                              draggable={false}
                              onDragStart={(event) => event.preventDefault()}
                              onClick={() => setCollapsedGroupIds((current) => current.includes(group.id)
                                ? current.filter((id) => id !== group.id)
                                : [...current, group.id])}
                              className="min-w-0 flex-1 truncate border-0 bg-transparent text-left"
                              title={t('common:workspace.groupCountTitle', { name: group.name, count: groupMembers.length })}
                            >
                              {group.name}
                            </button>
                          )}
                          {isGroupCollapsed && hasActiveGroupMember && (
                            <span className="h-1.5 w-1.5 rounded-full bg-[#ff7830] shadow-[0_0_5px_rgba(255,120,48,0.65)]" />
                          )}
                          <span className="font-mono text-[9px] text-[#555]">{groupMembers.length}</span>
                        </div>
                      )}

                      {!isGroupCollapsed && (
                        <div className={`relative mb-px${group ? ' ml-2 pl-1.5' : ''}`}>
                          {group && (
                            <div className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-[rgba(255,255,255,0.075)]" />
                          )}
                          <div
                            draggable
                            tabIndex={0}
                            role="button"
                            aria-current={isActive ? 'true' : undefined}
                            aria-label={t('common:workspace.wsAriaLabel', { name: ws.name })}
                            title={t('common:workspace.wsTitle', { prefix: group ? `${group.name} · ` : '', name: ws.name })}
                            onClick={() => handleSelect(ws.id)}
                            onKeyDown={(event) => handleWorkspaceKeyDown(ws, event)}
                            onContextMenu={(event) => handleWorkspaceContextMenu(ws, event)}
                            onDragStart={(event) => handleWorkspaceDragStart(ws, event)}
                            onDragOver={(event) => handleWorkspaceDragOver(ws, event)}
                            onDrop={(event) => handleWorkspaceDrop(ws, event)}
                            onDragEnd={() => handleWorkspaceDragEnd(ws.id)}
                            className="ws group relative flex h-9 cursor-grab items-center gap-2 rounded-[4px] px-2.5 text-[12px] transition-colors active:cursor-grabbing focus:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,120,48,0.38)]"
                            style={{
                              color: isActive ? 'var(--shell-text)' : 'var(--shell-muted)',
                              background: isGroupTarget
                                ? 'var(--shell-accent-soft)'
                                : isGroupPending
                                  ? 'var(--shell-hover)'
                                  : isActive
                                    ? 'var(--shell-accent-soft)'
                                    : 'transparent',
                              opacity: isDragged ? 0.42 : 1,
                              boxShadow: isGroupTarget
                                ? 'inset 0 0 0 1px rgba(255,120,48,0.48), 0 0 12px rgba(255,120,48,0.08)'
                                : isGroupPending
                                  ? 'inset 0 0 0 1px rgba(255,255,255,0.07)'
                                  : 'none',
                            }}
                          >
                            {isDropBefore && (
                              <div className="pointer-events-none absolute -top-px inset-x-1 h-0.5 rounded bg-[#ff7830] shadow-[0_0_7px_rgba(255,120,48,0.7)]" />
                            )}
                            {isDropAfter && (
                              <div className="pointer-events-none absolute -bottom-px inset-x-1 h-0.5 rounded bg-[#ff7830] shadow-[0_0_7px_rgba(255,120,48,0.7)]" />
                            )}
                            <div
                              className="pointer-events-none absolute bottom-1 left-0 top-1 w-0.5 rounded-r-sm transition-colors"
                              style={{ background: isActive ? 'var(--shell-accent)' : 'transparent' }}
                            />
                      <button
                        type="button"
                        draggable={false}
                        aria-label={isExpanded ? t('common:workspace.terminalListCollapse', { name: ws.name, count: terminalCount }) : t('common:workspace.terminalListExpand', { name: ws.name, count: terminalCount })}
                        title={isExpanded ? t('common:workspace.terminalListCollapseShort', { count: terminalCount }) : t('common:workspace.terminalListExpandShort', { count: terminalCount })}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDragStart={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleToggleWorkspaceExpand(ws.id, event)
                        }}
                        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-0 bg-transparent text-[#626268] transition-colors duration-150 hover:bg-white/[0.05] hover:text-[#aaa] focus:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,120,48,0.24)]"
                      >
                        <ChevronRight
                          size={12}
                          strokeWidth={1.8}
                          className="transition-transform duration-200 ease-out motion-reduce:transition-none"
                          style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                          aria-hidden="true"
                        />
                      </button>
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                        {ws.name}
                      </span>
                      {terminalCount > 0 && (
                        <span
                          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[3px] px-1.5 font-mono text-[9px] tabular-nums"
                          style={{
                            color: terminalActivity.errors > 0 ? '#ff8585' : terminalActivity.running > 0 ? '#87d9aa' : '#77777d',
                            background: terminalActivity.errors > 0
                              ? 'rgba(255,88,88,0.08)'
                              : terminalActivity.running > 0
                                ? 'rgba(70,190,125,0.08)'
                                : 'rgba(255,255,255,0.035)',
                          }}
                          title={t('common:workspace.terminalCountTitle', { total: terminalActivity.total, running: terminalActivity.running, errors: terminalActivity.errors ? t('common:workspace.terminalCountErrorsSuffix', { count: terminalActivity.errors }) : '' })}
                        >
                          <img src={terminalIcon} alt="" className="h-3 w-3 opacity-70" />
                          <span>{terminalActivity.total}</span>
                          <span
                            className="h-1.5 w-1.5 rounded-full transition-colors"
                            style={{
                              background: terminalActivity.errors > 0 ? '#ff6666' : terminalActivity.running > 0 ? '#58c98d' : '#55555b',
                            }}
                          />
                        </span>
                      )}
                      <button
                        type="button"
                        draggable={false}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDragStart={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        onClick={(event) => handleDeleteClick(ws, event)}
                        className="ws-del w-[16px] h-[16px] rounded-[3px] flex items-center justify-center text-[12px] leading-none text-[#666] opacity-0 group-hover:opacity-100 transition-all hover:bg-[rgba(255,88,88,0.12)] hover:!text-[#ff5858]"
                      >
                        ×
                      </button>
                    </div>
                    <div
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isExpanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'
                      }`}
                      aria-hidden={!isExpanded}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div
                          className="ml-5 mr-1 py-1"
                          style={{ borderLeft: '1px solid rgba(255,255,255,0.055)' }}
                        >
                        {workspaceTerminals.length === 0 ? (
                          <div className="px-3 py-2 font-mono text-[11px] text-[#4f4f4f]">{t('common:workspace.terminal.empty')}</div>
                        ) : (
                          workspaceTerminals.map((terminal) => {
                            const isFocusedTerminal = isActive && terminal.id === activeTerminalId
                            const presetLabel = terminalPresetLabel(terminal.preset, t)
                            const displayName = terminal.name || presetLabel
                            const showPresetLabel = displayName.trim().toLocaleLowerCase() !== presetLabel.trim().toLocaleLowerCase()
                            return (
                              <div
                                key={terminal.id}
                                draggable
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onDragStart={(event) => handleTerminalPreviewDragStart(terminal, event)}
                                onDragEnd={() => clearTerminalDragData(terminal.id)}
                                className="group/terminal mb-0.5 grid w-full cursor-grab grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-[3px] px-2 py-1.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.04)] active:cursor-grabbing"
                                style={{
                                  background: isFocusedTerminal ? 'rgba(255,120,48,0.055)' : 'transparent',
                                  color: isFocusedTerminal ? '#d8d8d8' : '#8a8a8a',
                                }}
                                title={`${presetLabel} · ${terminal.cwd}`}
                              >
                                <span
                                  className="flex h-[18px] w-[18px] items-center justify-center"
                                  title={presetLabel}
                                >
                                  <img
                                    src={TERMINAL_PRESET_ICONS[terminal.preset]}
                                    alt={t('common:workspace.presetIconAlt', { preset: presetLabel })}
                                    className="h-3.5 w-3.5 object-contain"
                                  />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate font-mono text-[11px]">
                                    {displayName}
                                  </span>
                                  {showPresetLabel && (
                                    <span className="block truncate text-[9px] text-[#55555b]">
                                      {presetLabel}
                                    </span>
                                  )}
                                </span>
                                <TerminalStatusIndicator status={terminal.status} />
                              </div>
                            )
                          })
                        )}
                        </div>
                      </div>
                    </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                <div
                  className="relative h-2"
                  onDragOver={(event) => handleBoundaryDragOver('end', event)}
                  onDrop={(event) => handleBoundaryDrop('end', event)}
                >
                  {dropIntent?.mode === 'end' && (
                    <div className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-[#ff7830] shadow-[0_0_7px_rgba(255,120,48,0.7)]" />
                  )}
                </div>
              </>
            )}
          </div>
      </div>

      {/* 收起态 */}
      <div className="workspace-sidebar__collapsed flex flex-1 flex-col items-center gap-1 overflow-hidden py-1.5" aria-hidden={!sidebarCollapsed} {...(!sidebarCollapsed ? { inert: '' } : {})}>
          <button
            onClick={toggleSidebar}
            title={t('common:workspace.expand')}
            className="mb-1 flex h-9 w-9 items-center justify-center rounded-[4px] transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
            style={{ color: 'var(--shell-dim)' }}
            aria-label={t('common:workspace.expandAria')}
            aria-expanded={false}
            aria-controls="workspace-sidebar-content"
          >
            <PanelLeftOpen size={15} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <div
            className="w-5 h-px my-1"
            style={{ background: 'rgba(255, 255, 255, 0.06)' }}
          />
          {orderedWorkspaces.map((ws, workspaceIndex) => {
            const isActive = ws.id === activeWorkspaceId
            const isGroupStart = !!ws.sidebarGroup && orderedWorkspaces[workspaceIndex - 1]?.sidebarGroup?.id !== ws.sidebarGroup.id
            const isDragged = draggedWorkspaceId === ws.id
            const isDropBefore = dropIntent?.targetId === ws.id && dropIntent.mode === 'before'
            const isDropAfter = dropIntent?.targetId === ws.id && dropIntent.mode === 'after'
            const isGroupPending = dropIntent?.targetId === ws.id && dropIntent.mode === 'group-pending'
            const isGroupTarget = dropIntent?.targetId === ws.id && dropIntent.mode === 'group'

            return (
              <div
                key={ws.id}
                draggable
                tabIndex={0}
                role="button"
                aria-current={isActive ? 'true' : undefined}
                onClick={() => handleSelect(ws.id)}
                onKeyDown={(event) => handleWorkspaceKeyDown(ws, event)}
                onContextMenu={(event) => handleWorkspaceContextMenu(ws, event)}
                onDragStart={(event) => handleWorkspaceDragStart(ws, event)}
                onDragOver={(event) => handleWorkspaceDragOver(ws, event)}
                onDrop={(event) => handleWorkspaceDrop(ws, event)}
                onDragEnd={() => handleWorkspaceDragEnd(ws.id)}
                title={t('common:workspace.wsTitle', { prefix: ws.sidebarGroup ? `${ws.sidebarGroup.name} · ` : '', name: ws.name })}
                className="ws relative flex h-9 w-9 cursor-grab items-center justify-center rounded-[4px] transition-colors active:cursor-grabbing focus:outline-none focus-visible:ring-1 focus-visible:ring-[rgba(255,120,48,0.38)]"
                style={{
                  marginTop: isGroupStart && workspaceIndex > 0 ? 5 : 0,
                  background: isGroupTarget
                    ? 'var(--shell-accent-soft)'
                    : isGroupPending
                      ? 'var(--shell-hover)'
                      : isActive
                        ? 'var(--shell-accent-soft)'
                        : 'transparent',
                  opacity: isDragged ? 0.42 : 1,
                  boxShadow: isGroupTarget
                    ? 'inset 0 0 0 1px rgba(255,120,48,0.45)'
                    : isGroupPending
                      ? 'inset 0 0 0 1px rgba(255,255,255,0.07)'
                      : 'none',
                }}
              >
                {isDropBefore && (
                  <div className="pointer-events-none absolute -top-px inset-x-0 h-0.5 rounded bg-[#ff7830]" />
                )}
                {isDropAfter && (
                  <div className="pointer-events-none absolute -bottom-px inset-x-0 h-0.5 rounded bg-[#ff7830]" />
                )}
                <div
                  className="pointer-events-none absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-r-sm"
                  style={{ background: isActive ? 'var(--shell-accent)' : 'transparent' }}
                />
                <span
                  className="font-mono text-[13px] font-semibold"
                  style={{ color: isActive ? 'var(--shell-accent-strong)' : 'var(--shell-dim)' }}
                >
                  {workspaceInitial(ws.name)}
                </span>
              </div>
            )
          })}
      </div>
      {contextMenu && (
        <WorkspaceContextMenu
          menu={contextMenu}
          onRunConfiguration={handleRunConfiguration}
          onRenameGroup={startRenamingGroup}
          onRemoveFromGroup={handleRemoveFromGroup}
          onClearGroup={handleClearGroup}
          onDelete={handleContextDelete}
        />
      )}
      {/* 删除确认弹窗 — portal 到 body 级别，居窗口中央 */}
      {deleteTarget && createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{
            background: 'rgba(8,8,10,0.62)',
            backdropFilter: 'blur(10px)',
            zIndex: 1000,
          }}
        >
          <div
            className="overflow-hidden"
            style={{
              width: 380,
              background: 'rgba(22,22,22,0.98)',
              border: '1px solid rgba(255,88,88,0.2)',
              borderRadius: 8,
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              animation: 'island-expand-modal 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            {/* Header */}
            <div
              className="flex justify-between items-center"
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div
                className="font-semibold flex items-center"
                style={{ fontSize: 13, color: '#fff', gap: 6 }}
              >
                <span style={{ color: '#ff5858' }}>&#9888;</span>
                {t('common:workspace.delete.title')}
              </div>
              <ModalCloseButton onClose={() => setDeleteTarget(null)} />
            </div>

            {/* Body */}
            <div style={{ padding: '16px 16px 20px' }}>
              <div style={{ fontSize: 12, color: '#999', marginBottom: 14, lineHeight: 1.6 }}>
                {t('common:workspace.delete.confirm', { name: deleteTarget.name })}
              </div>

              <div
                style={{
                  padding: '8px 10px',
                  background: 'rgba(255,88,88,0.06)',
                  border: '1px solid rgba(255,88,88,0.12)',
                  borderRadius: 4,
                  fontSize: 11,
                  color: '#c0848a',
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: '#ff5858', marginRight: 4 }}>&#8226;</span>
                {t('common:workspace.delete.checkpointWarning')}
              </div>
            </div>

            {/* Footer */}
            <div
              className="flex justify-end"
              style={{
                padding: '10px 16px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
                gap: 8,
              }}
            >
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded cursor-pointer transition-colors"
                style={{
                  height: 28,
                  padding: '0 14px',
                  fontSize: 11,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#999',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
                  e.currentTarget.style.color = '#ccc'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                  e.currentTarget.style.color = '#999'
                }}
              >
                {t('common:action.cancel')}
              </button>
              <button
                onClick={confirmDelete}
                className="rounded cursor-pointer transition-colors"
                style={{
                  height: 28,
                  padding: '0 14px',
                  fontSize: 11,
                  background: 'rgba(255,88,88,0.12)',
                  border: '1px solid rgba(255,88,88,0.3)',
                  color: '#ff5858',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,88,88,0.22)'
                  e.currentTarget.style.borderColor = 'rgba(255,88,88,0.5)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,88,88,0.12)'
                  e.currentTarget.style.borderColor = 'rgba(255,88,88,0.3)'
                }}
              >
                {t('common:action.delete')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* 工作区启动配置弹窗 */}
      {configTarget && createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{
            background: 'rgba(8,8,10,0.62)',
            backdropFilter: 'blur(10px)',
            zIndex: 1000,
          }}
        >
          <div className="ws-config-modal">
            {/* Header */}
            <div
              className="flex justify-between items-center"
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div
                className="font-semibold flex items-center"
                style={{ fontSize: 13, color: '#fff', gap: 8 }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d4d4d4" strokeWidth="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span>{t('common:workspace.launcherTitle')}</span>
              </div>
              <ModalCloseButton onClose={() => { setConfigTarget(null); setProjectCandidate(null) }} />
            </div>
            {/* Body */}
            <div style={{ padding: '0', overflow: 'hidden', flex: 1 }}>
              <ProjectLauncher
                projectPath={projectCandidate?.projectPath ?? configTarget.path}
                workspaceId={configTarget.id}
                workspaceRoot={configTarget.path}
                projectRelativePath={projectCandidate?.relativePath ?? ''}
                candidateConfig={projectCandidate?.config ?? null}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  )
}
