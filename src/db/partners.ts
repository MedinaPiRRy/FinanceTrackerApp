import type { Db } from './open'
import { normalizeKey } from '../core/normalize'
import { keyMatches } from '../core/categorize'

// "Between us": money sent to or received from the other person. It moves between the two of you, so it is not income or
// spending for either (one of you has spent it or will). Who counts as "the other person" is learned from the first
// decision you make, and can be edited as a list of names.

const settingKey = (profileId: number) => `partner_aliases_${profileId}`

/** "E-Transfer to Jordan Lee" / bank text "Internet Banking E-TRANSFER 105... Jordan Lee" -> the comparable payee key "JORDAN LEE". */
export function payeeKey(text: string): string {
  return normalizeKey(text.replace(/^\s*e-?transfer\s+(to|from)\s+/i, '').replace(/\s*\(between us\)\s*$/i, ''))
}

export function getPartnerAliases(db: Db, profileId: number): string[] {
  const r = db.prepare('SELECT value FROM setting WHERE key = ?').get(settingKey(profileId)) as { value: string } | undefined
  if (!r) return []
  try { return (JSON.parse(r.value) as string[]).filter((x) => typeof x === 'string' && x.trim()) } catch { return [] }
}

export function setPartnerAliases(db: Db, profileId: number, names: string[]): string[] {
  const seen = new Set<string>()
  const clean = names.map((n) => n.trim()).filter((n) => {
    const k = payeeKey(n)
    if (n.length === 0 || k.length < 3 || seen.has(k)) return false
    seen.add(k)
    return true
  })
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(settingKey(profileId), JSON.stringify(clean))
  return clean
}

/** Remembers a name as "the other person" (from the bank text or description of an e-transfer). */
export function addPartnerAlias(db: Db, profileId: number, text: string): void {
  const key = payeeKey(text)
  if (key.length < 3) return
  const have = getPartnerAliases(db, profileId)
  if (have.some((a) => payeeKey(a) === key)) return
  const display = text.replace(/^\s*(internet banking\s+)?e-?transfer\s+(\d+\s+)?((to|from)\s+)?/i, '').replace(/\s*\(between us\)\s*$/i, '').trim() || key
  setPartnerAliases(db, profileId, [...have, display])
}

export function isPartnerPayee(db: Db, profileId: number, text: string): boolean {
  const key = payeeKey(text)
  if (key.length < 3) return false
  return getPartnerAliases(db, profileId).some((a) => {
    const ak = payeeKey(a)
    return ak === key || key.startsWith(`${ak} `) || ak.startsWith(`${key} `) || keyMatches(key, ak)
  })
}

/** The other person (there are two people in this app). */
export function partnerOf(db: Db, profileId: number): { id: number; name: string } | null {
  return (db.prepare("SELECT id, name FROM profile WHERE kind = 'person' AND id <> ? ORDER BY id LIMIT 1").get(profileId) as { id: number; name: string } | undefined) ?? null
}
