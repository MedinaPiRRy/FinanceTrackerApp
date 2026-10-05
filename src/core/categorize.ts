import type { Tag } from './classify'

export interface Rule {
  pattern: string // merchant key
  merchant: string | null // display name to use
  categoryId: number | null
  /** lower wins: 10 your corrections, 20 learned aliases, 60 your history */
  priority: number
  source: 'user' | 'alias' | 'history'
}

/**
 * A rule matches when the key equals the pattern, begins with it as whole words, or when the bank truncated the
 * name (statements cut names at ~15 characters) so one is a long prefix of the other.
 */
export function keyMatches(key: string, pattern: string): boolean {
  if (!key || !pattern) return false
  if (key === pattern || key.startsWith(`${pattern} `)) return true
  const shortest = Math.min(key.length, pattern.length)
  return shortest >= 12 && (pattern.startsWith(key) || key.startsWith(pattern))
}

/** Best rule: highest priority (lowest number), then the longest, most specific pattern. */
export function matchRule(key: string, rules: Rule[]): Rule | null {
  let best: Rule | null = null
  for (const r of rules) {
    if (!keyMatches(key, r.pattern)) continue
    if (!best || r.priority < best.priority || (r.priority === best.priority && r.pattern.length > best.pattern.length)) best = r
  }
  return best
}

export interface HistoryRow { key: string; description: string; categoryId: number | null }

/**
 * Learns from the person's own past transactions: for each merchant key, the category used most often
 * (only if it covers at least 60% of that merchant's rows), and the most common clean name.
 */
export function buildHistoryRules(rows: HistoryRow[]): Rule[] {
  const byKey = new Map<string, HistoryRow[]>()
  for (const r of rows) {
    if (!r.key || r.categoryId === null) continue
    const list = byKey.get(r.key) ?? []
    list.push(r)
    byKey.set(r.key, list)
  }
  const rules: Rule[] = []
  for (const [key, list] of byKey) {
    const counts = new Map<number, number>()
    for (const r of list) counts.set(r.categoryId!, (counts.get(r.categoryId!) ?? 0) + 1)
    const [categoryId, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
    if (n / list.length < 0.6) continue
    const names = new Map<string, number>()
    for (const r of list) names.set(r.description, (names.get(r.description) ?? 0) + 1)
    const merchant = [...names.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    rules.push({ pattern: key, merchant, categoryId, priority: 60, source: 'history' })
  }
  return rules
}

const TAG_CATEGORY: Record<Tag, RegExp> = {
  dining: /dining|food|takeout|restaurant/i,
  groceries: /grocer/i,
  transport: /gas|transport|fuel/i,
  subscriptions: /subscri/i,
  health: /health|pharm|personal care/i,
  shopping: /shopping/i,
  fees: /fee|interest/i
}

/** Maps a built-in keyword tag to the person's own category with a fitting name, if they have one. */
export function categoryForTag(tag: Tag, categories: { id: number; name: string; kind: string }[]): number | null {
  const hit = categories.find((c) => c.kind === 'expense' && TAG_CATEGORY[tag].test(c.name))
  return hit ? hit.id : null
}
