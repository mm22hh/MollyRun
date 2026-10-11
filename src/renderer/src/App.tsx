import { useEffect, useState } from 'react'
import { formatCommand, parseArgs } from '../../shared/args'
import type { StageLayout } from '../../shared/api'
import type { ScriptRecord, ScriptStatus } from '../../shared/model'
import { ScriptForm } from './components/ScriptForm'
import { Sidebar, type Scope } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'
import { useT } from './i18n'

export function App() {
  const t = useT()
  const [scripts, setScripts] = useState<ScriptRecord[]>([])
  const [statuses, setStatuses] = useState<Record<string, ScriptStatus>>({})
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<ScriptRecord | null | undefined>(undefined)
  const [layout, setLayout] = useState<StageLayout>(storedLayout)
  const [scope, setScope] = useState<Scope>('all')
  const [now, setNow] = useState(() => Date.now())
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let ready = false
    const pending: ScriptStatus[] = []
    const apply = (status: ScriptStatus) => {
      setStatuses((current) => ({ ...current, [status.id]: status }))
    }
    const off = window.scriptboard.onStatus((status) => {
      if (!ready) pending.push(status)
      else apply(status)
    })
    void window.scriptboard.list().then(
      (data) => {
        if (!alive) return
        setScripts(data.scripts)
        setStatuses(Object.fromEntries(data.statuses.map((status) => [status.id, status])))
        ready = true
        pending.forEach(apply)
      },
      (error: unknown) => {
        if (!alive) return
        setLoadError(error instanceof Error ? error.message : t('error.list'))
      }
    )
    return () => {
      alive = false
      off()
    }
  }, [])

  const anyRunning = Object.values(statuses).some((status) => status.state === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  function openTab(id: string) {
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]))
    setActiveId(id)
  }

  function closeTab(id: string) {
    const next = openTabs.filter((tab) => tab !== id)
    setOpenTabs(next)
    if (activeId !== id) return
    const index = openTabs.indexOf(id)
    const neighbor = next.length === 0 ? null : next[Math.min(index, next.length - 1)]
    setActiveId(neighbor)
  }

  async function start(id: string) {
    openTab(id)
    const result = await window.scriptboard.start(id)
    if (!result.ok && result.error) setLoadError(result.error)
  }

  async function stop(id: string) {
    await window.scriptboard.stop(id)
  }

  async function reorder(ids: string[]): Promise<boolean> {
    const result = await window.scriptboard.reorder(ids)
    if (result.ok) {
      setScripts(result.scripts)
      return true
    }
    setLoadError(result.error)
    return false
  }

  function forget(id: string, next: ScriptRecord[]) {
    setScripts(next)
    setEditing((current) => (current && current.id === id ? undefined : current))
    const nextTabs = openTabs.filter((tab) => tab !== id)
    setOpenTabs(nextTabs)
    if (activeId === id) {
      const index = openTabs.indexOf(id)
      setActiveId(nextTabs.length === 0 ? null : nextTabs[Math.min(index, nextTabs.length - 1)])
    }
    setStatuses((current) => {
      if (!(id in current)) return current
      const copy = { ...current }
      delete copy[id]
      return copy
    })
  }

  async function removeScript(id: string) {
    const result = await window.scriptboard.remove(id)
    if (!result.ok) {
      if (result.error) setLoadError(result.error)
      return
    }
    forget(id, result.scripts)
  }

  const openScripts = openTabs.flatMap((id) => {
    const script = scripts.find((item) => item.id === id)
    return script ? [script] : []
  })
  const shownScripts = scope === 'all' ? openScripts : openScripts.filter((script) => statuses[script.id]?.state === 'running')
  const focus = shownScripts.find((script) => script.id === activeId) ?? shownScripts[0] ?? null
  const paneId = focus?.id

  function chooseLayout(next: StageLayout) {
    setLayout(next)
    try {
      localStorage.setItem('scriptboard.stageLayout', next)
    } catch {
      // 排法记不住时，这次切换仍然有效。
    }
  }

  useEffect(() => {
    return window.scriptboard.onLayout(chooseLayout)
  }, [])

  useEffect(() => {
    window.scriptboard.reportLayout(layout)
  }, [layout])

  return (
    <div className="app">
      <Sidebar
        scripts={scripts}
        statuses={statuses}
        scope={scope}
        onScope={setScope}
        selectedId={activeId}
        now={now}
        onOpen={openTab}
        onStart={(id) => void start(id)}
        onStop={(id) => void stop(id)}
        onEdit={(script) => setEditing(script)}
        onDelete={(id) => void removeScript(id)}
        onReorder={(ids) => reorder(ids)}
        onCreate={() => setEditing(null)}
      />
      <main className="stage">
        {layout === 'tabs' ? (
        <div className="stage-bar">
          <div className="tabs">
            {shownScripts.map((script) => {
                  const status = statuses[script.id]
                  const running = status?.state === 'running'
                  return (
                    <div key={script.id} className={['tab', script.id === activeId ? 'active' : '', running ? 'running' : ''].filter(Boolean).join(' ')} data-testid={`tab-${script.id}`}>
                      <button type="button" className="tab-label" onClick={() => setActiveId(script.id)}>
                        <span className={tabDot(status)} />
                        <span>{script.name}</span>
                      </button>
                      <button
                        type="button"
                        className="tab-close"
                        aria-label={t('stage.closeTab', { name: script.name })}
                        data-testid={`tab-close-${script.id}`}
                        onClick={() => closeTab(script.id)}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
          </div>
        </div>
        ) : (
          <div className="stage-drag" />
        )}
        {layout === 'tabs' && focus ? <RunLine script={focus} /> : null}
        {loadError ? <div className="banner">{loadError}</div> : null}
        {shownScripts.length === 0 ? (
          <div className="stage-empty" data-testid="empty-stage">
            {scope === 'running' ? (
              <>
                <strong>{t('stage.noneRunning')}</strong>
                <span>{t('stage.noneRunningHint')}</span>
              </>
            ) : (
              <>
                <strong>{t('stage.empty')}</strong>
                <span>{t('stage.emptyHint')}</span>
              </>
            )}
          </div>
        ) : layout !== 'tabs' ? (
          <div
            className="tile-grid"
            data-testid="tile-grid"
            style={{ gridTemplateColumns: `repeat(${tileColumns(shownScripts.length, layout)}, minmax(0, 1fr))` }}
          >
            {shownScripts.map((script) => {
              const status = statuses[script.id]
              const running = status?.state === 'running'
              return (
                <section
                  key={script.id}
                  className={['tile', script.id === activeId ? 'active' : '', running ? 'running' : ''].filter(Boolean).join(' ')}
                  data-testid={`tile-${script.id}`}
                  onPointerDown={() => {
                    if (script.id !== activeId) setActiveId(script.id)
                  }}
                >
                  <div className="tile-bar">
                    <span className={tabDot(status)} />
                    <span className="tile-name">{script.name}</span>
                    <button
                      type="button"
                      className="tab-close"
                      aria-label={t('stage.close', { name: script.name })}
                      data-testid={`tile-close-${script.id}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => closeTab(script.id)}
                    >
                      ×
                    </button>
                  </div>
                  <RunLine script={script} testId={`run-${script.id}`} />
                  <div className="tile-body">
                    <TerminalPane scriptId={script.id} active={script.id === activeId} status={status} onStop={(id) => void stop(id)} />
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="terminal-well">
            {layout === 'tabs' && paneId ? (
              <div className="terminal-stack">
                <TerminalPane key={paneId} scriptId={paneId} active status={statuses[paneId]} onStop={(id) => void stop(id)} />
              </div>
            ) : null}
          </div>
        )}
      </main>
      {editing !== undefined ? (
        <ScriptForm
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(script, next) => {
            setScripts(next)
            setEditing(undefined)
            openTab(script.id)
          }}
          onDeleted={(id, next) => forget(id, next)}
        />
      ) : null}
    </div>
  )
}

function storedLayout(): StageLayout {
  try {
    const saved = localStorage.getItem('scriptboard.stageLayout')
    if (saved === 'tile2' || saved === 'tile3') return saved
    if (saved === 'tiles') return 'tile3'
    return 'tabs'
  } catch {
    return 'tabs'
  }
}

function tileColumns(count: number, layout: StageLayout): number {
  const chosen = layout === 'tile2' ? 2 : 3
  return Math.max(1, Math.min(count, chosen))
}

function RunLine({ script, testId = 'run-line' }: { script: ScriptRecord; testId?: string }) {
  const [text, setText] = useState(() => runText(script))

  useEffect(() => {
    let cancelled = false
    if (script.kind === 'command') {
      setText(script.command)
      return
    }
    setText(runText(script))
    void window.scriptboard.resolvePython(script.venvPath).then((result) => {
      if (cancelled || !('python' in result)) return
      try {
        setText(formatCommand([result.python, script.scriptPath, ...parseArgs(script.args)]))
      } catch {
        setText(runText(script))
      }
    })
    return () => {
      cancelled = true
    }
  }, [script])

  return (
    <div className="run-line" data-testid={testId} title={text}>
      {text}
    </div>
  )
}

function runText(script: ScriptRecord): string {
  if (script.kind === 'command') return script.command
  try {
    const args = parseArgs(script.args)
    return formatCommand(args.length > 0 ? [script.scriptPath, ...args] : [script.scriptPath])
  } catch {
    return script.scriptPath
  }
}

function tabDot(status: ScriptStatus | undefined): string {
  if (status?.state === 'running') return 'dot running'
  if (status?.state === 'exited' && status.exitCode) return 'dot bad'
  if (status?.state === 'exited') return 'dot done'
  return 'dot idle'
}
