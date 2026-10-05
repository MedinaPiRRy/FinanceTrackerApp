// Opens the Transactions page on the account around one transaction: a window of two weeks either side, with that row highlighted.
import { addDays } from '../core/dates'
import type { TxnPreset } from './App'

export interface TxnTarget { id: number; accountId: number; date: string }
export const WINDOW_DAYS = 14

export const txnPreset = (t: TxnTarget): TxnPreset => ({ accountId: t.accountId, from: addDays(t.date, -WINDOW_DAYS), to: addDays(t.date, WINDOW_DAYS), txnId: t.id })
