import path from 'path'

export type ScriptKind = 'python' | 'command'

export type ScriptRecord = {
  id: string
  name: string
  kind: ScriptKind
  scriptPath: string
  args: string
  venvPath: string | null
  command: string
}

export type ScriptInput = {
  id?: string
  name: string
  kind?: ScriptKind
  scriptPath: string
  args: string
  venvPath: string | null
  command?: string
}

export type ScriptStatus = {
  id: string
  state: 'idle' | 'running' | 'exited'
  exitCode: number | null
  startedAt: number | null
  pid: number | null
  stoppedByUser: boolean
}

export type TerminalSnapshot = {
  text: string
  seq: number
}

export type TerminalChunk = {
  id: string
  seq: number
  data: string
}

export function expandHome(input: string, home: string): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return path.join(home, input.slice(2))
  return input
}

export function normalizeVenvPath(input: string): string {
  let value = input.replace(/\/+$/, '')
  if (value.endsWith('/bin/python') || value.endsWith('/bin/python3')) {
    value = path.dirname(path.dirname(value))
  } else if (value.endsWith('/bin')) {
    value = path.dirname(value)
  }
  return value
}

export { argsError, formatCommand, parseArgs, shellEscape } from './args'

const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function envForRun(
  base: NodeJS.ProcessEnv,
  venvPath: string | null,
  binDir: string | null
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  let parts = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)
  const inherited = env.VIRTUAL_ENV
  if (inherited) {
    const inheritedBin = path.normalize(path.join(inherited, 'bin'))
    parts = parts.filter((part) => path.normalize(part) !== inheritedBin)
    delete env.VIRTUAL_ENV
  }

  if (venvPath && binDir) {
    const normalizedBin = path.normalize(binDir)
    parts = parts.filter((part) => path.normalize(part) !== normalizedBin)
    parts.unshift(binDir)
    env.VIRTUAL_ENV = venvPath
  } else if (parts.length === 0) {
    parts = [...SYSTEM_PATH]
  }

  env[pathKey] = parts.join(path.delimiter)
  env.TERM = 'xterm-256color'
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

function normalizeCommand(command: string): string {
  return command.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function normalizeInput(input: ScriptInput, home: string): ScriptRecord {
  const id = input.id?.trim() || ''
  const name = input.name.trim()
  if (input.kind === 'command') {
    return {
      id,
      name,
      kind: 'command',
      scriptPath: '',
      args: '',
      venvPath: null,
      command: normalizeCommand(input.command ?? '')
    }
  }
  const scriptPath = expandHome(input.scriptPath.trim(), home)
  const rawVenv = input.venvPath?.trim() ?? ''
  const venvPath = rawVenv ? normalizeVenvPath(expandHome(rawVenv, home)) : null
  return {
    id,
    name,
    kind: 'python',
    scriptPath,
    args: input.args.trim(),
    venvPath,
    command: ''
  }
}
