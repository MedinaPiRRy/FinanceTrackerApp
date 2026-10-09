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

**Review scales by source, not by row.** The queue is shown in four tabs and grouped by source (the normalised bank description, which for an e-transfer is the other person's name), one page at a time. A decision can be applied to a whole source, and "always do this" stores a `source_rule` (per profile, per direction) that files everything already waiting from that source and any future import. Anything waiting for more than 90 days (`OLD_AFTER_DAYS`) is set aside in an Older tab: the badge and banners count recent items only, and the statistics pages show a notice instead. Nothing is remembered unless the person ticks the box, and every rule can be forgotten in Settings.

**Settings.** Names, the start page, the "older" cut-off and automatic backups live in the `setting` table (so they travel with a backup). The category and account managers refuse to leave anything dangling: deleting a used category or an account with transactions needs somewhere to move them (or a typed confirmation), and a backup is made first. Moving between "just me", "me and my partner" and "plus a shared household" adds people safely; removing one deletes their data (backup first, typed confirmation) and turns money that moved between them and someone else into items to review. "Delete the app" erases the data and then hands off to the platform's uninstaller (only the installed app can do that; the dev server cannot).

**Loans.** A payment can be linked to a tracked loan (`debt_payment`). Linking records a new balance in the loan's history on the payment's date (nothing is guessed about interest); a payment dated on or before the loan's balance date is already part of it and only gets the link. "Always do this" can carry the loan, so later payments count automatically.

**Balances.** An account's balance is its starting balance plus every transaction, so a mismatch with the bank is either missing/duplicated transactions or a wrong starting balance. `accountChecks.ts` offers both fixes: set the starting balance to match the bank (warning when that would mean a card started with a credit), and find accounts that hold the same rows (matched by date and amount, only in months where almost every row of the smaller account has a twin).

**Back and forward.** `renderer/nav.tsx` keeps a history of visited pages. Each visit has an id, and pages keep their filters, month and tab with `useKept`, stored under that id, so Back returns to the page as it was left.

**Reversed charges.** `core/offsets.ts` pairs a charge with a refund of the same amount, account and category within a week (a monthly fee and its rebate). Such pairs are not suggested as bills, not counted as tracked costs, and not shown as unusual purchases.

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

**Subcategories.** `category.parent_id` allows one level: a main category and its children, of the same kind. Everything that
adds spending up (dashboard, budgets, forecast, household groups, goals, the workbook sync) groups by the main category
(`COALESCE(parent.name, name)`); a subcategory with a budget of its own is counted there instead. Pickers show
"Main › Sub" (`CategoryInfo.label`).

**Rules by amount.** `amount_rule` (merchant words, a limit, a category for "up to" and one for "more than") is checked in
`buildPreview` before any guess, matches whole words in the cleaned merchant name, and only looks at money going out.
`applyAmountRule` files rows still waiting for a category, optionally re-files automatic guesses, and never touches rows the
person filed or rows that come from a workbook.

**Taxes and interest.** Interest is found from the words of a money-out transaction ("interest", not a reversal or refund);
taxes are categories marked as such (`category.purpose`, guessed from the name until the person chooses). A fee that the bank
gave straight back is excluded.

**Net worth.** Accounts (non-card, non-archived; investments use their last valuation) + things added by hand (`asset`, with a
value history in `asset_value`) minus card/loan balances and tracked debts.

**Pending charges.** The app only holds posted transactions, so matching a bank balance uses the posted balance; an optional
pending amount is shown as "after pending" and never written.

## Testing

`npm test` runs everything. Notable suites: `core.test.ts` and `statement.test.ts` (pure logic),
`import.test.ts` (duplicates, transfers, learning), `review.test.ts` (sign rules for decisions),
`household.test.ts` (shared accounts, between-us movement, household budgets), `sample.test.ts`
(generated data is internally consistent in all three setups).
