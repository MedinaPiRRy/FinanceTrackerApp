# Architecture and design decisions

## Shape of the app

```
src/
  core/       Pure, deterministic logic (no database, no UI): money, dates, statement parsing,
              classification, categorization, budgets, goals, insights, recurring detection,
              debt payoff planning and the cash-flow forecast. Heavily unit tested.
  db/         SQLite access (better-sqlite3). Schema, queries, imports, review queue, households.
  demo/       Sample-data generator (seeded, so output is reproducible).
  importers/  Reads CSV and xlsx files into rows of text. xlsx is parsed by a small read-only reader.
  main/       Electron main process. handlers.ts is the complete list of operations the UI can ask for.
  preload/    The one bridge between UI and main process.
  renderer/   React UI. It never touches the database or the file system directly.
scripts/      dev-api.ts: an HTTP bridge so the UI can be developed in a normal browser.
tests/        Vitest. Core logic and database behaviour, including migrations, imports and households.
```

The renderer calls `window.financeApi.call(method, ...args)`. `src/main/dispatch.ts` looks the method up in
`handlers.ts`, awaits it, and returns `{ ok, data }` or `{ ok: false, error }`. Because every operation is a plain
function of a database, nearly everything is testable without Electron.

## Decisions worth knowing

**Money is integer cents.** No floating point anywhere in the data. Dates are ISO `YYYY-MM-DD` strings.

**Balances are derived.** `balance = opening balance + SUM(transactions)`. Credit cards and loans are negative when
money is owed. Investments are the exception: their value moves with the market, so it is entered by hand and kept as
a history of valuations.

**Transaction kinds.** `income`, `expense`, `refund`, `transfer`, `unclassified`. Only income, expense and refund
count toward the dashboard. A transfer is two linked rows (same `transfer_group`) that net to zero, so paying a credit
card never looks like spending and moving money to savings never looks like income.

**Ambiguity goes to a review queue, not a guess.** An e-transfer might be rent, a reimbursement, a gift or money from
your partner, and the statement does not say. Those rows are stored as `unclassified` with a reason and are excluded
from income and spending until the user decides. Decisions are remembered as rules.

**Duplicates are handled at import time.** Each row gets a fingerprint from account, date, amount and the normalized
description, plus an occurrence number. A row already in the database is skipped. Genuine repeats within one file
(two identical coffees on one day) are kept and flagged, so re-importing an overlapping statement never double counts.

**Rules, not AI.** Categorization is built-in keyword rules, then rules learned from the user's own history and
corrections. Nothing leaves the machine.

**People and households.** A profile is either a `person` or the single `household` pseudo-profile that owns shared
accounts. Each person keeps their own categories; the household view combines differently named categories through
category *groups* (a default mapping the user can override). Money moved between two people, or into a shared
account, is a transfer with `counterparty_profile_id` set, so it is never income or spending for either side.

**Sample data is a separate database file.** `sample.db` is generated on demand and `app-state.json` records which
file is open. There is no code path that writes sample rows into `finance.db`.

**Forecast.** `core/forecast.ts` walks forward month by month from today's balances. Income streams are either regular
(tracked recurring income) or irregular (everything else that came in, grouped by category, with a poor-month and a
good-month level from history); spending is tracked bills plus everyday spending by category, with each bill taken out
of its category so it is not counted twice. The same walk runs three times for "today's pace", "my budgets and goals"
and the person's what-if, and three times again for poor, expected and good income. The debt step is shared with the
payoff planner (`core/debtPlan.ts`), so the two screens cannot disagree.

**Recurring items.** `core/recurringDetect.ts` looks for payments with a steady interval and a steady amount (groceries
and fuel fail the amount test on purpose). A tracked item that stops appearing is only questioned when the account's
data reaches past the date it was due, so an unimported statement never triggers a question.

**Insights.** Each insight carries a stable id, a plain-language meaning and a reference to the page and filter that
shows the evidence. The opening banner picks one: something worth a look first, otherwise good news.

**Foreign-currency tips.** Only cash tips can be in another currency. The rate is typed by the person (the app never
goes online), the converted amount is what counts, and the original amount and rate are kept for display. Bank
transactions are already converted by the bank.

**Safe upgrades.** The schema version lives in `PRAGMA user_version`. Before any migration the database file is copied
next to itself, and a migration that would drop a table containing rows refuses to run.

## Testing

`npm test` runs everything. Notable suites: `core.test.ts` and `statement.test.ts` (pure logic),
`import.test.ts` (duplicates, transfers, learning), `review.test.ts` (sign rules for decisions),
`household.test.ts` (shared accounts, between-us movement, household budgets), `sample.test.ts`
(generated data is internally consistent in all three setups).
