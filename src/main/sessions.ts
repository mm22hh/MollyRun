import fs from 'fs'
import os from 'os'
import * as pty from 'node-pty'
import path from 'path'
import { activeLocale, t } from '../shared/i18n'
import { envForRun, parseArgs, type ScriptRecord, type ScriptStatus, type TerminalChunk, type TerminalSnapshot } from '../shared/model'
import { resolveInterpreter } from './python'

const MAX_LOG = 500_000

type Log = {
  text: string
  seq: number
}

type Session = {
  id: string
  pty: pty.IPty | null
  log: Log
  status: ScriptStatus
  stoppedByUser: boolean
}

type Host = {
  sendStatus: (status: ScriptStatus) => void
  sendData: (chunk: TerminalChunk) => void
  getScript: (id: string) => ScriptRecord | undefined
}

export class Sessions {
  private sessions = new Map<string, Session>()
  private sizes = new Map<string, { cols: number; rows: number }>()
  private waiters = new Map<string, Array<() => void>>()

  constructor(private readonly host: Host) {}

  status(id: string): ScriptStatus {
    return this.sessions.get(id)?.status ?? idleStatus(id)
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.status.state === 'running'
  }

  runningIds(): string[] {
    return [...this.sessions.values()].filter((session) => session.status.state === 'running').map((session) => session.id)
  }

  snapshot(id: string): TerminalSnapshot {
    const session = this.sessions.get(id)
    if (!session) return { text: '', seq: 0 }
    return { text: session.log.text, seq: session.log.seq }
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    this.sizes.set(id, { cols, rows })
    const session = this.sessions.get(id)
    if (!session?.pty) return
    try {
      session.pty.resize(cols, rows)
    } catch {
      // The process can exit between the check and the resize.
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session?.pty) return
    try {
      session.pty.write(data)
    } catch {
      // Ignore writes that land after the process has gone.
    }
  }

  start(id: string): void {
    const script = this.host.getScript(id)
    if (!script) throw new Error(t('error.notFound'))
    const existing = this.sessions.get(id)
    if (existing?.pty) return

    const session = existing ?? this.create(id)
    this.sessions.set(id, session)

    if (script.kind === 'command') {
      if (session.log.text.length > 0) this.push(session, stamp(t('terminal.restarted')))
      this.push(session, commandLine(script.command))
      this.launch(session, commandShell(), ['-lc', script.command], os.homedir(), envForRun(globalThis.process.env, null, null), explainCommandSpawn)
      return
    }

    let python: string
    let parsed: string[]
    try {
      python = resolveInterpreter(script.venvPath)
      parsed = parseArgs(script.args)
    } catch (error) {
      this.push(session, `${messageOf(error)}\r\n`)
      this.markExited(session, 127, false)
      return
    }

    if (session.log.text.length > 0) this.push(session, stamp(t('terminal.restarted')))

    const binDir = script.venvPath ? path.dirname(python) : null
    this.launch(
      session,
      python,
      [script.scriptPath, ...parsed],
      path.dirname(script.scriptPath),
      envForRun(globalThis.process.env, script.venvPath, binDir),
      explainSpawn
    )
  }

  private launch(
    session: Session,
    file: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    explain: (error: unknown) => string
  ): void {
    const size = this.sizes.get(session.id) ?? { cols: 80, rows: 24 }
    let child: pty.IPty
    try {
      child = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd,
        env
      })
    } catch (error) {
      this.push(session, `${explain(error)}\r\n`)
      this.markExited(session, 127, false)
      return
    }

    const id = session.id
    session.pty = child
    session.stoppedByUser = false
    session.status = {
      id,
      state: 'running',
      exitCode: null,
      startedAt: Date.now(),
      pid: child.pid,
      stoppedByUser: false
    }
    this.host.sendStatus(session.status)

    child.onData((data) => {
      if (session.pty !== child) return
      this.push(session, data)
    })
    child.onExit(({ exitCode, signal }) => {
      if (session.pty !== child) return
      session.pty = null
      const stoppedByUser = session.stoppedByUser
      const code = typeof exitCode === 'number' ? exitCode : signal ? 128 + signal : 0
      const label = stoppedByUser ? t('terminal.stopped') : code === 0 ? t('terminal.exited') : t('terminal.exitedCode', { code })
      this.push(session, stamp(label))
      this.markExited(session, stoppedByUser ? null : code, stoppedByUser)
    })
  }

  stop(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session?.pty) return Promise.resolve()
    const child = session.pty
    session.stoppedByUser = true
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        clearTimeout(giveUp)
        resolve()
      }
      const waiters = this.waiters.get(id) ?? []
      waiters.push(finish)
      this.waiters.set(id, waiters)
      const killTimer = setTimeout(() => {
        if (!signalGroup(child.pid, 'SIGKILL')) finish()
      }, 3000)
      const giveUp = setTimeout(finish, 4500)
      if (!signalGroup(child.pid, 'SIGTERM')) finish()
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.runningIds().map((id) => this.stop(id)))
  }

  drop(id: string): void {
    const session = this.sessions.get(id)
    if (session?.pty) signalGroup(session.pty.pid, 'SIGKILL')
    this.sessions.delete(id)
    this.sizes.delete(id)
    this.waiters.delete(id)
  }

  clear(id: string): TerminalSnapshot {
    const session = this.sessions.get(id)
    if (!session) return { text: '', seq: 0 }
    session.log.text = ''
    session.log.seq += 1
    return { text: '', seq: session.log.seq }
  }

  private create(id: string): Session {
    return {
      id,
      pty: null,
      log: { text: '', seq: 0 },
      status: idleStatus(id),
      stoppedByUser: false
    }
  }

  private push(session: Session, data: string): void {
    if (!data) return
    session.log.text += data
    if (session.log.text.length > MAX_LOG) {
      session.log.text = session.log.text.slice(session.log.text.length - MAX_LOG)
    }
    session.log.seq += 1
    this.host.sendData({ id: session.id, seq: session.log.seq, data })
  }

  private markExited(session: Session, exitCode: number | null, stoppedByUser: boolean): void {
    session.status = {
      id: session.id,
      state: 'exited',
      exitCode,
      startedAt: session.status.startedAt,
      pid: null,
      stoppedByUser
    }
    this.host.sendStatus(session.status)
    const waiters = this.waiters.get(session.id) ?? []
    this.waiters.delete(session.id)
    waiters.forEach((waiter) => waiter())
  }
}

function idleStatus(id: string): ScriptStatus {
  return {
    id,
    state: 'idle',
    exitCode: null,
    startedAt: null,
    pid: null,
    stoppedByUser: false
  }
}

function stamp(label: string): string {
  const time = new Date().toLocaleTimeString(activeLocale(), { hour12: false })
  return `\r\n\x1b[38;5;245m──── ${label} ${time} ────\x1b[0m\r\n`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : t('error.start')
}

function explainSpawn(error: unknown): string {
  const message = messageOf(error)
  if (message.includes('ENOENT') || message.includes('posix_spawnp')) {
    return t('error.spawnPython')
  }
  return t('error.startDetail', { message })
}

function explainCommandSpawn(error: unknown): string {
  const message = messageOf(error)
  if (message.includes('ENOENT') || message.includes('posix_spawnp')) {
    return t('error.spawnCommand')
  }
  return t('error.startDetail', { message })
}

function commandLine(command: string): string {
  const lines = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const body = lines.map((line, index) => (index === 0 ? `$ ${line}` : line)).join('\x1bE')
  return `\x1b[38;5;245m${body}\x1b[0m\x1bE`
}

function commandShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash']
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return '/bin/zsh'
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (pid <= 0) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}
