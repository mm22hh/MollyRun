import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { ScriptStatus, TerminalChunk } from '../../../shared/model'
import { useT } from '../i18n'
import '@xterm/xterm/css/xterm.css'

type Props = {
  scriptId: string
  active: boolean
  status: ScriptStatus | undefined
  onStop: (id: string) => void
}

const CURSOR = '#e7c56a'

const DARK_THEME = {
  background: '#1c1b17',
  foreground: '#f4f0e6',
  cursor: '#1c1b17',
  cursorAccent: '#1c1b17',
  selectionBackground: 'rgba(231, 197, 106, 0.28)',
  black: '#1c1b17',
  red: '#ff7b72',
  green: '#8bd17c',
  yellow: '#e7c56a',
  blue: '#79b8ff',
  magenta: '#d2a8ff',
  cyan: '#7ddec9',
  white: '#f4f0e6',
  brightBlack: '#8a8478',
  brightRed: '#ff938c',
  brightGreen: '#a6e39a',
  brightYellow: '#f0d48a',
  brightBlue: '#9dc9ff',
  brightMagenta: '#e2c2ff',
  brightCyan: '#a5ecdc',
  brightWhite: '#ffffff'
}

const LIGHT_THEME = {
  background: '#fbf9f4',
  foreground: '#1d1b16',
  cursor: '#fbf9f4',
  cursorAccent: '#fbf9f4',
  selectionBackground: 'rgba(31, 122, 77, 0.22)',
  black: '#1d1b16',
  red: '#b42318',
  green: '#1f7a4d',
  yellow: '#8a5a00',
  blue: '#185fa5',
  magenta: '#7a3e9d',
  cyan: '#0e6e6a',
  white: '#f7f4ee',
  brightBlack: '#6f685e',
  brightRed: '#cf3b30',
  brightGreen: '#2f9e62',
  brightYellow: '#a56b00',
  brightBlue: '#2b7fc4',
  brightMagenta: '#9454b8',
  brightCyan: '#1a8f88',
  brightWhite: '#ffffff'
}

export function TerminalPane({ scriptId, active, status, onStop }: Props) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const clearRef = useRef<() => Promise<void>>(async () => {})
  const menuRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(active)
  const [hasOutput, setHasOutput] = useState(false)
  const [settled, setSettled] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const running = status?.state === 'running'
  focusedRef.current = active

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let ready = false
    let last = 0
    let sawOutput = false
    let holding = false
    const pending: TerminalChunk[] = []
    const held: TerminalChunk[] = []
    setHasOutput(false)
    setSettled(false)

    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: true,
      reflowCursorLine: true,
      theme: paintTheme(false)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    showCursor(term, false)

    const noteOutput = (text: string) => {
      if (!text || sawOutput) return
      sawOutput = true
      setHasOutput(true)
    }

    const apply = (chunk: TerminalChunk) => {
      if (holding) {
        held.push(chunk)
        return
      }
      if (chunk.seq <= last) return
      last = chunk.seq
      term.write(chunk.data)
      noteOutput(chunk.data)
    }

    const off = window.scriptboard.onData((chunk) => {
      if (chunk.id !== scriptId) return
      if (!ready) pending.push(chunk)
      else apply(chunk)
    })

    const sendSize = () => {
      fit.fit()
      if (term.cols >= 2 && term.rows >= 2) window.scriptboard.resize(scriptId, term.cols, term.rows)
    }
    sendSize()
    const frame = requestAnimationFrame(sendSize)
    const observer = new ResizeObserver(() => sendSize())
    observer.observe(host)

    const input = term.onData((data) => window.scriptboard.write(scriptId, data))
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.metaKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return true
    })

    void window.scriptboard.snapshot(scriptId).then((snap) => {
      if (cancelled) return
      last = snap.seq
      if (snap.text) term.write(snap.text)
      noteOutput(snap.text)
      ready = true
      for (const chunk of pending) apply(chunk)
      if (!cancelled) setSettled(true)
      if (focusedRef.current) term.focus()
    })

    clearRef.current = async () => {
      holding = true
      held.length = 0
      try {
        const snap = await window.scriptboard.clear(scriptId)
        if (cancelled) return
        last = snap.seq
        eraseTerminal(term)
        sawOutput = Boolean(snap.text)
        setHasOutput(sawOutput)
        if (snap.text) term.write(snap.text)
      } finally {
        if (!cancelled) {
          holding = false
          const queued = held.splice(0)
          for (const chunk of queued) apply(chunk)
        }
      }
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      input.dispose()
      off()
      clearRef.current = async () => {}
      termRef.current = null
      term.dispose()
    }
  }, [scriptId])

  useEffect(() => {
    const paint = () => {
      const term = termRef.current
      if (term) term.options.theme = paintTheme(running)
      if (term) term.options.cursorBlink = running
    }
    paint()
    const observer = new MutationObserver(paint)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [running, settled])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, settled])

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
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [menu])

  const showHint = settled && !hasOutput && status?.state !== 'running' && status?.state !== 'exited'

  return (
    <div
      className={active ? 'terminal-pane active' : 'terminal-pane'}
      data-testid={`terminal-${scriptId}`}
      onContextMenu={(event) => {
        event.preventDefault()
        const itemCount = running ? 2 : 1
        const left = Math.min(event.clientX, window.innerWidth - 168)
        const top = Math.min(event.clientY, window.innerHeight - (12 + itemCount * 32))
        setMenu({ x: Math.max(8, left), y: Math.max(8, top) })
      }}
    >
      <div className="terminal-host" ref={hostRef} />
      {showHint ? (
        <div className="terminal-hint">
          <strong>{t('term.idle')}</strong>
          <span>{t('term.idleHint')}</span>
        </div>
      ) : null}
      {menu ? (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          data-testid="terminal-menu"
          style={{ top: menu.y, left: menu.x }}
        >
          {running ? (
            <button
              type="button"
              role="menuitem"
              className="danger"
              data-testid="menu-stop"
              onClick={() => {
                setMenu(null)
                onStop(scriptId)
              }}
            >
              {t('term.stop')}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="danger"
            data-testid="menu-clear"
            onClick={() => {
              setMenu(null)
              void clearRef.current()
            }}
          >
            {t('term.clear')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function eraseTerminal(term: Terminal): void {
  term.clear()
  term.write('\x1b[2J\x1b[H')
}

function paintTheme(cursorOn: boolean): NonNullable<Terminal['options']['theme']> {
  const dark = document.documentElement.dataset.theme === 'dark'
  const base = dark ? DARK_THEME : LIGHT_THEME
  return {
    ...base,
    cursor: cursorOn ? CURSOR : base.background,
    cursorAccent: base.background
  }
}

function showCursor(term: Terminal, visible: boolean): void {
  term.options.cursorBlink = visible
  term.options.theme = paintTheme(visible)
}
