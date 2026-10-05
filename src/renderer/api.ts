import type { Handlers } from '../main/handlers'

declare global {
  interface Window {
    financeApi?: { call(method: string, ...args: unknown[]): Promise<{ ok: boolean; data?: unknown; error?: string }> }
  }
}

type Api = Omit<Handlers, 'close'>
type Method = keyof Api

/** Calls a handler in the main process (Electron) or the dev API server (browser dev mode). */
export async function api<M extends Method>(method: M, ...args: Parameters<Api[M]>): Promise<Awaited<ReturnType<Api[M]>>> {
  const res = window.financeApi
    ? await window.financeApi.call(method, ...args)
    : ((await (await fetch('/api', { method: 'POST', body: JSON.stringify({ method, args }) })).json()) as { ok: boolean; data?: unknown; error?: string })
  if (!res.ok) throw new Error(res.error ?? 'Something went wrong')
  return res.data as Awaited<ReturnType<Api[M]>>
}
