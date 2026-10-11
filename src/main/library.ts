import fs from 'fs'
import path from 'path'
import type { ScriptRecord } from '../shared/model'

export class Library {
  private scripts: ScriptRecord[] = []

  constructor(private readonly file: string) {
    this.scripts = readScripts(file)
  }

  list(): ScriptRecord[] {
    return this.scripts
  }

  get(id: string): ScriptRecord | undefined {
    return this.scripts.find((script) => script.id === id)
  }

  upsert(script: ScriptRecord): void {
    const index = this.scripts.findIndex((item) => item.id === script.id)
    if (index >= 0) this.scripts[index] = script
    else this.scripts.push(script)
    this.persist()
  }

  remove(id: string): void {
    this.scripts = this.scripts.filter((script) => script.id !== id)
    this.persist()
  }

  reorder(ids: string[]): void {
    const byId = new Map(this.scripts.map((script) => [script.id, script]))
    const next: ScriptRecord[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      const script = byId.get(id)
      if (!script || seen.has(id)) continue
      seen.add(id)
      next.push(script)
    }
    for (const script of this.scripts) {
      if (!seen.has(script.id)) next.push(script)
    }
    this.scripts = next
    this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ scripts: this.scripts }, null, 2))
    fs.renameSync(tmp, this.file)
  }
}

function readScripts(file: string): ScriptRecord[] {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('scripts.json 无法解析，已停止启动以免覆盖原来的登记。')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { scripts?: unknown }).scripts)) {
    throw new Error('scripts.json 格式不对，已停止启动以免覆盖原来的登记。')
  }
  const scripts = (parsed as { scripts: unknown[] }).scripts
  return scripts.flatMap((value) => {
    const script = readScript(value)
    return script ? [script] : []
  })
}

function readScript(value: unknown): ScriptRecord | null {
  if (!value || typeof value !== 'object') return null
  const script = value as Partial<ScriptRecord>
  if (typeof script.id !== 'string' || typeof script.name !== 'string') return null
  if (script.kind === 'command') {
    if (typeof script.command !== 'string') return null
    return {
      id: script.id,
      name: script.name,
      kind: 'command',
      scriptPath: '',
      args: '',
      venvPath: null,
      command: script.command
    }
  }
  if (
    typeof script.scriptPath !== 'string' ||
    typeof script.args !== 'string' ||
    (script.venvPath !== null && typeof script.venvPath !== 'string')
  ) {
    return null
  }
  return {
    id: script.id,
    name: script.name,
    kind: 'python',
    scriptPath: script.scriptPath,
    args: script.args,
    venvPath: script.venvPath ?? null,
    command: ''
  }
}
