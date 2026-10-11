import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ScriptboardApi } from '../shared/api'

function applyAppearance(dark: boolean): void {
  const root = document.documentElement
  if (!root) return
  root.dataset.theme = dark ? 'dark' : 'light'
}

function themeArg(): boolean {
  return process.argv.includes('--scriptboard-theme=dark')
}

function localeArg(): 'zh-CN' | 'en' {
  const arg = process.argv.find((item) => item.startsWith('--scriptboard-locale='))
  return arg?.endsWith('=en') ? 'en' : 'zh-CN'
}

function applyLocale(locale: 'zh-CN' | 'en'): void {
  const root = document.documentElement
  if (!root) return
  root.lang = locale
  root.dataset.locale = locale
}

applyAppearance(themeArg())
applyLocale(localeArg())
window.addEventListener('DOMContentLoaded', () => {
  applyAppearance(themeArg())
  applyLocale(localeArg())
})
ipcRenderer.on('appearance:changed', (_event, dark: boolean) => {
  applyAppearance(dark === true)
})

const api: ScriptboardApi = {
  list: () => ipcRenderer.invoke('scripts:list'),
  save: (input) => ipcRenderer.invoke('scripts:save', input),
  remove: (id) => ipcRenderer.invoke('scripts:remove', id),
  start: (id) => ipcRenderer.invoke('scripts:start', id),
  stop: (id) => ipcRenderer.invoke('scripts:stop', id),
  reorder: (ids) => ipcRenderer.invoke('scripts:reorder', ids),
  snapshot: (id) => ipcRenderer.invoke('terminal:snapshot', id),
  clear: (id) => ipcRenderer.invoke('terminal:clear', id),
  resolvePython: (venvPath) => ipcRenderer.invoke('interpreter:resolve', venvPath),
  write: (id, data) => ipcRenderer.send('terminal:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  pickScript: (defaultPath) => ipcRenderer.invoke('dialog:pick-script', defaultPath),
  pickDir: (defaultPath) => ipcRenderer.invoke('dialog:pick-dir', defaultPath),
  readSource: (id) => ipcRenderer.invoke('scripts:read-source', id),
  writeSource: (id, text) => ipcRenderer.invoke('scripts:write-source', id, text),
  onStatus: (callback) => subscribe('scripts:status', callback),
  onData: (callback) => subscribe('terminal:data', callback),
  onLayout: (callback) => subscribe('layout:set', callback),
  onLocale: (callback) => subscribe('locale:changed', callback),
  reportLayout: (layout) => ipcRenderer.send('layout:report', layout)
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('scriptboard', api)
