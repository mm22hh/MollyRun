import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(import.meta.dirname, '..')
const dataDir = mkdtempSync(path.join(tmpdir(), 'scriptboard-'))
const workDir = mkdtempSync(path.join(tmpdir(), 'scriptboard-work-'))
const shots = mkdtempSync(path.join(tmpdir(), 'scriptboard-shots-'))
const fakeVenv = path.join(workDir, 'inherited-venv')
const realVenv = path.join(workDir, '.venv')
const scriptPath = path.join(workDir, 'train.py')

spawnSync('mkdir', ['-p', path.join(fakeVenv, 'bin')], { stdio: 'inherit' })
const venv = spawnSync('python3', ['-m', 'venv', realVenv], { stdio: 'inherit' })
if (venv.status !== 0) {
  console.error('无法创建测试用的虚拟环境')
  process.exit(venv.status ?? 1)
}

writeFileSync(path.join(dataDir, 'language.json'), JSON.stringify({ language: 'zh-CN' }))

writeFileSync(
  scriptPath,
  `import os, sys, time
print("READY", flush=True)
print("EXE", sys.executable, flush=True)
print("VENV", os.environ.get("VIRTUAL_ENV", ""), flush=True)
print("ARGV", sys.argv[1:], flush=True)
print("CWD", os.getcwd(), flush=True)
if "--exit" in sys.argv:
    raise SystemExit(0)
i = 0
while True:
    time.sleep(0.15)
    i += 1
    print(f"TICK {i}", flush=True)
`
)

async function snapshot(page, id) {
  return page.evaluate(async (scriptId) => (await window.scriptboard.snapshot(scriptId)).text, id)
}

function lastTick(text) {
  const matches = [...text.matchAll(/TICK (\d+)/g)]
  return matches.length ? Number(matches[matches.length - 1][1]) : 0
}

async function waitForTick(page, id, tick, timeout = 8000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeout) {
    last = await snapshot(page, id)
    if (lastTick(last) >= tick) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`超时，终端内容：\n${last}`)
}

async function waitForText(page, id, parts, timeout = 8000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeout) {
    last = await snapshot(page, id)
    if (parts.every((part) => last.includes(part))) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`超时，终端内容：\n${last}`)
}

const app = await electron.launch({
  executablePath: electronPath,
  cwd: root,
  args: [path.join(root, 'out/main/index.js')],
  env: {
    ...process.env,
    SCRIPTBOARD_DATA_DIR: dataDir,
    SCRIPTBOARD_CONFIRM: 'accept',
    VIRTUAL_ENV: fakeVenv,
    PATH: `${path.join(fakeVenv, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
  }
})

const page = await app.firstWindow()
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.error(`fail  ${name}${detail ? `: ${detail}` : ''}`)
}

try {
  await page.getByTestId('add-script').waitFor()
  await page.screenshot({ path: path.join(shots, '01-empty.png') })

  await page.getByTestId('add-script').click()
  await page.getByTestId('save-script').click()
  await page.waitForFunction(() => (document.querySelector('[data-testid="form-error"]')?.textContent ?? '').includes('请填写名称'))
  const nameError = await page.getByTestId('form-error').innerText()
  check('空表单提示名称', nameError.includes('请填写名称'), nameError)

  await page.getByTestId('field-name').fill('训练')
  await page.waitForFunction(() => (document.querySelector('[data-testid="form-error"]')?.textContent ?? '').trim() === '')
  await page.getByTestId('field-script').fill(scriptPath)
  await page.getByTestId('field-args').fill('--name "hello world"')
  await page.waitForFunction((file) => {
    const text = document.querySelector('[data-testid="command-preview"]')?.textContent ?? ''
    return text.includes(file) && text.includes('hello world')
  }, scriptPath)
  const preview = await page.getByTestId('command-preview').innerText()
  check('命令预览包含脚本和参数', preview.includes(scriptPath) && preview.includes('hello world'), preview)
  check('系统 Python 不受当前终端虚拟环境干扰', !preview.includes(fakeVenv), preview)
  await page.screenshot({ path: path.join(shots, '02-form.png') })
  await page.getByTestId('save-script').click()
  await page.getByRole('heading', { name: '添加脚本' }).waitFor({ state: 'detached' })

  const listed = await page.evaluate(() => window.scriptboard.list())
  const id = listed.scripts[0].id
  check('列表里没有编辑按钮', (await page.getByTestId(`edit-${id}`).count()) === 0)
  check('窗口右上角没有编辑按钮', (await page.getByTestId('edit-script').count()) === 0)
  check('没有终端和代码切换', (await page.getByTestId('show-terminal').count()) === 0 && (await page.getByTestId('edit-code').count()) === 0)
  const lineClamp = await page.locator(`[data-testid="meta-${id}"] .row-file`).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-line-clamp'))
  check('文件名或命令最多显示两行', lineClamp === '2', lineClamp)
  await page.getByTestId(`start-${id}`).click()
  const runningSnap = await waitForText(page, id, ['READY', 'hello world', 'TICK 1', `CWD ${realpathSync(workDir)}`])
  check('脚本在自己的文件夹里启动', runningSnap.includes(`CWD ${realpathSync(workDir)}`), runningSnap)
  check('系统 Python 没有继承 VIRTUAL_ENV', /VENV \r?\n/.test(runningSnap) || runningSnap.includes('VENV \n') || runningSnap.includes('VENV \r'), runningSnap)
  const venvLine = runningSnap.split('\n').find((line) => line.startsWith('VENV'))
  check('VIRTUAL_ENV 为空', venvLine?.trim() === 'VENV', venvLine ?? runningSnap)
  const runLine = await page.getByTestId('run-line').innerText()
  check('标签下方显示实际执行内容', runLine.includes(scriptPath) && runLine.includes('hello world'), runLine)
  await page.screenshot({ path: path.join(shots, '03-running.png') })

  const beforeTick = lastTick(runningSnap)
  await page.getByTestId(`tab-close-${id}`).click()
  await page.getByTestId('empty-stage').waitFor()
  const hiddenSnap = await waitForTick(page, id, beforeTick + 1)
  check('关掉标签后输出仍在增加', lastTick(hiddenSnap) > beforeTick, hiddenSnap)
  const metaWhileHidden = await page.getByTestId(`meta-${id}`).innerText()
  check('关掉标签后列表仍显示在运行', /\d+:\d+/.test(metaWhileHidden), metaWhileHidden)

  await page.getByTestId(`row-${id}`).locator('.row-main').click()
  await page.getByTestId(`tab-${id}`).waitFor()
  await page.getByTestId(`stop-${id}`).click()
  await waitForText(page, id, ['已停止'])
  await page.waitForFunction((scriptId) => (document.querySelector(`[data-testid="meta-${scriptId}"]`)?.textContent ?? '').includes('已停止'), id)
  const stoppedMeta = await page.getByTestId(`meta-${id}`).innerText()
  check('停止后列表显示已停止', stoppedMeta.includes('已停止'), stoppedMeta)

  await page.getByTestId(`row-${id}`).click({ button: 'right' })
  await page.getByTestId('menu-edit').click()
  await page.getByRole('heading', { name: '编辑脚本' }).waitFor()
  const editedName = await page.getByTestId('field-name').inputValue()
  check('列表里的编辑打开已登记的脚本', editedName === '训练', editedName)
  await page.getByTestId('field-args').fill('--name "second run" --exit')
  await page.getByTestId('save-script').click()
  await page.getByTestId(`start-${id}`).click()
  const restarted = await waitForText(page, id, ['重新启动', 'second run', '已退出'])
  check('再次启动保留上一次输出', restarted.includes('hello world'), restarted)
  const exitMeta = await page.getByTestId(`meta-${id}`).innerText()
  check('自行退出显示退出码', exitMeta.includes('退出 0'), exitMeta)
  await page.screenshot({ path: path.join(shots, '04-exited.png') })

  await page.getByTestId('add-script').click()
  await page.getByTestId('field-name').fill('环境里的训练')
  await page.getByTestId('field-script').fill(scriptPath)
  await page.getByTestId('mode-venv').click()
  await page.getByTestId('field-venv').fill(path.join(realVenv, 'bin', 'python'))
  await page.getByTestId('field-args').fill('--exit')
  await page.waitForFunction((venvPath) => {
    const text = document.querySelector('[data-testid="command-preview"]')?.textContent ?? ''
    return text.includes(venvPath)
  }, realVenv)
  await page.getByTestId('save-script').click()
  await page.getByRole('heading', { name: '添加脚本' }).waitFor({ state: 'detached' })
  const afterVenv = await page.evaluate(() => window.scriptboard.list())
  const venvId = afterVenv.scripts.find((script) => script.name === '环境里的训练').id
  await page.getByTestId(`start-${venvId}`).click()
  const venvSnap = await waitForText(page, venvId, ['READY', '已退出', realpathSync(realVenv)])
  check('虚拟环境的 Python 被用来启动', venvSnap.includes(realVenv), venvSnap)
  const venvEnv = venvSnap.split('\n').find((line) => line.startsWith('VENV'))
  check('VIRTUAL_ENV 指向所选环境', venvEnv?.includes(realVenv) === true, venvEnv ?? venvSnap)
  await page.screenshot({ path: path.join(shots, '05-venv.png') })

  await page.getByTestId('add-script').click()
  await page.getByTestId('kind-command').click()
  check('命令模式不显示 Python 文件', (await page.getByTestId('field-script').count()) === 0)
  await page.getByTestId('field-name').fill('一条命令')
  await page.getByTestId('field-command').fill('if true; then\n  printf "CMD hello\\n"\nfi')
  await page.waitForFunction(() => (document.querySelector('[data-testid="command-preview"]')?.textContent ?? '').includes('printf'))
  const commandPreview = await page.getByTestId('command-preview').innerText()
  check('命令预览就是输入的命令', commandPreview.includes('printf "CMD hello'), commandPreview)
  check('命令预览保留换行', commandPreview.includes('if true; then\n'), commandPreview)
  await page.screenshot({ path: path.join(shots, '07-command.png') })
  await page.getByTestId('save-script').click()
  await page.getByRole('heading', { name: '添加脚本' }).waitFor({ state: 'detached' })
  const afterCommand = await page.evaluate(() => window.scriptboard.list())
  const commandScript = afterCommand.scripts.find((script) => script.name === '一条命令')
  const commandId = commandScript.id
  check('保存时保留换行', commandScript.command === 'if true; then\n  printf "CMD hello\\n"\nfi', JSON.stringify(commandScript.command))
  await page.getByTestId(`start-${commandId}`).click()
  const commandSnap = await waitForText(page, commandId, ['$ if true; then', 'printf', 'CMD hello', '已退出'])
  const commandRun = await page.getByTestId('run-line').innerText()
  const commandWrap = await page.getByTestId('run-line').evaluate((el) => getComputedStyle(el).whiteSpace)
  check('标签下方仍是一行摘要', commandWrap === 'nowrap' && commandRun.includes('if true'), `${commandWrap}\n${commandRun}`)
  check('命令直接在终端里执行', commandSnap.includes('CMD hello'), commandSnap)
  check('多行命令按换行交给 shell', commandSnap.includes('CMD hello') && !commandSnap.includes('parse error'), commandSnap)
  check('多行命令原文写在终端里', commandSnap.includes('$ if true; then') && commandSnap.includes('printf'), commandSnap)
  const commandMeta = await page.getByTestId(`meta-${commandId}`).innerText()
  check('命令自行退出显示退出码', commandMeta.includes('退出 0'), commandMeta)

  const sidebarBox = await page.locator('.sidebar').boundingBox()
  const stageBox = await page.locator('.stage').boundingBox()
  const nameBox = await page.getByTestId('app-name').boundingBox()
  const filterSeg = await page.locator('.list-filter').boundingBox()
  const rowBox = await page.locator('.row').first().boundingBox()
  const filterSize = await page.getByTestId('filter-all').evaluate((el) => getComputedStyle(el).fontSize)
  const addSize = await page.getByTestId('add-script').evaluate((el) => getComputedStyle(el).fontSize)
  check(
    '左侧整块到顶',
    !!sidebarBox && !!nameBox && sidebarBox.y < 4 && nameBox.x >= sidebarBox.x + 60 && nameBox.y < 40 && nameBox.x + nameBox.width < sidebarBox.x + sidebarBox.width,
    `${nameBox?.x},${nameBox?.y}`
  )
  check(
    '右侧是完整展示区',
    !!stageBox && !!sidebarBox && stageBox.y < 4 && stageBox.x >= sidebarBox.x + sidebarBox.width - 2 && stageBox.height > sidebarBox.height - 4,
    `${stageBox?.x},${stageBox?.y},${stageBox?.height}`
  )
  check(
    '筛选与列表同宽并在名称下方',
    !!filterSeg && !!rowBox && !!nameBox && Math.abs(filterSeg.width - rowBox.width) < 8 && filterSeg.y > nameBox.y + nameBox.height,
    `filter ${filterSeg?.width} row ${rowBox?.width}`
  )
  check('页面上没有排列按钮', (await page.getByTestId('layout-tabs').count()) === 0)
  const displayItems = await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    return view?.submenu?.items.map((item) => item.label) ?? []
  })
  check('显示菜单收成外观、排列和语言', displayItems.join(',') === '外观,排列,语言', displayItems.join(','))
  const menuLabels = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [])
  const chooseLanguage = (label) => app.evaluate(({ Menu }, languageLabel) => {
    for (const menu of Menu.getApplicationMenu()?.items ?? []) {
      for (const item of menu.submenu?.items ?? []) {
        const choice = item.submenu?.items.find((child) => child.label === languageLabel)
        if (choice) {
          choice.click()
          return true
        }
      }
    }
    return false
  }, label)
  const waitForMenu = async (label) => {
    const start = Date.now()
    let labels = []
    while (Date.now() - start < 3000) {
      labels = await menuLabels()
      if (labels.includes(label)) return labels
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return labels
  }
  check('点了英文', await chooseLanguage('English'))
  await page.waitForFunction(() => document.documentElement.dataset.locale === 'en')
  const englishView = await waitForMenu('View')
  check('菜单可以切到英文', (await page.getByTestId('filter-all').innerText()) === 'All' && englishView.includes('View'), `${englishView.join(',')}`)
  await page.getByTestId('add-script').click()
  await page.getByRole('heading', { name: 'Add script' }).waitFor()
  const venvLines = await page.getByTestId('mode-venv').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getClientRects().length
  })
  check('英文表单里虚拟环境保持一行', venvLines === 1, String(venvLines))
  await page.screenshot({ path: path.join(shots, '08-english-form.png') })
  await page.getByTestId('close-form').click()
  await page.getByRole('heading', { name: 'Add script' }).waitFor({ state: 'detached' })
  check('点了简体中文', await chooseLanguage('简体中文'))
  await page.waitForFunction(() => document.documentElement.dataset.locale === 'zh-CN')
  const chineseView = await waitForMenu('显示')
  check('菜单可以切回简体中文', (await page.getByTestId('filter-all').innerText()) === '全部' && chineseView.includes('显示'), chineseView.join(','))
  check('筛选字号保持较小', filterSize === '12px', filterSize)
  check('添加脚本字号与切换一致', addSize === '12px', addSize)
  const runningLines = await page.getByTestId('filter-running').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getClientRects().length
  })
  check('运行中保持一行', runningLines === 1, String(runningLines))
  check('顶栏显示应用名', (await page.getByTestId('app-name').innerText()) === 'Scriptboard')
  const theme = await app.evaluate(({ Menu, nativeTheme }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const appearance = view?.submenu?.items.find((item) => item.label === '外观')
    const dark = appearance?.submenu?.items.find((item) => item.label === '深色')
    if (!dark) return { after: 'missing', dark: nativeTheme.shouldUseDarkColors }
    dark.click()
    return { after: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  check('菜单可以切到深色', theme.after === 'dark' && bg === '#141311', JSON.stringify({ theme, bg }))
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const appearance = view?.submenu?.items.find((item) => item.label === '外观')
    appearance?.submenu?.items.find((item) => item.label === '浅色')?.click()
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  const light = await page.evaluate(() => {
    const term = getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
    const tab = document.querySelector('.tab.active')
    const viewport = document.querySelector('.xterm-viewport')
    return {
      term,
      tab: tab ? getComputedStyle(tab).backgroundColor : '',
      viewport: viewport ? getComputedStyle(viewport).backgroundColor : ''
    }
  })
  check(
    '浅色下标签和终端是浅色',
    light.term === '#fbf9f4' && light.tab === 'rgb(251, 249, 244)' && light.viewport === 'rgb(251, 249, 244)',
    JSON.stringify(light)
  )
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const appearance = view?.submenu?.items.find((item) => item.label === '外观')
    appearance?.submenu?.items.find((item) => item.label === '跟随系统')?.click()
  })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark')
  await page.getByTestId('filter-running').click()
  await page.getByTestId('running-empty').waitFor()
  check('运行中没有脚本时列表为空', (await page.getByTestId(`row-${id}`).count()) === 0)
  check('运行中也会藏起右侧已停止的终端', (await page.getByTestId(`tab-${id}`).count()) === 0)
  await page.getByTestId('empty-stage').waitFor()
  await page.getByTestId('filter-all').click()
  await page.getByTestId(`row-${id}`).waitFor()
  check('列表没有拖动条', (await page.locator('.row-handle').count()) === 0)
  const handleBox = await page.getByTestId(`row-${commandId}`).boundingBox()
  const firstBox = await page.getByTestId(`row-${id}`).boundingBox()
  if (!handleBox || !firstBox) throw new Error('找不到拖动位置')
  await page.mouse.move(handleBox.x + 36, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 8, { steps: 12 })
  await page.waitForFunction((expected) => document.querySelector('.script-list [data-testid^="row-"]')?.getAttribute('data-testid') === `row-${expected}`, commandId)
  check('拖动过程中顺序立刻变化', true)
  await page.mouse.up()
  const reordered = await page.evaluate(() => window.scriptboard.list())
  check('拖动后顺序已保存', reordered.scripts[0].id === commandId, reordered.scripts.map((script) => script.name).join(', '))

  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const arrange = view?.submenu?.items.find((item) => item.label === '排列')
    arrange?.submenu?.items.find((item) => item.label === '平铺 3 个/行')?.click()
  })
  await page.getByTestId('tile-grid').waitFor()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="tile-grid"]')).gridTemplateColumns.split(' ').length === 3)
  const tileScript = await page.getByTestId(`run-${id}`).innerText()
  const tileCommand = await page.getByTestId(`run-${commandId}`).innerText()
  check('平铺也显示实际执行内容', tileScript.includes(scriptPath) && tileCommand.includes('printf'), `${tileScript} | ${tileCommand}`)
  await page.getByTestId(`tile-${id}`).waitFor()
  await page.getByTestId(`tile-${commandId}`).waitFor()
  const tileCount = await page.locator('.tile').count()
  check('平铺同时显示已打开的终端', tileCount >= 2, String(tileCount))
  check('平铺时不显示标签条', (await page.getByTestId(`tab-${id}`).count()) === 0)
  const columns3 = await page.getByTestId('tile-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
  check('平铺可以一行三个', columns3 === 3, String(columns3))
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const arrange = view?.submenu?.items.find((item) => item.label === '排列')
    arrange?.submenu?.items.find((item) => item.label === '平铺 2 个/行')?.click()
  })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="tile-grid"]')).gridTemplateColumns.split(' ').length === 2)
  const columns2 = await page.getByTestId('tile-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
  check('平铺可以一行两个', columns2 === 2, String(columns2))
  const tileFloor = await page.getByTestId('tile-grid').evaluate((el) => {
    const tile = el.querySelector('.tile')
    return {
      overflowY: getComputedStyle(el).overflowY,
      minHeight: tile ? getComputedStyle(tile).minHeight : ''
    }
  })
  check('平铺可以上下滚动', tileFloor.overflowY === 'auto', tileFloor.overflowY)
  check('平铺格子有最小高度', tileFloor.minHeight === '280px', tileFloor.minHeight)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1120, 420)
  })
  await page.waitForFunction(() => {
    const grid = document.querySelector('[data-testid="tile-grid"]')
    const tile = grid?.querySelector('.tile')
    if (!grid || !tile) return false
    return grid.scrollHeight > grid.clientHeight + 8 && tile.getBoundingClientRect().height >= 280
  })
  const scrolled = await page.getByTestId('tile-grid').evaluate((el) => {
    const heights = [...el.querySelectorAll('.tile')].map((tile) => tile.getBoundingClientRect().height)
    return { scrolls: el.scrollHeight > el.clientHeight, heights }
  })
  check('平铺超出一屏后格子保持最小高度', scrolled.scrolls && scrolled.heights.every((height) => height >= 280), JSON.stringify(scrolled))
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1120, 740)
  })
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '显示')
    const arrange = view?.submenu?.items.find((item) => item.label === '排列')
    arrange?.submenu?.items.find((item) => item.label === '标签')?.click()
  })
  await page.getByTestId(`tab-${id}`).waitFor()
  check('切回标签后平铺消失', (await page.locator('.tile').count()) === 0)

  await page.getByTestId(`row-${id}`).click({ button: 'right' })
  await page.getByTestId('row-menu').waitFor()
  const menuText = await page.getByTestId('row-menu').innerText()
  check('右键菜单可以编辑和删除', menuText.includes('编辑') && menuText.includes('删除'), menuText)
  await page.getByTestId('menu-edit').click()
  await page.getByRole('heading', { name: '编辑脚本' }).waitFor()
  const menuName = await page.getByTestId('field-name').inputValue()
  check('右键编辑打开对应脚本', menuName === '训练', menuName)
  check('编辑窗口有关闭按钮', (await page.getByTestId('close-form').count()) === 1)
  const sheetLayout = await page.locator('.sheet').evaluate((el) => {
    const head = el.querySelector('.sheet-head')
    const body = el.querySelector('.sheet-body')
    const foot = el.querySelector('.sheet-foot')
    return {
      overflow: getComputedStyle(el).overflow,
      head: head ? getComputedStyle(head).flexGrow : '',
      body: body ? getComputedStyle(body).overflowY : '',
      foot: Boolean(foot)
    }
  })
  check(
    '标题和按钮固定，中间可以滚动',
    sheetLayout.overflow === 'hidden' && sheetLayout.head === '0' && sheetLayout.body === 'auto' && sheetLayout.foot,
    JSON.stringify(sheetLayout)
  )
  await page.getByTestId('close-form').click()
  await page.getByRole('heading', { name: '编辑脚本' }).waitFor({ state: 'detached' })
  await page.getByTestId(`tab-${id}`).click()
  await page.getByTestId(`terminal-${id}`).click({ button: 'right' })
  await page.getByTestId('terminal-menu').waitFor()
  const terminalMenu = await page.getByTestId('terminal-menu').innerText()
  check('终端右键可以清空历史', terminalMenu.includes('清空历史记录'), terminalMenu)
  await page.getByTestId('menu-clear').click()
  await page.waitForFunction(async (scriptId) => (await window.scriptboard.snapshot(scriptId)).text === '', id)
  const cleared = await page.evaluate((scriptId) => window.scriptboard.snapshot(scriptId), id)
  check('清空后历史记录被去掉', cleared.text === '', JSON.stringify(cleared))
  await page.getByTestId(`row-${commandId}`).click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await page.getByTestId(`row-${commandId}`).waitFor({ state: 'detached' })
  const afterDelete = await page.evaluate(() => window.scriptboard.list())
  check('右键删除会去掉脚本', afterDelete.scripts.every((script) => script.id !== commandId), afterDelete.scripts.map((script) => script.name).join(', '))
  check('删除后标签关掉', (await page.getByTestId(`tab-${commandId}`).count()) === 0)
  const removedSnap = await page.evaluate((scriptId) => window.scriptboard.snapshot(scriptId), commandId)
  check('删除脚本后历史记录也去掉', removedSnap.text === '' && removedSnap.seq === 0, JSON.stringify(removedSnap))

  const sidebar = page.locator('.sidebar')
  const beforeWidth = (await sidebar.boundingBox())?.width ?? 0
  const resizer = await page.getByTestId('sidebar-resizer').boundingBox()
  if (!resizer) throw new Error('找不到列表边缘')
  const resizeY = resizer.y + Math.min(180, resizer.height / 2)
  await page.mouse.move(resizer.x + resizer.width / 2, resizeY)
  await page.mouse.down()
  await page.mouse.move(resizer.x + 120, resizeY, { steps: 8 })
  await page.mouse.up()
  const wider = (await sidebar.boundingBox())?.width ?? 0
  check('列表可以拖宽', wider > beforeWidth + 60, `${beforeWidth} -> ${wider}`)
  const edge = await page.getByTestId('sidebar-resizer').boundingBox()
  if (!edge) throw new Error('找不到列表边缘')
  await page.mouse.move(edge.x + edge.width / 2, resizeY)
  await page.mouse.down()
  await page.mouse.move(8, resizeY, { steps: 10 })
  await page.mouse.up()
  const narrow = (await sidebar.boundingBox())?.width ?? 0
  check('列表不会窄过最小宽度', narrow >= 239 && narrow < 250, String(narrow))

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await page.screenshot({ path: path.join(shots, '06-dark.png') })
} finally {
  console.log(`screenshots ${shots}`)
  await page.evaluate(async () => {
    const data = await window.scriptboard.list()
    await Promise.all(data.statuses.filter((status) => status.state === 'running').map((status) => window.scriptboard.stop(status.id)))
  }).catch(() => {})
  await app.close()
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
