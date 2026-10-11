import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
    throw new Error('找不到系统的 python3')
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
  if (!python) throw new Error('这个虚拟环境里没有 Python（需要 bin/python）')
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
  if (!script.name) return '请填写名称'
  if (script.name.length > 80) return '名称太长了'
  if (script.kind === 'command') {
    if (!script.command) return '请填写命令'
    if (script.command.length > 4000) return '命令太长了'
    return null
  }
  const parsed = argsError(script.args)
  if (parsed) return parsed
  if (!script.scriptPath) return '请选择 Python 文件'
  if (!script.scriptPath.toLowerCase().endsWith('.py')) return '请选择 .py 文件'
  if (!path.isAbsolute(script.scriptPath)) return '脚本请使用完整路径'
  if (!isFile(script.scriptPath)) return '找不到这个 Python 文件'
  if (script.venvPath) {
    if (!path.isAbsolute(script.venvPath)) return '虚拟环境请使用完整路径'
    if (!findVenvPython(script.venvPath)) return '这个虚拟环境里没有 Python（需要 bin/python）'
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
