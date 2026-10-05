import type { Db } from '../src/db/open'

/** A recurring item tied to an account (used to prove an account with dependencies cannot be moved). */
export function createRecurringForTest(db: Db, profileId: number, name: string, accountId: number): number {
  return Number(db.prepare("INSERT INTO recurring (profile_id,name,direction,account_id,amount_cents,frequency) VALUES (?,?,'expense',?,1000,'monthly')").run(profileId, name, accountId).lastInsertRowid)
}
