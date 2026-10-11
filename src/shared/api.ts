import type { ScriptInput, ScriptRecord, ScriptStatus, TerminalChunk, TerminalSnapshot } from './model'

export type SaveResult =
  | { ok: true; script: ScriptRecord; scripts: ScriptRecord[] }
  | { ok: false; error: string }

export type RemoveResult =
  | { ok: true; scripts: ScriptRecord[] }
  | { ok: false; cancelled?: boolean; error?: string }

export type SourceResult = { ok: true; text: string } | { ok: false; error: string }

export type StageLayout = 'tabs' | 'tile3' | 'tile2'

export type ScriptboardApi = {
  list: () => Promise<{ scripts: ScriptRecord[]; statuses: ScriptStatus[] }>
  save: (input: ScriptInput) => Promise<SaveResult>
  remove: (id: string) => Promise<RemoveResult>
  start: (id: string) => Promise<{ ok: boolean; error?: string }>
  stop: (id: string) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  reorder: (ids: string[]) => Promise<{ ok: true; scripts: ScriptRecord[] } | { ok: false; error: string }>
  snapshot: (id: string) => Promise<TerminalSnapshot>
  clear: (id: string) => Promise<TerminalSnapshot>
  resolvePython: (venvPath: string | null) => Promise<{ python: string } | { error: string }>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  pickScript: (defaultPath?: string) => Promise<string | null>
  pickDir: (defaultPath?: string) => Promise<string | null>
  readSource: (id: string) => Promise<SourceResult>
  writeSource: (id: string, text: string) => Promise<SourceResult>
  onStatus: (callback: (status: ScriptStatus) => void) => () => void
  onData: (callback: (chunk: TerminalChunk) => void) => () => void
  onLayout: (callback: (layout: StageLayout) => void) => () => void
  reportLayout: (layout: StageLayout) => void
}
