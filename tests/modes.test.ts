import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandlers } from '../src/main/handlers'

type Mode = 'single' | 'couple' | 'couple_household'
const MODES: Mode[] = ['single', 'couple', 'couple_household']
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-modes-')), 'finance.db')
const people = (mode: Mode) => (mode === 'single' ? [{ name: 'A', accounts: [{ name: 'Chequing', type: 'chequing' as const }] }] : [{ name: 'A', accounts: [{ name: 'Chequing', type: 'chequing' as const }] }, { name: 'B', accounts: [] }])

// Everything the app asks for when it opens and when a page loads, for each setup and each starting state.
// A call that throws here would show up as "Could not start" or a broken page.
function startup(h: ReturnType<typeof createHandlers>, mode: Mode) {
  const s = h.status()
  expect(s.mode).toBe(mode)
  const household = h.household()
  expect(household === null).toBe(mode !== 'couple_household')
  const ps = h.profiles()
  expect(ps).toHaveLength(mode === 'single' ? 1 : 2)
  for (const p of ps) {
    h.accounts(p.id); h.categories(p.id); h.reviewQueue(p.id); h.recurringStopped(p.id); h.recurringSuggest(p.id); h.partner(p.id)
    h.insights(p.id); h.dashboard(p.id); h.goals(p.id); h.budgets(p.id, '2026-09'); h.forecast(p.id); h.debtPlanner(p.id); h.cash(p.id); h.recurring(p.id)
  }
  h.owners(); h.householdAccounts()
  if (household) { h.accounts(household.id); h.forecast(household.id); h.householdOverview(); h.householdBudgets('2026-09'); h.householdGoals() }
  return { household, ps }
}

describe('every setup opens without errors', () => {
  for (const mode of MODES) {
    it(`${mode}: own data, nothing imported yet`, () => {
      const h = createHandlers(tmp())
      h.setupOwn(mode, people(mode))
      startup(h, mode)
      h.close()
    })
    it(`${mode}: sample data`, () => {
      const h = createHandlers(tmp())
      h.startSample(mode)
      startup(h, mode)
      h.close()
    })
  }

  it('the partner is only offered when there is a second person', () => {
    const h = createHandlers(tmp())
    h.setupOwn('single', people('single'))
    expect(h.partner(h.profiles()[0]!.id)).toBeNull()
    h.close()
  })
})
