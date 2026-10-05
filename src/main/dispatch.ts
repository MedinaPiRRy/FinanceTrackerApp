export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string }

/**
 * Runs a named handler and always waits for it to finish, so asynchronous operations reply with
 * their result rather than a Promise object. Errors become a plain message the UI can show.
 */
export async function dispatch(handlers: Record<string, unknown>, method: string, args: unknown[] | undefined): Promise<ApiResult> {
  const fn = handlers[method]
  if (typeof fn !== 'function') {
    console.error(`Unknown method ${method}`)
    return { ok: false, error: 'Something went wrong. Reload the page and try again.' }
  }
  try {
    return { ok: true, data: (await (fn as (...a: unknown[]) => unknown)(...(args ?? []))) ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
