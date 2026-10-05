// Sample data: a made-up person (or couple) with about six months of believable history, so the app looks alive
// the first time it opens. Everything here is invented. The generator is deterministic (seeded), so the same
// setup always produces the same data, which keeps tests and screenshots stable.
import type { Db } from '../db/open'
import { ensureHouseholdProfile } from '../db/open'
import { createSetup, type AppMode, type NewPerson } from '../db/defaults'
import { createBudget } from '../db/budgets'
import { createGoal } from '../db/goals'
import { createDebt, updateDebtBalance } from '../db/debts'
import { setValuation } from '../db/review'
import { addTip, addCashSpend, recordCashBill } from '../db/cash'
import { setPartnerAliases } from '../db/partners'
import { createHouseholdBudget } from '../db/household'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

interface Persona {
  name: string
  accounts: NewPerson['accounts']
  payCents: number
  payer: string
  rentCents: number // 0 when rent is paid from the shared account
  groceryStores: string[]
  diningPlaces: string[]
  tips: boolean
  studentLoanCents: number
}

const ALEX: Persona = {
  name: 'Alex', payCents: 215_000, payer: 'ACME TECH INC PAYROLL', rentCents: 140_000, tips: false, studentLoanCents: 1_450_000,
  accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Savings', type: 'savings' }, { name: 'Rewards Visa', type: 'credit_card' }, { name: 'TFSA', type: 'investment' }],
  groceryStores: ['LOBLAWS', 'NO FRILLS', 'COSTCO WHOLESALE', 'FARM BOY'],
  diningPlaces: ['TIM HORTONS', 'STARBUCKS', 'UBER EATS', 'PIZZA PIZZA', 'SUSHI KAN RESTAURANT', 'THE LOCAL CAFE']
}
const SAM: Persona = {
  name: 'Sam', payCents: 178_000, payer: 'BAYVIEW BISTRO PAYROLL', rentCents: 0, tips: true, studentLoanCents: 0,
  accounts: [{ name: 'Chequing', type: 'chequing' }, { name: 'Savings', type: 'savings' }, { name: 'Travel Mastercard', type: 'credit_card' }, { name: 'FHSA', type: 'investment' }],
  groceryStores: ['METRO', 'FRESHCO', 'SOBEYS', 'FOOD BASICS'],
  diningPlaces: ['STARBUCKS', 'MCDONALDS', 'DOORDASH', 'SHAWARMA PALACE', 'COFFEE CULTURE', 'TACO FIESTA']
}

export interface SampleResult { mode: AppMode; people: string[]; transactions: number }

export function generateSample(db: Db, mode: AppMode, today: Date = new Date()): SampleResult {
  // In the first days of a month there is hardly any data for it, which makes a poor first impression: end on the last full month instead.
  const now = today.getDate() <= 10 ? new Date(today.getFullYear(), today.getMonth(), 0) : today
  const rand = rng(20260101)
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
  const cents = (lo: number, hi: number) => Math.round(between(lo, hi) * 100)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!

  const personas = mode === 'single' ? [ALEX] : [ALEX, SAM]
  const ids = createSetup(db, mode, personas.map((p) => ({ name: p.name, accounts: p.accounts })))
  const householdId = mode === 'couple_household' ? ensureHouseholdProfile(db) : null

  const cat = (profileId: number, name: string, kind: 'expense' | 'income' = 'expense') =>
    (db.prepare('SELECT id FROM category WHERE profile_id = ? AND name = ? AND kind = ?').get(profileId, name, kind) as { id: number }).id
  const acct = (profileId: number, name: string) => (db.prepare('SELECT id FROM account WHERE profile_id = ? AND name = ?').get(profileId, name) as { id: number }).id

  let n = 0
  const insert = db.prepare(`INSERT INTO txn (profile_id, account_id, posted_date, amount_cents, description, description_raw, category_id, kind, transfer_group, counterparty_profile_id, review_reason, source, fingerprint)
    VALUES (@profile, @account, @date, @cents, @description, @raw, @category, @kind, @group, @counterparty, @review, 'sample', @fp)`)
  const add = (t: { profile: number; account: number; date: string; cents: number; description: string; category?: number | null; kind: 'income' | 'expense' | 'refund' | 'transfer' | 'unclassified'; group?: string; counterparty?: number | null; review?: string | null }) => {
    insert.run({ raw: t.description, category: null, group: null, counterparty: null, review: null, ...t, fp: `sample-${++n}`, description: t.description })
  }
  const pairTransfer = (a: { profile: number; account: number }, b: { profile: number; account: number }, date: string, amount: number, label: string, crossProfile: boolean) => {
    const group = `sample-tg-${n}`
    add({ ...a, date, cents: -amount, description: label, kind: 'transfer', group, counterparty: crossProfile ? b.profile : null })
    add({ ...b, date, cents: amount, description: label, kind: 'transfer', group, counterparty: crossProfile ? a.profile : null })
  }

  // Six full months before this one, plus the month so far.
  const first = new Date(now.getFullYear(), now.getMonth() - 6, 1)
  const todayIso = iso(now)
  const months: Date[] = []
  for (let i = 0; i <= 6; i++) months.push(new Date(first.getFullYear(), first.getMonth() + i, 1))

  db.transaction(() => {
    personas.forEach((p, pi) => {
      const id = ids[pi]!
      const chq = acct(id, 'Chequing'), sav = acct(id, 'Savings'), card = acct(id, p.accounts[2]!.name), inv = acct(id, p.accounts[3]!.name)
      db.prepare('UPDATE account SET opening_balance_cents = ?, institution = ? WHERE id = ?').run(cents(1500, 2600), 'Sample Bank', chq)
      db.prepare('UPDATE account SET opening_balance_cents = ?, institution = ? WHERE id = ?').run(cents(2500, 6000), 'Sample Bank', sav)
      db.prepare('UPDATE account SET opening_balance_cents = ?, credit_limit_cents = ?, institution = ? WHERE id = ?').run(-cents(300, 900), 800_000, 'Sample Bank', card)
      db.prepare('UPDATE account SET institution = ? WHERE id = ?').run('Sample Brokerage', inv)
      const cDining = cat(id, 'Dining'), cGro = cat(id, 'Groceries'), cTrans = cat(id, 'Transportation'), cSubs = cat(id, 'Subscriptions'), cShop = cat(id, 'Shopping')
      const cHealth = cat(id, 'Health & personal care'), cEnt = cat(id, 'Entertainment'), cRent = cat(id, 'Rent & housing'), cUtil = cat(id, 'Utilities'), cPay = cat(id, 'Pay', 'income'), cInt = cat(id, 'Interest', 'income')
      const cGift = cat(id, 'Gifts received', 'income')
      const cardSpend: Map<string, number> = new Map()
      const spend = (date: Date, account: number, amount: number, description: string, category: number, key: string) => {
        if (date > now) return
        add({ profile: id, account, date: iso(date), cents: -amount, description, category, kind: 'expense' })
        if (account === card) cardSpend.set(key, (cardSpend.get(key) ?? 0) + amount)
      }

      for (const m of months) {
        const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`
        const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()
        const day = (d: number) => new Date(m.getFullYear(), m.getMonth(), Math.min(d, dim))
        // Pay: every second Friday, anchored to a fixed date so months line up.
        for (let d = new Date(2026, 0, 2); d < new Date(m.getFullYear(), m.getMonth() + 1, 1); d = addDays(d, 14)) {
          if (d >= m && d <= now) add({ profile: id, account: chq, date: iso(d), cents: p.payCents, description: p.payer, category: cPay, kind: 'income' })
        }
        if (p.rentCents > 0) spend(day(1), chq, p.rentCents, 'E-TRANSFER RENT - LANDLORD', cRent, key)
        spend(day(3), chq, 6400 + Math.round(rand() * 800), 'HYDRO BILL PAYMENT', cUtil, key)
        spend(day(7), card, 6599, 'ROGERS WIRELESS', cUtil, key)
        spend(day(9), card, 1649, 'NETFLIX.COM', cSubs, key)
        spend(day(12), card, 1199, 'SPOTIFY', cSubs, key)
        if (pi === 0 && months.indexOf(m) <= 2) spend(day(11), card, 1399, 'DISNEY PLUS', cSubs, key) // a subscription that quietly stopped: the app will ask if it was cancelled
        spend(day(15), chq, 3999, 'GOODLIFE FITNESS MEMBERSHIP', cEnt, key)
        for (let w = 0; w < 4; w++) spend(day(2 + w * 7 + Math.floor(rand() * 3)), card, cents(55, 145), pick(p.groceryStores), cGro, key)
        for (let k = 0; k < 8; k++) spend(day(1 + Math.floor(rand() * 28)), rand() < 0.7 ? card : chq, cents(7, 52), pick(p.diningPlaces), cDining, key)
        for (let k = 0; k < 3; k++) spend(day(1 + Math.floor(rand() * 28)), card, cents(3, 28), pick(['PRESTO FARE', 'UBER *TRIP', 'PETRO-CANADA', 'PARKING HONK']), cTrans, key)
        if (rand() < 0.8) spend(day(1 + Math.floor(rand() * 28)), card, cents(20, 140), pick(['AMAZON.CA', 'H&M', 'WINNERS', 'IKEA']), cShop, key)
        if (rand() < 0.5) spend(day(1 + Math.floor(rand() * 28)), card, cents(12, 55), 'SHOPPERS DRUG MART', cHealth, key)
        // Savings, interest, and paying the card off (the payment is a transfer, not spending).
        const sd = day(16)
        if (sd <= now) pairTransfer({ profile: id, account: chq }, { profile: id, account: sav }, iso(sd), 20_000 + Math.round(rand() * 5) * 2500, 'TRANSFER TO SAVINGS', false)
        if (day(28) <= now) add({ profile: id, account: sav, date: iso(day(28)), cents: cents(3, 9), description: 'INTEREST', category: cInt, kind: 'income' })
        const prev = months.indexOf(m) - 1
        if (prev >= 0 && day(20) <= now) {
          const pk = `${months[prev]!.getFullYear()}-${pad(months[prev]!.getMonth() + 1)}`
          const owed = cardSpend.get(pk) ?? 0
          if (owed > 0) pairTransfer({ profile: id, account: chq }, { profile: id, account: card }, iso(day(20)), owed, 'CREDIT CARD PAYMENT', false)
        }
      }

      // Things that make the review queue and the learned rules worth showing off.
      const review = (offset: number, cents_: number, description: string, reason: string) => {
        const d = addDays(now, -offset)
        add({ profile: id, account: chq, date: iso(d), cents: cents_, description, kind: 'unclassified', review: reason })
      }
      review(3, 4500, 'E-TRANSFER FROM JORDAN LEE', 'E-transfer: income, a refund, or money moved between you and someone else?')
      review(9, -6000, 'E-TRANSFER TO CHRIS PARK', 'E-transfer: who is this for? (spending, a gift, rent, or between you?)')
      review(17, 12000, 'E-TRANSFER FROM MAPLE CAFE', 'E-transfer: income, a refund, or money moved between you and someone else?')
      add({ profile: id, account: chq, date: iso(addDays(now, -22)), cents: 2599, description: 'AMAZON.CA REFUND', category: cShop, kind: 'refund' })
      add({ profile: id, account: chq, date: iso(addDays(now, -30)), cents: 7500, description: 'E-TRANSFER FROM FRIEND (BIRTHDAY)', category: cGift, kind: 'income' })

      // Investment value history, entered by hand like a real user would.
      let value = cents(6000, 9000)
      for (const m of months) {
        value = Math.round(value * (1 + between(-0.01, 0.025)) + (mode === 'single' ? 20000 : 15000))
        const d = new Date(m.getFullYear(), m.getMonth() + 1, 0)
        if (d <= now) setValuation(db, inv, iso(d), value, 'Sample value')
      }
      setValuation(db, inv, todayIso, value, 'Sample value')

      // Cash: tips, and a few cash purchases.
      if (p.tips) {
        for (let k = 0; k < 18; k++) {
          const when = iso(addDays(now, -Math.floor(rand() * 90)))
          if (k % 6 === 0) addTip(db, id, when, 0, 'Tips from US visitors', { currency: 'USD', cents: Math.round(between(20, 60) * 100), rate: Math.round((1.35 + rand() * 0.04) * 10000) / 10000 })
          else addTip(db, id, when, cents(25, 95), 'Weekend shift tips')
        }
        // a bill paid from the cash wallet, recorded each month, and a subscription that was cancelled
        const phoneId = Number(db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?, 'Phone plan (paid in cash)', 'expense', ?, 4500, 'monthly', ?, 'active')").run(id, acct(id, 'Cash'), iso(new Date(now.getFullYear(), now.getMonth(), 5))).lastInsertRowid)
        for (let k = 0; k < 3; k++) recordCashBill(db, id, phoneId, iso(new Date(now.getFullYear(), now.getMonth() - k, 5)), cUtil)
        db.prepare("INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status, notes) VALUES (?, 'Music streaming (old plan)', 'expense', ?, 1099, 'monthly', ?, 'cancelled', 'Cancelled in the spring')").run(id, card, iso(new Date(first.getFullYear(), first.getMonth() + 1, 12)))
      }
      addCashSpend(db, id, iso(addDays(now, -4)), cents(8, 20), 'Farmers market', cGro)
      if (p.tips) addCashSpend(db, id, iso(addDays(now, -11)), 3500, 'Haircut', cHealth)
      else addTip(db, id, iso(addDays(now, -15)), 4000, 'Cash from a friend for concert tickets')

      // Import history, so the Import page and its undo list have something in them.
      const split = iso(new Date(first.getFullYear(), first.getMonth() + 3, 1))
      const batch = (file: string, from: string, to: string) => {
        const bid = Number(db.prepare("INSERT INTO import_batch (profile_id, source, filename, imported_at, account_id, file_hash, layout) VALUES (?, 'import', ?, ?, ?, ?, 'h:date|description|debit|credit')").run(id, file, `${to} 09:00:00`, chq, `sample-${id}-${file}`).lastInsertRowid)
        const n = db.prepare("UPDATE txn SET import_batch_id = ? WHERE profile_id = ? AND account_id = ? AND source = 'sample' AND posted_date >= ? AND posted_date < ?").run(bid, id, chq, from, to).changes
        db.prepare('UPDATE import_batch SET row_count = ? WHERE id = ?').run(n, bid)
      }
      batch(`chequing-${split.slice(0, 7)}-earlier.csv`, iso(first), split)
      batch('chequing-latest.csv', split, iso(addDays(now, 1)))

      // Budgets, loans and goals.
      createBudget(db, id, 'Food', 55_000, [cGro, cDining])
      createBudget(db, id, 'Getting around', 15_000, [cTrans])
      createBudget(db, id, 'Fun & shopping', 25_000, [cShop, cEnt])
      createBudget(db, id, 'Subscriptions', 9_000, [cSubs])
      createGoal(db, id, { name: 'Emergency fund', kind: 'account', accountId: sav, targetCents: 1_000_000, plannedMonthlyCents: 20_000, notes: 'Three months of expenses.' })
      createGoal(db, id, { name: 'Pay off the credit card', kind: 'debt', debtItems: [{ accountId: card }], plannedMonthlyCents: 15_000 })
      if (pi === 0) createGoal(db, id, { name: 'New laptop', kind: 'manual', targetCents: 220_000, manualCents: 85_000, deadline: iso(addDays(now, 150)) })
      else createGoal(db, id, { name: 'Trip to Japan', kind: 'manual', targetCents: 450_000, manualCents: 120_000, deadline: iso(addDays(now, 240)), plannedMonthlyCents: 30_000 })
      if (p.studentLoanCents > 0) {
        const d = createDebt(db, id, 'Student loan', p.studentLoanCents + 120_000, iso(first), 'Government student loan')
        updateDebtBalance(db, id, d, p.studentLoanCents, todayIso)
      }
      if (pi === 0) db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(id, 'Disney+', 'expense', card, 1399, 'monthly', iso(new Date(months[2]!.getFullYear(), months[2]!.getMonth(), 11)), 'active')
      if (pi === 1) {
        const d = createDebt(db, id, 'Car loan', 960_000, iso(first), 'Loan from the bank')
        updateDebtBalance(db, id, d, 780_000, todayIso)
      }
      db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(id, 'Netflix', 'expense', card, 1649, 'monthly', iso(day9(now)), 'active')
      db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(id, 'Spotify', 'expense', card, 1199, 'monthly', iso(day9(now, 12)), 'active')
      db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(id, 'Gym membership', 'expense', chq, 3999, 'monthly', iso(day9(now, 15)), 'active')
      db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(id, 'Phone plan', 'expense', card, 6599, 'monthly', iso(day9(now, 7)), 'active')
    })

    // Couples: a few e-transfers between the two of them (movement, not income or spending), recognised by name.
    if (mode !== 'single') {
      const [a, b] = ids as [number, number]
      const ac = acct(a, 'Chequing'), bc = acct(b, 'Chequing')
      setPartnerAliases(db, a, ['Sam Rivera'])
      setPartnerAliases(db, b, ['Alex Morgan'])
      for (const off of [6, 33, 61]) {
        const g = `sample-us-${off}`
        const d = iso(addDays(now, -off))
        add({ profile: a, account: ac, date: d, cents: -6000, description: 'E-TRANSFER TO SAM RIVERA', kind: 'transfer', group: g, counterparty: b })
        add({ profile: b, account: bc, date: d, cents: 6000, description: 'E-TRANSFER FROM ALEX MORGAN', kind: 'transfer', group: g, counterparty: a })
      }
    }

    // Household: a joint account both people feed, which pays the shared bills; household budgets and goals.
    if (householdId !== null) {
      const [a, b] = ids as [number, number]
      db.prepare("INSERT INTO account (profile_id, name, type, institution, opening_balance_cents) VALUES (?, 'Joint Chequing', 'chequing', 'Sample Bank', 120000)").run(householdId)
      db.prepare("INSERT INTO account (profile_id, name, type, institution, opening_balance_cents) VALUES (?, 'Joint Savings (house fund)', 'savings', 'Sample Bank', 900000)").run(householdId)
      db.prepare("INSERT INTO account (profile_id, name, type, institution, opening_balance_cents, credit_limit_cents) VALUES (?, 'Shared Visa', 'credit_card', 'Sample Bank', -90000, 600000)").run(householdId)
      db.prepare("INSERT INTO account (profile_id, name, type, institution) VALUES (?, 'Joint investment', 'investment', 'Sample Brokerage')").run(householdId)
      const joint = acct(householdId, 'Joint Chequing'), fund = acct(householdId, 'Joint Savings (house fund)')
      const sharedCard = acct(householdId, 'Shared Visa'), jointInv = acct(householdId, 'Joint investment')
      let jointValue = 1_500_000
      const hCat = (name: string, kind: 'expense' | 'income' = 'expense') => cat(householdId, name, kind)
      for (const m of months) {
        const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()
        const day = (d: number) => new Date(m.getFullYear(), m.getMonth(), Math.min(d, dim))
        const sd = (d: number) => (day(d) <= now ? iso(day(d)) : null)
        let when = sd(1)
        if (when) {
          pairTransfer({ profile: a, account: acct(a, 'Chequing') }, { profile: householdId, account: joint }, when, 90_000, 'TRANSFER TO JOINT CHEQUING', true)
          pairTransfer({ profile: b, account: acct(b, 'Chequing') }, { profile: householdId, account: joint }, when, 90_000, 'TRANSFER TO JOINT CHEQUING', true)
          add({ profile: householdId, account: joint, date: when, cents: -165_000, description: 'RENT - PROPERTY MANAGEMENT', category: hCat('Rent & housing'), kind: 'expense' })
        }
        when = sd(5)
        if (when) {
          add({ profile: householdId, account: joint, date: when, cents: -cents(90, 150), description: 'ENBRIDGE GAS', category: hCat('Utilities'), kind: 'expense' })
          add({ profile: householdId, account: joint, date: when, cents: -8900, description: 'BELL INTERNET', category: hCat('Utilities'), kind: 'expense' })
        }
        for (let w = 0; w < 3; w++) { const dd = sd(4 + w * 9); if (dd) add({ profile: householdId, account: joint, date: dd, cents: -cents(70, 180), description: pick(['COSTCO WHOLESALE', 'LOBLAWS', 'FARM BOY']), category: hCat('Groceries'), kind: 'expense' }) }
        for (let k = 0; k < 2; k++) { const dd = sd(8 + k * 11); if (dd) add({ profile: householdId, account: joint, date: dd, cents: -cents(40, 110), description: pick(['DATE NIGHT RESTAURANT', 'THE BOARDWALK GRILL', 'SUSHI KAN RESTAURANT']), category: hCat('Dining'), kind: 'expense' }) }
        when = sd(15)
        if (when) pairTransfer({ profile: householdId, account: joint }, { profile: householdId, account: fund }, when, 40_000, 'TRANSFER TO HOUSE FUND', false)
        when = sd(10)
        if (when) add({ profile: householdId, account: joint, date: when, cents: -6200, description: 'HOME INSURANCE PREMIUM', category: hCat('Insurance, loans & admin'), kind: 'expense' })
        for (const d of [6, 17]) { const dd = sd(d); if (dd) add({ profile: householdId, account: sharedCard, date: dd, cents: -cents(90, 260), description: pick(['COSTCO WHOLESALE', 'IKEA', 'HOME DEPOT']), category: hCat('Shopping'), kind: 'expense' }) }
        when = sd(20)
        if (when) pairTransfer({ profile: householdId, account: joint }, { profile: householdId, account: sharedCard }, when, 45_000, 'CREDIT CARD PAYMENT', false)
        jointValue = Math.round(jointValue * (1 + between(-0.01, 0.02)) + 40_000)
        const monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 0)
        if (monthEnd <= now) setValuation(db, jointInv, iso(monthEnd), jointValue, 'Sample value')
      }
      setValuation(db, jointInv, todayIso, jointValue, 'Sample value')
      createHouseholdBudget(db, 'Home & bills', 280_000, ['Rent & housing', 'Utilities'])
      createHouseholdBudget(db, 'Food together', 90_000, ['Groceries', 'Dining'])
      createGoal(db, householdId, { name: 'House down payment', kind: 'account', accountId: fund, targetCents: 6_000_000, plannedMonthlyCents: 40_000, deadline: iso(addDays(now, 900)), notes: 'Both of us contribute from the joint account.' })
      createGoal(db, householdId, { name: 'Home emergency fund', kind: 'manual', targetCents: 500_000, manualCents: 150_000 })
      for (const [name, amount, day] of [['Internet', 8900, 5], ['Home insurance', 6200, 10]] as const) db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(householdId, name, 'expense', joint, amount, 'monthly', iso(new Date(now.getFullYear(), now.getMonth(), day)), 'active')
      db.prepare('INSERT INTO recurring (profile_id, name, direction, account_id, amount_cents, frequency, last_charged, status) VALUES (?,?,?,?,?,?,?,?)').run(householdId, 'Rent', 'expense', joint, 165_000, 'monthly', iso(new Date(now.getFullYear(), now.getMonth(), 1)), 'active')
    }
  })()

  return { mode, people: personas.map((p) => p.name), transactions: (db.prepare('SELECT COUNT(*) n FROM txn').get() as { n: number }).n }
}

function day9(now: Date, d = 9): Date { return new Date(now.getFullYear(), now.getMonth() - (now.getDate() < d ? 1 : 0), d) }
