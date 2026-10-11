import { t } from './i18n'

export function parseArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  let started = false

  const push = () => {
    args.push(current)
    current = ''
    started = false
  }

  for (const ch of input) {
    if (escaping) {
      current += ch
      escaping = false
      started = true
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      started = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) push()
      continue
    }
    current += ch
    started = true
  }

  if (escaping) throw new Error(t('error.escape'))
  if (quote) throw new Error(t('error.quote'))
  if (started) push()
  return args
}

export function shellEscape(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function formatCommand(parts: string[]): string {
  return parts.map(shellEscape).join(' ')
}

export function argsError(input: string): string | null {
  try {
    parseArgs(input)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : t('error.args')
  }
}
