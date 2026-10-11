import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { setActiveLocale, translate, type AppLocale, type MessageKey } from '../../shared/i18n'

function readLocale(): AppLocale {
  return document.documentElement.dataset.locale === 'en' ? 'en' : 'zh-CN'
}

setActiveLocale(readLocale())

const LocaleContext = createContext<AppLocale>(readLocale())

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readLocale)
  setActiveLocale(locale)

  useEffect(() => {
    return window.scriptboard.onLocale((next) => {
      if (next !== 'en' && next !== 'zh-CN') return
      document.documentElement.lang = next
      document.documentElement.dataset.locale = next
      setLocale(next)
    })
  }, [])

  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}

export function useT() {
  const locale = useContext(LocaleContext)
  return useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  )
}
