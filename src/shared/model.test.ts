import assert from 'node:assert/strict'
import path from 'path'
import { test } from 'node:test'
import { resolveLocale, translate } from './i18n'
import {
  envForRun,
  expandHome,
  formatCommand,
  normalizeInput,
  normalizeVenvPath,
  parseArgs
} from './model'
import { moveBeside, moveInOrder, placeVisibleOrder } from './order'

test('parseArgs splits words and keeps quoted spaces', () => {
  assert.deepEqual(parseArgs('a b'), ['a', 'b'])
  assert.deepEqual(parseArgs('  a   b  '), ['a', 'b'])
  assert.deepEqual(parseArgs('--name "hello world"'), ['--name', 'hello world'])
  assert.deepEqual(parseArgs("--title 'a b'"), ['--title', 'a b'])
  assert.deepEqual(parseArgs('""'), [''])
  assert.deepEqual(parseArgs(''), [])
})

test('parseArgs rejects an open quote', () => {
  assert.throws(() => parseArgs('--name "hello'), /引号没有闭合/)
})

test('normalizeVenvPath accepts the environment root, bin, or interpreter', () => {
  assert.equal(normalizeVenvPath('/work/app/.venv'), '/work/app/.venv')
  assert.equal(normalizeVenvPath('/work/app/.venv/'), '/work/app/.venv')
  assert.equal(normalizeVenvPath('/work/app/.venv/bin'), '/work/app/.venv')
  assert.equal(normalizeVenvPath('/work/app/.venv/bin/python'), '/work/app/.venv')
  assert.equal(normalizeVenvPath('/work/app/.venv/bin/python3'), '/work/app/.venv')
})

test('expandHome expands a leading tilde', () => {
  assert.equal(expandHome('~/proj/a.py', '/Users/me'), path.join('/Users/me', 'proj/a.py'))
  assert.equal(expandHome('~', '/Users/me'), '/Users/me')
  assert.equal(expandHome('/tmp/a.py', '/Users/me'), '/tmp/a.py')
})

test('formatCommand quotes only values that need it', () => {
  assert.equal(
    formatCommand(['/usr/bin/python3', '/work/train.py', '--name', 'hello world']),
    "/usr/bin/python3 /work/train.py --name 'hello world'"
  )
})

test('envForRun puts the selected venv first and drops an inherited one', () => {
  const env = envForRun(
    {
      PATH: '/old/venv/bin:/usr/bin',
      VIRTUAL_ENV: '/old/venv',
      HOME: '/Users/me'
    },
    '/work/app/.venv',
    '/work/app/.venv/bin'
  )
  assert.equal(env.VIRTUAL_ENV, '/work/app/.venv')
  assert.equal(env.PATH.split(path.delimiter)[0], '/work/app/.venv/bin')
  assert.equal(env.PATH.includes('/old/venv/bin'), false)
  assert.equal(env.PYTHONUNBUFFERED, '1')
  assert.equal(env.HOME, '/Users/me')
})

test('envForRun leaves PATH alone when using system Python', () => {
  const env = envForRun({ PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/me' }, null, null)
  assert.equal(env.VIRTUAL_ENV, undefined)
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin')
})

test('normalizeInput trims fields and clears an empty venv', () => {
  const script = normalizeInput(
    {
      name: ' 训练 ',
      scriptPath: ' ~/proj/train.py ',
      args: ' --epochs 3 ',
      venvPath: ' ~/proj/.venv/bin/python '
    },
    '/Users/me'
  )
  assert.equal(script.kind, 'python')
  assert.equal(script.name, '训练')
  assert.equal(script.scriptPath, path.join('/Users/me', 'proj/train.py'))
  assert.equal(script.args, '--epochs 3')
  assert.equal(script.venvPath, path.join('/Users/me', 'proj/.venv'))
  assert.equal(script.command, '')
})

test('normalizeInput keeps a command and drops python fields', () => {
  const script = normalizeInput(
    {
      kind: 'command',
      name: ' 开发 ',
      scriptPath: '/tmp/train.py',
      args: '--epochs 3',
      venvPath: '/tmp/.venv',
      command: '  npm run dev  '
    },
    '/Users/me'
  )
  assert.equal(script.kind, 'command')
  assert.equal(script.name, '开发')
  assert.equal(script.command, 'npm run dev')
  assert.equal(script.scriptPath, '')
  assert.equal(script.args, '')
  assert.equal(script.venvPath, null)
})

test('normalizeInput keeps line breaks inside a command', () => {
  const script = normalizeInput(
    {
      kind: 'command',
      name: '合盖',
      scriptPath: '',
      args: '',
      venvPath: null,
      command: 'if true; then\r\n  echo yes\r\nfi\n'
    },
    '/Users/me'
  )
  assert.equal(script.command, 'if true; then\n  echo yes\nfi')
})

test('moveInOrder moves an id onto another and leaves a missing id alone', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a'])
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'])
  assert.deepEqual(moveInOrder(['a', 'b'], 'missing', 'a'), ['a', 'b'])
})

test('moveBeside inserts on the pointer side and stays put on the near edge', () => {
  assert.deepEqual(moveBeside(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b'])
  assert.deepEqual(moveBeside(['a', 'b', 'c'], 'c', 'a', true), ['a', 'c', 'b'])
  assert.deepEqual(moveBeside(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a'])
  assert.deepEqual(moveBeside(['a', 'b', 'c'], 'a', 'c', false), ['b', 'a', 'c'])
  const same = ['a', 'b', 'c']
  assert.equal(moveBeside(same, 'a', 'b', false), same)
})

test('system language maps Chinese tags to simplified Chinese', () => {
  assert.equal(resolveLocale('system', 'zh-CN'), 'zh-CN')
  assert.equal(resolveLocale('system', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLocale('system', 'zh_TW'), 'zh-CN')
  assert.equal(resolveLocale('system', 'en-US'), 'en')
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN')
})

test('translate fills placeholders for the active catalog', () => {
  assert.equal(translate('zh-CN', 'dialog.quitRunningMany', { count: 2 }), '还有 2 个脚本在运行')
  assert.equal(translate('en', 'dialog.quitRunningOne'), '1 script is still running')
  assert.equal(translate('en', 'sidebar.exitCode', { code: 0 }), 'Exit 0')
})

test('placeVisibleOrder keeps hidden ids and applies the visible order', () => {
  assert.deepEqual(placeVisibleOrder(['a', 'x', 'b', 'y', 'c'], ['c', 'a', 'b']), ['c', 'x', 'a', 'y', 'b'])
})
