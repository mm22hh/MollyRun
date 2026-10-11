import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { formatCommand, parseArgs } from '../../../shared/args'
import type { ScriptKind, ScriptRecord } from '../../../shared/model'

type Props = {
  initial: ScriptRecord | null
  onClose: () => void
  onSaved: (script: ScriptRecord, scripts: ScriptRecord[]) => void
  onDeleted: (id: string, scripts: ScriptRecord[]) => void
}

type Mode = 'system' | 'venv'

export function ScriptForm({ initial, onClose, onSaved, onDeleted }: Props) {
  const [kind, setKind] = useState<ScriptKind>(initial?.kind === 'command' ? 'command' : 'python')
  const [name, setName] = useState(initial?.name ?? '')
  const [scriptPath, setScriptPath] = useState(initial?.scriptPath ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [args, setArgs] = useState(initial?.args ?? '')
  const [mode, setMode] = useState<Mode>(initial?.venvPath ? 'venv' : 'system')
  const [venvPath, setVenvPath] = useState(initial?.venvPath ?? '')
  const [python, setPython] = useState<string | null>(null)
  const [pythonError, setPythonError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setError(null)
  }, [kind, name, scriptPath, command, args, venvPath, mode])

  useEffect(() => {
    if (kind === 'command') {
      setPython(null)
      setPythonError(null)
      return
    }
    let cancelled = false
    const selected = mode === 'venv' ? venvPath.trim() : null
    if (mode === 'venv' && !selected) {
      setPython(null)
      setPythonError(null)
      return
    }
    void window.scriptboard.resolvePython(selected).then((result) => {
      if (cancelled) return
      if ('python' in result) {
        setPython(result.python)
        setPythonError(null)
      } else {
        setPython(null)
        setPythonError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [kind, mode, venvPath])

  const preview = useMemo(() => {
    if (kind === 'command') {
      const text = command.trim()
      return { text: text || '填写命令后，这里会显示将要执行的内容', error: null }
    }
    try {
      const parsed = parseArgs(args)
      if (!scriptPath.trim()) {
        return { text: '选择 Python 文件后，这里会显示完整命令', error: pythonError }
      }
      if (!python) {
        return { text: '正在确认解释器…', error: pythonError }
      }
      return { text: formatCommand([python, scriptPath.trim(), ...parsed]), error: pythonError }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '参数无法解析'
      return { text: '', error: message }
    }
  }, [args, command, kind, python, pythonError, scriptPath])

  async function chooseScript() {
    const picked = await window.scriptboard.pickScript(scriptPath || undefined)
    if (!picked) return
    setScriptPath(picked)
    setName((current) => (current.trim() ? current : stem(picked)))
  }

  async function chooseVenv() {
    const picked = await window.scriptboard.pickDir(venvPath || scriptPath || undefined)
    if (!picked) return
    setVenvPath(picked)
    setMode('venv')
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    const result = await window.scriptboard.save({
      id: initial?.id,
      name,
      kind,
      scriptPath: kind === 'python' ? scriptPath : '',
      args: kind === 'python' ? args : '',
      venvPath: kind === 'python' && mode === 'venv' ? venvPath : null,
      command: kind === 'command' ? command : ''
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.script, result.scripts)
  }

  async function onDelete() {
    if (!initial) return
    const result = await window.scriptboard.remove(initial.id)
    if (!result.ok) {
      if (result.error) setError(result.error)
      return
    }
    onDeleted(initial.id, result.scripts)
  }

  return (
    <div className="backdrop">
      <form className="sheet" onSubmit={onSubmit}>
        <div className="sheet-head">
          <h2>{initial ? '编辑脚本' : '添加脚本'}</h2>
          <button type="button" className="sheet-close" aria-label="关闭" data-testid="close-form" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="sheet-body">
        <div className="field">
          <span>类型</span>
          <div className="segment">
            <button type="button" aria-pressed={kind === 'python'} data-testid="kind-python" onClick={() => setKind('python')}>
              Python 文件
            </button>
            <button type="button" aria-pressed={kind === 'command'} data-testid="kind-command" onClick={() => setKind('command')}>
              命令
            </button>
          </div>
        </div>
        <label>
          名称
          <input data-testid="field-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
        </label>
        {kind === 'command' ? (
          <label>
            命令
            <textarea
              data-testid="field-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={'可粘贴多行脚本，写法与终端相同\nnpm run dev'}
              spellCheck={false}
              rows={6}
            />
          </label>
        ) : null}
        {kind === 'python' ? (
        <>
        <label>
          Python 文件
          <span className="path-row">
            <input
              data-testid="field-script"
              value={scriptPath}
              onChange={(event) => setScriptPath(event.target.value)}
              placeholder="/path/to/train.py"
              spellCheck={false}
            />
            <button type="button" onClick={() => void chooseScript()}>
              选择
            </button>
          </span>
        </label>
        <div className="field">
          <span>解释器</span>
          <div className="segment">
            <button type="button" aria-pressed={mode === 'system'} data-testid="mode-system" onClick={() => setMode('system')}>
              系统 Python
            </button>
            <button type="button" aria-pressed={mode === 'venv'} data-testid="mode-venv" onClick={() => setMode('venv')}>
              虚拟环境
            </button>
          </div>
        </div>
        {mode === 'venv' ? (
          <label>
            虚拟环境
            <span className="path-row">
              <input
                data-testid="field-venv"
                value={venvPath}
                onChange={(event) => setVenvPath(event.target.value)}
                placeholder="/path/to/project/.venv"
                spellCheck={false}
              />
              <button type="button" onClick={() => void chooseVenv()}>
                选择
              </button>
            </span>
          </label>
        ) : null}
        <label>
          参数
          <input
            data-testid="field-args"
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder='--epochs 10 或 --name "hello world"'
            spellCheck={false}
          />
        </label>
        </>
        ) : null}
        <div className="field">
          <span>将要执行</span>
          <div className="preview" data-testid="command-preview">
            {preview.text || ' '}
          </div>
        </div>
        </div>
        <div className="sheet-foot">
        <div className="form-error" data-testid="form-error">
          {error || preview.error || ''}
        </div>
        <div className="form-actions">
          {initial ? (
            <button type="button" className="danger-text" onClick={() => void onDelete()}>
              删除
            </button>
          ) : null}
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" data-testid="save-script" disabled={saving}>
            保存
          </button>
        </div>
        </div>
      </form>
    </div>
  )
}

function stem(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1)
  return base.replace(/\.py$/i, '')
}
