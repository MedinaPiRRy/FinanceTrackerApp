// Renaming the people. The slug (what the workbook importer and files key on) never changes; only the name shown.
import type { Db } from './open'

export function renameProfile(db: Db, profileId: number, name: string): void {
  const p = db.prepare('SELECT id, kind FROM profile WHERE id = ?').get(profileId) as { id: number; kind: string } | undefined
  if (!p) throw new Error('That person no longer exists. Reload the page.')
  if (p.kind !== 'person') throw new Error('Only people can be renamed. The shared household keeps its name.')
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Enter a name')
  if (clean.length > 40) throw new Error('That name is too long (40 characters at most)')
  if (/^household$/i.test(clean)) throw new Error('"Household" is the name of the shared view. Choose another name.')
  if (db.prepare("SELECT 1 FROM profile WHERE kind = 'person' AND name = ? COLLATE NOCASE AND id <> ?").get(clean, profileId)) throw new Error(`Someone is already called "${clean}"`)
  db.prepare('UPDATE profile SET name = ? WHERE id = ?').run(clean, profileId)
}
