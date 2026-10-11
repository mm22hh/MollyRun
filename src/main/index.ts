import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, type MessageBoxOptions, type OpenDialogOptions } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import os from 'os'
import type { StageLayout } from '../shared/api'
import { activeLocale, joinPhrases, resolveLocale, setActiveLocale, t, type LanguagePreference } from '../shared/i18n'
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
      additionalArguments: [
        `--scriptboard-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`,
        `--scriptboard-locale=${activeLocale()}`
      ]
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
        buttons: [t('dialog.quitStop'), t('dialog.cancel')],
        defaultId: 0,
        cancelId: 1,
        message: running.length === 1 ? t('dialog.quitRunningOne') : t('dialog.quitRunningMany', { count: running.length }),
        detail: t('dialog.quitDetail')
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
      if (input.id && !library.get(id)) return { ok: false, error: t('error.notFound') }
      const script = prepareScript(input, id)
      library.upsert(script)
      return { ok: true, script, scripts: library.list() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : t('error.save') }
    }
  })

  ipcMain.handle('scripts:remove', async (_event, id: string) => {
    const script = library.get(id)
    if (!script) return { ok: false, error: t('error.notFound') }
    const running = sessions.isRunning(id)
    const { response } = await ask({
      type: 'warning',
      buttons: [t('dialog.delete'), t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('dialog.deleteAsk', { name: script.name }),
      detail: joinPhrases([
        running ? t('dialog.deleteRunning') : '',
        t('dialog.deleteHistory'),
        script.kind === 'python' ? t('dialog.deleteKept') : ''
      ])
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
      return { ok: false, error: error instanceof Error ? error.message : t('error.start') }
    }
  })

  ipcMain.handle('scripts:stop', async (_event, id: string) => {
    if (typeof id !== 'string') return { ok: false, error: t('error.notFound') }
    const script = library.get(id)
    if (!script) return { ok: false, error: t('error.notFound') }
    if (!sessions.isRunning(id)) return { ok: true }
    const { response } = await ask({
      type: 'question',
      buttons: [t('dialog.stop'), t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('dialog.stopAsk', { name: script.name }),
      detail: t('dialog.stopDetail')
    })
    if (response !== 0) return { ok: false, cancelled: true }
    await sessions.stop(id)
    return { ok: true }
  })

  ipcMain.handle('scripts:reorder', (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { ok: false, error: t('error.reorder') }
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
      return { error: error instanceof Error ? error.message : t('error.interpreter') }
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
      title: t('dialog.pickPython'),
      defaultPath: existingPath(defaultPath),
      filters: [{ name: 'Python', extensions: ['py'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('scripts:read-source', (_event, id: string) => {
    const script = sourceScript(id)
    if (!script) return { ok: false, error: t('error.noSource') }
    return readSource(script.scriptPath)
  })

  ipcMain.handle('scripts:write-source', (_event, id: string, text: string) => {
    const script = sourceScript(id)
    if (!script) return { ok: false, error: t('error.noSource') }
    if (typeof text !== 'string') return { ok: false, error: t('error.save') }
    return writeSource(script.scriptPath, text)
  })

  ipcMain.handle('dialog:pick-dir', async (_event, defaultPath?: string) => {
    const result = await pick({
      title: t('dialog.pickFolder'),
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
    if (!stat.isFile()) return { ok: false, error: t('error.notPython') }
    if (stat.size > MAX_SOURCE_BYTES) return { ok: false, error: t('error.tooLarge') }
    return { ok: true, text: fs.readFileSync(file, 'utf8') }
  } catch {
    return { ok: false, error: t('error.readPython') }
  }
}

function writeSource(file: string, text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) return { ok: false, error: t('error.tooLarge') }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, error: t('error.notPython') }
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, text }
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // The temporary file may already be gone.
    }
    return { ok: false, error: t('error.writePython') }
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

type LanguagePreferenceFile = { language?: string }

function languageFile(): string {
  return path.join(app.getPath('userData'), 'language.json')
}

function readLanguage(): LanguagePreference {
  try {
    const parsed = JSON.parse(fs.readFileSync(languageFile(), 'utf8')) as LanguagePreferenceFile
    if (parsed.language === 'zh-CN' || parsed.language === 'en' || parsed.language === 'system') return parsed.language
  } catch {
    // 没有记录时跟随系统。
  }
  return 'system'
}

function systemLocaleTag(): string {
  try {
    const preferred = app.getPreferredSystemLanguages()
    if (preferred.length > 0) return preferred[0]
  } catch {
    // 读不到语言列表时用应用区域。
  }
  return app.getLocale()
}

let languagePreference: LanguagePreference = 'system'

function notifyLocale(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('locale:changed', activeLocale())
}

function setLanguage(preference: LanguagePreference): void {
  if (preference === languagePreference) return
  languagePreference = preference
  setActiveLocale(resolveLocale(preference, systemLocaleTag()))
  try {
    fs.writeFileSync(languageFile(), JSON.stringify({ language: preference }))
  } catch {
    // 这次选择仍然生效，只是下次打开会回到系统语言。
  }
  notifyLocale()
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

function languageItem(label: string, preference: LanguagePreference): Electron.MenuItemConstructorOptions {
  return {
    label,
    type: 'radio',
    checked: languagePreference === preference,
    click: () => setLanguage(preference)
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
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.appearance'),
          submenu: [appearanceItem(t('menu.light'), 'light'), appearanceItem(t('menu.dark'), 'dark'), appearanceItem(t('menu.system'), 'system')]
        },
        {
          label: t('menu.layout'),
          submenu: [layoutItem(t('menu.tabs'), 'tabs'), layoutItem(t('menu.tile3'), 'tile3'), layoutItem(t('menu.tile2'), 'tile2')]
        },
        {
          label: t('menu.language'),
          submenu: [languageItem(t('menu.zh'), 'zh-CN'), languageItem(t('menu.en'), 'en'), languageItem(t('menu.system'), 'system')]
        }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
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
    languagePreference = readLanguage()
    setActiveLocale(resolveLocale(languagePreference, systemLocaleTag()))
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
    dialog.showErrorBox('MollyRun', error instanceof Error ? error.message : t('error.open'))
    quitting = true
    app.quit()
  })
}
