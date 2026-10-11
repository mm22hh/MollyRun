import type { ScriptboardApi } from '../../shared/api'

declare global {
  interface Window {
    scriptboard: ScriptboardApi
  }
}

export {}
