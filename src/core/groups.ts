// The household view combines spending across two people who each named their categories differently.
// A "group" is the shared name: "Fast Food & Dining" and "Dining & Takeout" are both in the group "Dining".
// Groups are guessed from the category name and can be overridden per category (category.group_name).

const RULES: [RegExp, string][] = [
  [/wedding/i, 'Wedding'],
  [/dining|fast food|takeout|restaurant/i, 'Dining'],
  [/grocer|convenience|snack/i, 'Groceries'],
  [/gas\b|transport|fuel/i, 'Transportation'],
  [/subscri|online/i, 'Subscriptions'],
  [/shopping/i, 'Shopping'],
  [/health|personal care|beauty|therapy|dental|pharm/i, 'Health & personal care'],
  [/gym|fitness/i, 'Gym & fitness'],
  [/lesson|hobb/i, 'Lessons & hobbies'],
  [/entertain|nightlife|gaming|outing/i, 'Entertainment'],
  [/gambl/i, 'Gambling'],
  [/insurance|loan|admin/i, 'Insurance, loans & admin'],
  [/fee|interest/i, 'Bank fees & interest'],
  [/vape|cannabis|alcohol/i, 'Vapes, cannabis & alcohol'],
  [/travel/i, 'Travel'],
  [/e-?transfer|cash & other|payments? to/i, 'E-transfers & payments to people']
]

/** The group a category belongs to unless the user chose another. Unknown names are their own group. */
export function defaultGroup(categoryName: string): string {
  for (const [re, group] of RULES) if (re.test(categoryName)) return group
  return categoryName.trim()
}

export function groupOf(category: { name: string; groupName?: string | null }): string {
  const g = category.groupName?.trim()
  return g ? g : defaultGroup(category.name)
}
