import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { t } from '../shared/i18n'
import {
  argsError,
  normalizeInput,
  type ScriptInput,
  type ScriptRecord
} from '../shared/model'

const LOOKUP_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':')

export function lookupSystemPython(): string {
  try {
    const output = execFileSync('/usr/bin/which', ['python3'], {
      encoding: 'utf8',
      env: { PATH: LOOKUP_PATH }
    }).trim()
    const found = output.split('\n').map((line) => line.trim()).find(Boolean)
    if (!found) throw new Error('找不到')
    return found
  } catch {
    throw new Error(t('error.noSystemPython'))
  }
}

export function findVenvPython(venvPath: string): string | null {
  for (const name of ['python3', 'python']) {
    const candidate = path.join(venvPath, 'bin', name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}

export function resolveInterpreter(venvPath: string | null): string {
  if (!venvPath) return lookupSystemPython()
  const python = findVenvPython(venvPath)
  if (!python) throw new Error(t('error.noVenvPython'))
  return python
}

export function prepareScript(input: ScriptInput, id: string): ScriptRecord {
  const script = normalizeInput(input, os.homedir())
  script.id = id
  const problem = validateScript(script)
  if (problem) throw new Error(problem)
  return script
}

export function validateScript(script: ScriptRecord): string | null {
  if (!script.name) return t('error.needName')
  if (script.name.length > 80) return t('error.nameLong')
  if (script.kind === 'command') {
    if (!script.command) return t('error.needCommand')
    if (script.command.length > 4000) return t('error.commandLong')
    return null
  }
  const parsed = argsError(script.args)
  if (parsed) return parsed
  if (!script.scriptPath) return t('error.needPython')
  if (!script.scriptPath.toLowerCase().endsWith('.py')) return t('error.needPy')
  if (!path.isAbsolute(script.scriptPath)) return t('error.absScript')
  if (!isFile(script.scriptPath)) return t('error.notPython')
  if (script.venvPath) {
    if (!path.isAbsolute(script.venvPath)) return t('error.absVenv')
    if (!findVenvPython(script.venvPath)) return t('error.noVenvPython')
  }
  return null
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}
