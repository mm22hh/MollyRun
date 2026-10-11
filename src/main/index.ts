import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, type MessageBoxOptions, type OpenDialogOptions } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import os from 'os'
import type { StageLayout } from '../shared/api'
import { expandHome, normalizeVenvPath, type ScriptInput, type ScriptStatus } from '../shared/model'
import { Library } from './library'
import { prepareScript, resolveInterpreter } from './python'
import { Sessions } from './sessions'

app.setName('MollyRun')
if (process.env.SCRIPTBOARD_DATA_DIR) {
  app.setPath('userData', process.env.SCRIPTBOARD_DATA_DIR)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow: BrowserWindow | null = null
let quitting = false
let confirmingQuit = false
let library: Library
let sessions: Sessions

const sendStatus = (status: ScriptStatus) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('scripts:status', status)
}

const sendData = (chunk: { id: string; seq: number; data: string }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('terminal:data', chunk)
}

function appIcon() {
  const iconFile = path.join(__dirname, '../../build/icon.png')
  if (!fs.existsSync(iconFile)) return undefined
  const image = nativeImage.createFromPath(iconFile)
  return image.isEmpty() ? undefined : image
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 560,
    title: 'MollyRun',
    icon: appIcon(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141311' : '#ebe6dc',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--scriptboard-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`]
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void requestQuit()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

async function requestQuit(): Promise<void> {
  if (quitting || confirmingQuit) return
  confirmingQuit = true
  try {
    const running = sessions.runningIds()
    if (running.length > 0) {
      const { response } = await ask({
        type: 'question',
        buttons: ['停掉并退出', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: `还有 ${running.length} 个脚本在运行`,
        detail: '退出会停止它们。'
      })
      if (response !== 0) return
      await sessions.stopAll()
    }
    quitting = true
    app.quit()
  } finally {
    if (!quitting) confirmingQuit = false
  }
}

function registerIpc(): void {
  ipcMain.on('layout:report', (_event, layout: unknown) => {
    if (!isStageLayout(layout)) return
    if (layout === stageLayout) return
    stageLayout = layout
    setTimeout(installMenu, 0)
  })

  ipcMain.handle('scripts:list', () => ({
    scripts: library.list(),
    statuses: library.list().map((script) => sessions.status(script.id))
  }))

  ipcMain.handle('scripts:save', (_event, input: ScriptInput) => {
    try {
      const id = input.id?.trim() || randomUUID()
      if (input.id && !library.get(id)) return { ok: false, error: '找不到这个脚本' }
      const script = prepareScript(input, id)
      library.upsert(script)
      return { ok: true, script, scripts: library.list() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法保存' }
    }
  })

  ipcMain.handle('scripts:remove', async (_event, id: string) => {
    const script = library.get(id)
    if (!script) return { ok: false, error: '找不到这个脚本' }
    const running = sessions.isRunning(id)
    const kept = script.kind === 'python' ? '脚本文件还在原来的位置。' : ''
    const runningNote = running ? '它正在运行，删除会先停止它。' : ''
    const { response } = await ask({
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `删除「${script.name}」？`,
      detail: `${runningNote}终端里的历史记录会一起清掉。${kept}`
    })
    if (response !== 0) return { ok: false, cancelled: true }
    if (running) await sessions.stop(id)
    sessions.drop(id)
    library.remove(id)
    return { ok: true, scripts: library.list() }
  })

  ipcMain.handle('scripts:start', (_event, id: string) => {
    try {
      sessions.start(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法启动' }
    }
  })

  ipcMain.handle('scripts:stop', async (_event, id: string) => {
    if (typeof id !== 'string') return { ok: false, error: '找不到这个脚本' }
    const script = library.get(id)
    if (!script) return { ok: false, error: '找不到这个脚本' }
    if (!sessions.isRunning(id)) return { ok: true }
    const { response } = await ask({
      type: 'question',
      buttons: ['停止', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `停止「${script.name}」？`,
      detail: '它会马上停下来。'
    })
    if (response !== 0) return { ok: false, cancelled: true }
    await sessions.stop(id)
    return { ok: true }
  })

  ipcMain.handle('scripts:reorder', (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { ok: false, error: '顺序无法保存' }
    }
    library.reorder(ids)
    return { ok: true, scripts: library.list() }
  })

  ipcMain.handle('terminal:snapshot', (_event, id: string) => sessions.snapshot(id))

  ipcMain.handle('terminal:clear', (_event, id: string) => {
    if (typeof id !== 'string') return { text: '', seq: 0 }
    return sessions.clear(id)
  })

  ipcMain.handle('interpreter:resolve', (_event, venvPath: string | null) => {
    try {
      const trimmed = venvPath?.trim() ?? ''
      const normalized = trimmed ? normalizeVenvPath(expandHome(trimmed, os.homedir())) : null
      return { python: resolveInterpreter(normalized) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '无法确定解释器' }
    }
  })

  ipcMain.on('terminal:write', (_event, id: string, data: string) => {
    if (typeof data === 'string') sessions.write(id, data)
  })

  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
    if (typeof cols === 'number' && typeof rows === 'number') sessions.resize(id, cols, rows)
  })

  ipcMain.handle('dialog:pick-script', async (_event, defaultPath?: string) => {
    const result = await pick({
      title: '选择 Python 文件',
      defaultPath: existingPath(defaultPath),
      filters: [{ name: 'Python', extensions: ['py'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('scripts:read-source', (_event, id: string) => {
    const script = sourceScript(id)
    if (!script) return { ok: false, error: '这个脚本没有可编辑的文件' }
    return readSource(script.scriptPath)
  })

  ipcMain.handle('scripts:write-source', (_event, id: string, text: string) => {
    const script = sourceScript(id)
    if (!script) return { ok: false, error: '这个脚本没有可编辑的文件' }
    if (typeof text !== 'string') return { ok: false, error: '无法保存' }
    return writeSource(script.scriptPath, text)
  })

  ipcMain.handle('dialog:pick-dir', async (_event, defaultPath?: string) => {
    const result = await pick({
      title: '选择文件夹',
      defaultPath: existingPath(defaultPath),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

function ask(options: MessageBoxOptions) {
  if (process.env.SCRIPTBOARD_CONFIRM === 'accept') return Promise.resolve({ response: 0, checkboxChecked: false })
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options)
  return dialog.showMessageBox(options)
}

function pick(options: OpenDialogOptions) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showOpenDialog(mainWindow, options)
  return dialog.showOpenDialog(options)
}

const MAX_SOURCE_BYTES = 1_000_000

function sourceScript(id: string) {
  if (typeof id !== 'string') return null
  const script = library.get(id)
  if (!script || script.kind !== 'python' || !script.scriptPath) return null
  return script
}

function readSource(file: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { ok: false, error: '找不到这个 Python 文件' }
    if (stat.size > MAX_SOURCE_BYTES) return { ok: false, error: '文件太大，请在外部编辑' }
    return { ok: true, text: fs.readFileSync(file, 'utf8') }
  } catch {
    return { ok: false, error: '无法读取这个 Python 文件' }
  }
}

function writeSource(file: string, text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) return { ok: false, error: '文件太大，请在外部编辑' }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, error: '找不到这个 Python 文件' }
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, text }
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // The temporary file may already be gone.
    }
    return { ok: false, error: '无法保存这个 Python 文件' }
  }
}

function existingPath(candidate?: string): string | undefined {
  if (!candidate) return undefined
  try {
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(candidate)
    if (fs.existsSync(parent)) return parent
  } catch {
    return undefined
  }
  return undefined
}

type Appearance = 'system' | 'light' | 'dark'

function appearanceFile(): string {
  return path.join(app.getPath('userData'), 'appearance.json')
}

function readAppearance(): Appearance {
  try {
    const parsed = JSON.parse(fs.readFileSync(appearanceFile(), 'utf8')) as { theme?: string }
    if (parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system') return parsed.theme
  } catch {
    // 没有记录时跟随系统。
  }
  return 'system'
}

function notifyAppearance(): void {
  paintWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('appearance:changed', nativeTheme.shouldUseDarkColors)
}

function setAppearance(theme: Appearance): void {
  nativeTheme.themeSource = theme
  try {
    fs.writeFileSync(appearanceFile(), JSON.stringify({ theme }))
  } catch {
    // 这次选择仍然生效，只是下次打开会回到系统外观。
  }
  notifyAppearance()
  setTimeout(installMenu, 0)
}

function paintWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#141311' : '#ebe6dc')
}

let stageLayout: StageLayout = 'tabs'

function isStageLayout(layout: unknown): layout is StageLayout {
  return layout === 'tabs' || layout === 'tile3' || layout === 'tile2'
}

function appearanceItem(label: string, theme: Appearance): Electron.MenuItemConstructorOptions {
  return {
    label,
    type: 'radio',
    checked: nativeTheme.themeSource === theme,
    click: () => setAppearance(theme)
  }
}

function layoutItem(label: string, layout: StageLayout): Electron.MenuItemConstructorOptions {
  return {
    label,
    type: 'radio',
    checked: stageLayout === layout,
    click: () => {
      if (stageLayout === layout) return
      stageLayout = layout
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('layout:set', layout)
      setTimeout(installMenu, 0)
    }
  }
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'MollyRun',
      submenu: [
        { role: 'about', label: '关于 MollyRun' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 MollyRun' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 MollyRun' }
      ]
    },
    {
      label: '显示',
      submenu: [
        {
          label: '外观',
          submenu: [appearanceItem('浅色', 'light'), appearanceItem('深色', 'dark'), appearanceItem('跟随系统', 'system')]
        },
        {
          label: '排列',
          submenu: [layoutItem('标签', 'tabs'), layoutItem('平铺 3 个/行', 'tile3'), layoutItem('平铺 2 个/行', 'tile2')]
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.setAboutPanelOptions({
    applicationName: 'MollyRun',
    applicationVersion: app.getVersion()
  })
}

if (gotLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    void requestQuit()
  })

  app.whenReady().then(() => {
    library = new Library(path.join(app.getPath('userData'), 'scripts.json'))
    sessions = new Sessions({
      sendStatus,
      sendData,
      getScript: (id) => library.get(id)
    })
    nativeTheme.on('updated', () => {
      notifyAppearance()
      setTimeout(installMenu, 0)
    })
    nativeTheme.themeSource = readAppearance()
    installMenu()
    registerIpc()
    const icon = appIcon()
    if (icon) app.dock?.setIcon(icon)
    createWindow()
  }).catch((error: unknown) => {
    dialog.showErrorBox('MollyRun', error instanceof Error ? error.message : '无法打开')
    quitting = true
    app.quit()
  })
}
