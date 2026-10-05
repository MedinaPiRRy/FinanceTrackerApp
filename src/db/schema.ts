// Database schema. Amounts are integer cents. Dates are ISO strings.
// Balance convention for every account: opening_balance_cents + SUM(amount_cents).
//   Chequing/savings: positive = money you have.
//   Credit card:      negative = money owed (a charge is a negative amount, a payment is positive).
export const SCHEMA_VERSION = 1

/** 'household' is a pseudo-profile that owns the accounts you share (and their transactions). */
export const V4_PROFILE_COLUMN = `,
  kind  TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','household'))`

/** Set when money moved between you and the other person or into a shared account (not income or spending for either). */
export const V4_TXN_COLUMNS = `
  counterparty_profile_id INTEGER REFERENCES profile(id),
  currency        TEXT,        -- foreign currency a cash tip was received in (NULL = the home currency, CAD)
  original_cents  INTEGER,     -- the amount in that currency
  fx_rate         REAL,        -- home currency per 1 unit of it, as entered by the person
`

/** Household budgets span everyone's spending, by category group (names, since each person has their own categories). */
export const V4_TABLES = `
CREATE TABLE household_budget (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  monthly_cents  INTEGER NOT NULL CHECK (monthly_cents >= 0)
);
CREATE TABLE household_budget_group (
  budget_id   INTEGER NOT NULL REFERENCES household_budget(id) ON DELETE CASCADE,
  group_name  TEXT NOT NULL UNIQUE,
  PRIMARY KEY (budget_id, group_name)
);
`

export const V2_TABLES = `
-- A budget is a named monthly limit covering one or more spending categories (a category is in at most one budget).
CREATE TABLE budget (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES profile(id),
  name           TEXT NOT NULL,
  monthly_cents  INTEGER NOT NULL CHECK (monthly_cents >= 0),
  UNIQUE (profile_id, name)
);
CREATE TABLE budget_category (
  budget_id    INTEGER NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL UNIQUE REFERENCES category(id),
  PRIMARY KEY (budget_id, category_id)
);

-- Goals. kind: manual (you type the amount saved), account (an account's value), category (spending in a category
-- counts toward it, e.g. wedding payments), debt (paying down the listed cards/loans; target = amount owed at the start).
CREATE TABLE goal (
  id                     INTEGER PRIMARY KEY,
  profile_id             INTEGER NOT NULL REFERENCES profile(id),
  name                   TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('manual','account','category','debt')),
  target_cents           INTEGER NOT NULL CHECK (target_cents > 0),
  manual_cents           INTEGER NOT NULL DEFAULT 0,
  baseline_cents         INTEGER,
  deadline               TEXT,
  planned_monthly_cents  INTEGER,
  account_id             INTEGER REFERENCES account(id),
  category_id            INTEGER REFERENCES category(id),
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE goal_debt (
  goal_id     INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  account_id  INTEGER REFERENCES account(id),
  debt_id     INTEGER REFERENCES debt(id),
  CHECK ((account_id IS NULL) <> (debt_id IS NULL))
);
CREATE TABLE debt_history (
  id             INTEGER PRIMARY KEY,
  debt_id        INTEGER NOT NULL REFERENCES debt(id) ON DELETE CASCADE,
  as_of          TEXT NOT NULL,
  balance_cents  INTEGER NOT NULL,
  UNIQUE (debt_id, as_of)
);
`

export const SCHEMA_SQL = `
CREATE TABLE profile (
  id    INTEGER PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL${V4_PROFILE_COLUMN}
);

CREATE TABLE account (
  id                     INTEGER PRIMARY KEY,
  profile_id             INTEGER NOT NULL REFERENCES profile(id),
  name                   TEXT NOT NULL,
  type                   TEXT NOT NULL CHECK (type IN ('chequing','savings','credit_card','cash','investment','loan','other')),
  institution            TEXT,
  opening_balance_cents  INTEGER NOT NULL DEFAULT 0,
  credit_limit_cents     INTEGER,
  archived               INTEGER NOT NULL DEFAULT 0,
  UNIQUE (profile_id, name)
);

CREATE TABLE category (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profile(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('expense','income')),
  group_name  TEXT,
  UNIQUE (profile_id, kind, name)
);

CREATE TABLE import_batch (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES profile(id),
  source       TEXT NOT NULL,
  filename     TEXT,
  imported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  row_count    INTEGER NOT NULL DEFAULT 0,
  account_id   INTEGER REFERENCES account(id),
  file_hash    TEXT,    -- SHA-256 of the file: the same file is recognised even when renamed
  layout       TEXT     -- column layout of the file, so the next file like it is matched to the same account
);

CREATE TABLE txn (
  id               INTEGER PRIMARY KEY,
  profile_id       INTEGER NOT NULL REFERENCES profile(id),
  account_id       INTEGER NOT NULL REFERENCES account(id),
  posted_date      TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  description      TEXT NOT NULL,
  description_raw  TEXT,
  category_id      INTEGER REFERENCES category(id),
  kind             TEXT NOT NULL CHECK (kind IN ('income','expense','refund','transfer','unclassified')),
  transfer_group   TEXT,
  notes            TEXT,
${V4_TXN_COLUMNS}  review_reason    TEXT,                      -- non-NULL = waiting in the review queue
  reviewed_at      TEXT,
  source           TEXT NOT NULL CHECK (source IN ('import','manual','cash_entry','sample')),
  import_batch_id  INTEGER REFERENCES import_batch(id),
  fingerprint      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (profile_id, fingerprint)
);
CREATE INDEX txn_profile_date ON txn(profile_id, posted_date);
CREATE INDEX txn_account_date ON txn(account_id, posted_date);
CREATE INDEX txn_category     ON txn(category_id);
CREATE INDEX txn_review       ON txn(profile_id) WHERE review_reason IS NOT NULL;

-- Investments are valued by hand (balances move with the market), not by transactions.
CREATE TABLE account_valuation (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES account(id),
  as_of       TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  note        TEXT,
  UNIQUE (account_id, as_of)
);

CREATE TABLE category_rule (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER REFERENCES profile(id),   -- NULL = applies to everyone
  pattern      TEXT NOT NULL,
  match_type   TEXT NOT NULL CHECK (match_type IN ('contains','starts_with','exact','regex')),
  merchant     TEXT,
  category_id  INTEGER REFERENCES category(id),
  priority     INTEGER NOT NULL DEFAULT 100,
  source       TEXT NOT NULL CHECK (source IN ('builtin','learned','user'))
);

CREATE TABLE recurring (
  id            INTEGER PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profile(id),
  name          TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('income','expense')),
  account_id    INTEGER REFERENCES account(id),     -- NULL when paid in cash outside any bank account
  paid_with     TEXT,
  amount_cents  INTEGER NOT NULL,
  frequency     TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly','yearly','irregular')),
  usual_timing  TEXT,
  last_charged  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',     -- active | cancelled | irregular | new | updated
  counts_in_budget INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  match_key     TEXT,                               -- merchant key used to find this item's payments in the transactions
  source        TEXT NOT NULL DEFAULT 'manual',     -- manual | detected
  checked_at    TEXT                                -- when the person last confirmed it is still active
);

-- Suggestions the person said are not recurring, so they are not offered again.
CREATE TABLE recurring_dismissed (
  profile_id  INTEGER NOT NULL REFERENCES profile(id),
  key         TEXT NOT NULL,
  direction   TEXT NOT NULL,
  PRIMARY KEY (profile_id, key, direction)
);

${V2_TABLES}

${V4_TABLES}
-- Interest rate and minimum payment the person entered for a credit card (account id) or a loan (debt id).
-- A missing row, or a NULL, means "use the default".
CREATE TABLE debt_terms (
  kind               TEXT NOT NULL CHECK (kind IN ('card','loan')),
  ref_id             INTEGER NOT NULL,
  apr_bps            INTEGER,
  min_payment_cents  INTEGER,
  PRIMARY KEY (kind, ref_id)
);

CREATE TABLE debt (
  id            INTEGER PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profile(id),
  name          TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  as_of         TEXT NOT NULL,
  notes         TEXT
);

CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** SQL for upgrading a database from version N-1 to N. Empty until the first schema change after release. */
export const MIGRATIONS: Record<number, { guard: string[]; sql: string }> = {}
