import { describe, it, expect } from 'vitest'
import { dispatch } from '../src/main/dispatch'

describe('api dispatch', () => {
  it('waits for asynchronous handlers and returns their result, not a Promise', async () => {
    const h = { slow: async (n: number) => { await new Promise((r) => setTimeout(r, 20)); return { doubled: n * 2 } }, fast: () => 7 }
    expect(await dispatch(h, 'slow', [21])).toEqual({ ok: true, data: { doubled: 42 } })
    expect(await dispatch(h, 'fast', [])).toEqual({ ok: true, data: 7 })
  })
  it('turns thrown and rejected errors into messages, and unknown methods into an error', async () => {
    const h = { bad: () => { throw new Error('nope') }, rejected: async () => { throw new Error('later') } }
    expect(await dispatch(h, 'bad', [])).toEqual({ ok: false, error: 'nope' })
    expect(await dispatch(h, 'rejected', [])).toEqual({ ok: false, error: 'later' })
    expect(await dispatch(h, 'missing', [])).toEqual({ ok: false, error: 'Something went wrong. Reload the page and try again.' })
  })
  it('null results become null so they survive serialisation', async () => {
    expect(await dispatch({ nothing: () => undefined }, 'nothing', undefined)).toEqual({ ok: true, data: null })
  })
})
