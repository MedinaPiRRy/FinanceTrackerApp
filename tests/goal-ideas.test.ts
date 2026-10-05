import { describe, it, expect } from 'vitest'
import { suggestIdeas, type IdeaInput } from '../src/core/goalIdeas'
import { openDb } from '../src/db/open'
import { generateSample } from '../src/demo/sample'
import { goalIdeas, createGoalsFromIdeas } from '../src/db/goalIdeas'
import { listGoals } from '../src/db/goals'
import { getHouseholdProfile } from '../src/db/queries'

const base = (over: Partial<IdeaInput> = {}): IdeaInput => ({
  today: '2026-10-04', avgMonthlyIncomeCents: 400000, avgMonthlySpendCents: 300000, savingsAccounts: [], cushionCents: 0, investments: [], cards: [], loans: [],
  existing: { emergency: false, cardIds: [], loanIds: [], accountIds: [], savingHabit: false }, ...over
})

describe('suggestIdeas', () => {
  it('suggests clearing cards first, within 12 months and within the share of the surplus', () => {
    // surplus $1,000 -> pool $600; cards get at most 60% of the pool = $360 a month
    const [cards] = suggestIdeas(base({ cards: [{ accountId: 1, name: 'Visa', owedCents: 240000 }] }))
    expect(cards).toMatchObject({ key: 'cards', kind: 'debt', plannedMonthlyCents: 20000, monthsToFinish: 12, deadline: '2027-09-30' })
    const [big] = suggestIdeas(base({ cards: [{ accountId: 1, name: 'Visa', owedCents: 1200000 }] }))
    expect(big!.plannedMonthlyCents).toBe(36000) // $1,200 would need $1,000 a month; capped at $360, so it takes longer instead
    expect(big!.monthsToFinish).toBe(34)
  })

  it('never asks for more than is left over, and says so when nothing is', () => {
    const none = suggestIdeas(base({ avgMonthlyIncomeCents: 300000, avgMonthlySpendCents: 310000, cards: [{ accountId: 1, name: 'Visa', owedCents: 100000 }] }))
    expect(none[0]).toMatchObject({ plannedMonthlyCents: null, deadline: null, tone: 'unknown' })
    expect(none[0]!.notes).toMatch(/no monthly amount is suggested/)
    const unknown = suggestIdeas(base({ avgMonthlyIncomeCents: null, avgMonthlySpendCents: null, cards: [{ accountId: 1, name: 'Visa', owedCents: 100000 }] }))
    expect(unknown[0]!.plannedMonthlyCents).toBeNull()
  })

  it('total monthly amounts across ideas never exceed 60% of the surplus', () => {
    const ideas = suggestIdeas(base({
      cards: [{ accountId: 1, name: 'Visa', owedCents: 900000 }], loans: [{ debtId: 1, name: 'Family loan', balanceCents: 900000 }],
      savingsAccounts: [{ id: 5, name: 'Savings', valueCents: 0 }], cushionCents: 0
    }))
    const total = ideas.reduce((s, i) => s + (i.plannedMonthlyCents ?? 0), 0)
    expect(ideas.map((i) => i.key)).toEqual(['cards', 'emergency', 'loans'])
    expect(total).toBeLessThanOrEqual(Math.round(100000 * 0.6))
  })

  it('emergency fund: one month first, three once the first is met, linked to the biggest untracked savings account', () => {
    const start = suggestIdeas(base({ savingsAccounts: [{ id: 5, name: 'Small', valueCents: 1000 }, { id: 6, name: 'Main savings', valueCents: 50000 }], cushionCents: 51000 }))
    expect(start[0]).toMatchObject({ key: 'emergency', title: 'Starter emergency fund (1 month)', kind: 'account', accountId: 6, targetCents: 300000 })
    const next = suggestIdeas(base({ savingsAccounts: [{ id: 6, name: 'Main savings', valueCents: 320000 }], cushionCents: 320000 }))
    expect(next[0]).toMatchObject({ title: 'Emergency fund (3 months)', targetCents: 900000 })
    expect(suggestIdeas(base({ cushionCents: 900000 })).find((i) => i.key === 'emergency')).toBeUndefined()
  })

  it('without a savings account the emergency fund is a manual goal that says so', () => {
    const [e] = suggestIdeas(base())
    expect(e).toMatchObject({ key: 'emergency', kind: 'manual' })
    expect(e!.why).toMatch(/no savings account to track/)
  })

  it('skips what the person already has', () => {
    const ideas = suggestIdeas(base({
      cards: [{ accountId: 1, name: 'Visa', owedCents: 100000 }, { accountId: 2, name: 'MC', owedCents: 50000 }], loans: [{ debtId: 9, name: 'Loan', balanceCents: 100000 }],
      existing: { emergency: true, cardIds: [1], loanIds: [9], accountIds: [], savingHabit: false }
    }))
    expect(ideas.map((i) => i.key)).toEqual(['cards'])
    expect(ideas[0]!.debtItems).toEqual([{ accountId: 2 }])
  })

  it('offers a savings habit only when nothing else needs the money', () => {
    const calm = suggestIdeas(base({ cushionCents: 900000 }))
    expect(calm.map((i) => i.key)).toEqual(['habit'])
    expect(calm[0]).toMatchObject({ kind: 'manual', plannedMonthlyCents: 40000, targetCents: 480000 })
    expect(suggestIdeas(base({ cushionCents: 900000, existing: { emergency: false, cardIds: [], loanIds: [], accountIds: [], savingHabit: true } }))).toEqual([])
  })

  it('suggests growing an investment account only when it has a value and there is money to spare', () => {
    const inv = { id: 7, name: 'Brokerage', valueCents: 1_000_000 }
    expect(suggestIdeas(base({ cushionCents: 900000, investments: [inv] })).map((i) => i.key)).toContain('invest:7')
    expect(suggestIdeas(base({ cushionCents: 900000, investments: [{ ...inv, valueCents: null }] })).map((i) => i.key)).not.toContain('invest:7')
    expect(suggestIdeas(base({ cushionCents: 900000, investments: [inv], existing: { emergency: false, cardIds: [], loanIds: [], accountIds: [7], savingHabit: false } })).map((i) => i.key)).not.toContain('invest:7')
  })
})

describe('goalIdeas (database)', () => {
  const NOW = new Date(2026, 9, 25)
  const TODAY = '2026-10-25'

  it('works from the sample person\'s numbers, and a created idea stops being suggested', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', NOW)
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const before = goalIdeas(db, pid, TODAY)
    expect(before.months).toHaveLength(3)
    expect(before.avgMonthlyIncomeCents).toBeGreaterThan(0)
    // the sample already has an emergency fund and a card payoff goal, but has student loans
    expect(before.ideas.map((i) => i.key)).toContain('loans')
    const ids = createGoalsFromIdeas(db, pid, [{ key: 'loans' }], TODAY)
    const goal = listGoals(db, pid, TODAY).find((g) => g.id === ids[0])!
    expect(goal).toMatchObject({ kind: 'debt', name: expect.stringMatching(/loan/i) })
    expect(goal.deadline).not.toBeNull()
    expect(goalIdeas(db, pid, TODAY).ideas.map((i) => i.key)).not.toContain('loans')
    expect(() => createGoalsFromIdeas(db, pid, [{ key: 'loans' }], TODAY)).toThrow(/no longer available/)
  })

  it('editing the monthly amount drops the now-inconsistent deadline', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', NOW)
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const [id] = createGoalsFromIdeas(db, pid, [{ key: 'loans', name: 'Student loan payoff', plannedMonthlyCents: 12345 }], TODAY)
    expect(listGoals(db, pid, TODAY).find((g) => g.id === id)).toMatchObject({ name: 'Student loan payoff', plannedMonthlyCents: 12345, deadline: null })
  })

  it('gives nothing without a complete month of history', () => {
    const db = openDb(':memory:')
    generateSample(db, 'single', new Date(2026, 9, 25))
    db.prepare("DELETE FROM txn WHERE posted_date < '2026-10-01'").run()
    const pid = (db.prepare('SELECT id FROM profile').get() as { id: number }).id
    const r = goalIdeas(db, pid, TODAY)
    expect(r.months).toEqual([])
    expect(r.avgMonthlyIncomeCents).toBeNull()
  })

  it('household ideas use the combined numbers and can only create goals the household owns', () => {
    const db = openDb(':memory:')
    generateSample(db, 'couple_household', NOW)
    const h = getHouseholdProfile(db).id
    const r = goalIdeas(db, h, TODAY)
    const person = goalIdeas(db, (db.prepare("SELECT id FROM profile WHERE kind = 'person' ORDER BY id").get() as { id: number }).id, TODAY)
    expect(r.avgMonthlySpendCents!).toBeGreaterThan(person.avgMonthlySpendCents!)
    const keys = r.ideas.map((i) => i.key)
    if (keys.length) {
      createGoalsFromIdeas(db, h, [{ key: keys[0]! }], TODAY)
      expect(listGoals(db, h, TODAY).length).toBeGreaterThan(2)
    }
  })
})
