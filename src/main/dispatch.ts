export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string }

/**
 * Runs a named handler and always waits for it to finish, so asynchronous operations reply with
 * their result rather than a Promise object. Errors become a plain message the UI can show.
 */
export async function dispatch(handlers: Record<string, unknown>, method: string, args: unknown[] | undefined): Promise<ApiResult> {
  const fn = Object.hasOwn(handlers, method) ? handlers[method] : undefined // not inherited members such as "constructor" or "toString"
  if (typeof fn !== 'function') {
    console.error(`Unknown method ${method}`)
    return { ok: false, error: 'Something went wrong. Reload the page and try again.' }
  }
  try {
    return { ok: true, data: (await (fn as (...a: unknown[]) => unknown)(...(args ?? []))) ?? null }
  } catch (err) {
    // A message written for the person (an ordinary Error) is shown as it is. Anything else is a malformed request or an internal fault: it is
    // logged here and the person gets a plain sentence instead of "x.trim is not a function" or a SQL error.
    const internal = !(err instanceof Error) || err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError || /^SQLITE_|^SqliteError/.test((err as { code?: string }).code ?? err.name)
    if (internal) { console.error(`Handler ${method} failed:`, err); return { ok: false, error: 'That could not be done because the request was not valid. Reload the page and try again.' } }
    return { ok: false, error: err.message }
  }
}
