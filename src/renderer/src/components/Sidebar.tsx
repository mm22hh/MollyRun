import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ScriptRecord, ScriptStatus } from '../../../shared/model'
import { moveBeside, placeVisibleOrder } from '../../../shared/order'

type Props = {
  scripts: ScriptRecord[]
  statuses: Record<string, ScriptStatus>
  scope: Scope
  onScope: (scope: Scope) => void
  selectedId: string | null
  now: number
  onOpen: (id: string) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  onEdit: (script: ScriptRecord) => void
  onDelete: (id: string) => void
  onReorder: (ids: string[]) => void | Promise<boolean | void>
  onCreate: () => void
}

const MIN_SIDEBAR_WIDTH = 240
const DEFAULT_SIDEBAR_WIDTH = 300

type MenuState = { id: string; x: number; y: number }

export type Scope = 'all' | 'running'

export function Sidebar({ scripts, statuses, scope, onScope, selectedId, now, onOpen, onStart, onStop, onEdit, onDelete, onReorder, onCreate }: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [previewIds, setPreviewIds] = useState<string[] | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [width, setWidth] = useState(storedSidebarWidth)
  const dragIdRef = useRef<string | null>(null)
  const previewRef = useRef<string[] | null>(null)
  const endGesture = useRef<(() => void) | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)
  const resizeRef = useRef<{ x: number; width: number } | null>(null)
  const ordered = useMemo(() => orderScripts(scripts, previewIds), [scripts, previewIds])
  const visible = ordered.filter((script) => scope === 'all' || statuses[script.id]?.state === 'running')

  useEffect(() => {
    if (!previewIds || dragId) return
    const current = scripts.map((script) => script.id)
    if (current.length === previewIds.length && current.every((id, index) => id === previewIds[index])) {
      previewRef.current = null
      setPreviewIds(null)
    }
  }, [scripts, previewIds, dragId])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onPointer = (event: PointerEvent) => {
      if (event.button === 2) return
      if (menuRef.current?.contains(event.target as Node)) return
      close()
    }
    const onContext = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if ((event.target as Element | null)?.closest?.('.row')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('contextmenu', onContext)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('contextmenu', onContext)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useEffect(() => {
    const onResize = () => {
      const next = clampSidebarWidth(widthRef.current)
      if (next === widthRef.current) return
      widthRef.current = next
      setWidth(next)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!dragId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      cancelDrag()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragId])

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    if (rect.right > window.innerWidth - pad) el.style.left = `${Math.max(pad, window.innerWidth - rect.width - pad)}px`
    if (rect.bottom > window.innerHeight - pad) el.style.top = `${Math.max(pad, window.innerHeight - rect.height - pad)}px`
  }, [menu])

  function cancelDrag() {
    endGesture.current?.()
    dragIdRef.current = null
    previewRef.current = null
    document.body.classList.remove('reordering-scripts')
    setDragId(null)
    setPreviewIds(null)
  }

  function visibleIdsFrom(allIds: string[]): string[] {
    return allIds.filter((id) => {
      if (!scripts.some((script) => script.id === id)) return false
      return scope === 'all' || statuses[id]?.state === 'running'
    })
  }

  function applyPointer(targetId: string, clientY: number, rect: DOMRect) {
    const sourceId = dragIdRef.current
    if (!sourceId) return
    const allIds = previewRef.current ?? scripts.map((script) => script.id)
    const visibleIds = visibleIdsFrom(allIds)
    const after = clientY > rect.top + rect.height / 2
    const nextVisible = moveBeside(visibleIds, sourceId, targetId, after)
    if (nextVisible === visibleIds) return
    const nextAll = placeVisibleOrder(allIds, nextVisible)
    previewRef.current = nextAll
    setPreviewIds(nextAll)
  }

  function commitDrop() {
    const sourceId = dragIdRef.current
    dragIdRef.current = null
    document.body.classList.remove('reordering-scripts')
    setDragId(null)
    if (!sourceId) return
    const next = previewRef.current
    const current = scripts.map((script) => script.id)
    const changed = !!next && next.some((id, index) => id !== current[index])
    if (!changed || !next) {
      previewRef.current = null
      setPreviewIds(null)
      return
    }
    void Promise.resolve(onReorder(next)).then((saved) => {
      if (saved === false) {
        previewRef.current = null
        setPreviewIds(null)
      }
    })
  }

  function onRowPointerDown(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    if (event.button !== 0) return
    if ((event.target as Element).closest('.row-action')) return
    const startX = event.clientX
    const startY = event.clientY
    let active = false
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (dx * dx + dy * dy < 16) return
        active = true
        dragIdRef.current = id
        const ids = scripts.map((script) => script.id)
        previewRef.current = ids
        document.body.classList.add('reordering-scripts')
        setDragId(id)
        setPreviewIds(ids)
        setMenu(null)
      }
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)
      const row = hit?.closest<HTMLElement>('[data-testid^="row-"]')
      if (!row) return
      const targetId = row.dataset.testid?.slice('row-'.length)
      if (!targetId) return
      applyPointer(targetId, ev.clientY, row.getBoundingClientRect())
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      endGesture.current = null
    }
    const onUp = () => {
      stop()
      if (!active) return
      const swallow = (click: MouseEvent) => {
        click.preventDefault()
        click.stopPropagation()
      }
      window.addEventListener('click', swallow, true)
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      commitDrop()
    }
    const onCancel = () => {
      stop()
      if (!active) return
      dragIdRef.current = null
      previewRef.current = null
      document.body.classList.remove('reordering-scripts')
      setDragId(null)
      setPreviewIds(null)
    }
    endGesture.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  function onResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    resizeRef.current = { x: event.clientX, width: widthRef.current }
    document.body.classList.add('resizing-sidebar')
    const onMove = (ev: PointerEvent) => {
      const drag = resizeRef.current
      if (!drag) return
      const next = clampSidebarWidth(drag.width + ev.clientX - drag.x)
      if (next === widthRef.current) return
      widthRef.current = next
      setWidth(next)
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    const onUp = () => {
      stop()
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.classList.remove('resizing-sidebar')
      try {
        localStorage.setItem('scriptboard.sidebarWidth', String(widthRef.current))
      } catch {
        // 宽度记不住时，这次拖动仍然有效。
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function openMenu(script: ScriptRecord) {
    onEdit(script)
    setMenu(null)
  }

  function deleteFromMenu() {
    if (!menu) return
    const id = menu.id
    setMenu(null)
    onDelete(id)
  }

  const menuScript = menu ? scripts.find((script) => script.id === menu.id) : undefined

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <div className="wordmark" data-testid="app-name">MollyRun</div>
      </div>
      <div className="segment list-filter">
        <button type="button" aria-pressed={scope === 'all'} data-testid="filter-all" onClick={() => onScope('all')}>
          全部
        </button>
        <button type="button" aria-pressed={scope === 'running'} data-testid="filter-running" onClick={() => onScope('running')}>
          运行中
        </button>
      </div>
      <div className="script-list">
        {scripts.length === 0 ? (
          <div className="sidebar-empty">
            <p>还没有脚本</p>
            <p>把一个 Python 文件或一条命令登记进来，就可以从这里启动。</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="sidebar-empty" data-testid="running-empty">
            <p>没有正在运行的脚本</p>
          </div>
        ) : (
          visible.map((script) => {
            const status = statuses[script.id]
            const running = status?.state === 'running'
            const meta = metaParts(script, status, now)
            const className = ['row', script.id === selectedId ? 'selected' : '', script.id === dragId ? 'dragging' : ''].filter(Boolean).join(' ')
            return (
              <div
                key={script.id}
                className={className}
                data-testid={`row-${script.id}`}
                onPointerDown={(event) => onRowPointerDown(event, script.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: script.id, x: event.clientX, y: event.clientY })
                }}
              >
                <button type="button" className="row-main" onClick={() => onOpen(script.id)}>
                  <span className={dotClass(status)} />
                  <span className="row-copy">
                    <span className="row-name">{script.name}</span>
                    <span className={metaClass(status)} data-testid={`meta-${script.id}`}>
                      <span className="row-file">{meta.file}</span>
                      {meta.detail ? <span className="row-detail">{meta.detail}</span> : null}
                    </span>
                  </span>
                </button>
                {running ? (
                  <button type="button" className="row-action stop" data-testid={`stop-${script.id}`} onClick={() => onStop(script.id)}>
                    停止
                  </button>
                ) : (
                  <button type="button" className="row-action" data-testid={`start-${script.id}`} onClick={() => onStart(script.id)}>
                    启动
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
      <button type="button" className="add-script" data-testid="add-script" onClick={onCreate}>
        添加脚本
      </button>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整列表宽度"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={width}
        aria-valuemax={maxSidebarWidth()}
        data-testid="sidebar-resizer"
        onPointerDown={onResizePointerDown}
      />
      {menu && menuScript ? (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          tabIndex={-1}
          data-testid="row-menu"
          style={{ top: menu.y, left: menu.x }}
        >
          <button type="button" role="menuitem" data-testid="menu-edit" onClick={() => openMenu(menuScript)}>
            编辑
          </button>
          <button type="button" role="menuitem" className="danger" data-testid="menu-delete" onClick={deleteFromMenu}>
            删除
          </button>
        </div>
      ) : null}
    </aside>
  )
}

function orderScripts(scripts: ScriptRecord[], previewIds: string[] | null): ScriptRecord[] {
  if (!previewIds) return scripts
  const byId = new Map(scripts.map((script) => [script.id, script]))
  const next: ScriptRecord[] = []
  for (const id of previewIds) {
    const script = byId.get(id)
    if (script) next.push(script)
  }
  for (const script of scripts) {
    if (!previewIds.includes(script.id)) next.push(script)
  }
  return next
}

function dotClass(status: ScriptStatus | undefined): string {
  if (status?.state === 'running') return 'dot running'
  if (status?.state === 'exited' && status.exitCode) return 'dot bad'
  if (status?.state === 'exited') return 'dot done'
  return 'dot idle'
}

function metaClass(status: ScriptStatus | undefined): string {
  if (status?.state === 'exited' && status.exitCode) return 'row-meta bad'
  return 'row-meta'
}

function metaParts(script: ScriptRecord, status: ScriptStatus | undefined, now: number): { file: string; detail: string } {
  const file = script.kind === 'command' ? script.command : baseName(script.scriptPath)
  if (status?.state === 'running' && status.startedAt) return { file, detail: formatDuration(now - status.startedAt) }
  if (status?.state === 'exited' && status.stoppedByUser) return { file, detail: '已停止' }
  if (status?.state === 'exited') return { file, detail: `退出 ${status.exitCode ?? 0}` }
  if (script.venvPath) return { file, detail: baseName(script.venvPath) }
  return { file, detail: '' }
}

function clampSidebarWidth(value: number): number {
  const max = maxSidebarWidth()
  return Math.round(Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, value)))
}

function maxSidebarWidth(): number {
  return Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 420)
}

function storedSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem('scriptboard.sidebarWidth'))
    if (Number.isFinite(raw) && raw > 0) return clampSidebarWidth(raw)
  } catch {
    // 读不到上次的宽度时用默认值。
  }
  return DEFAULT_SIDEBAR_WIDTH
}

function baseName(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
