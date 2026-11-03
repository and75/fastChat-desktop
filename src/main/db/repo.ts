import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { Db } from './client'
import { settings } from './schema'

// Fase 1: solo impostazioni. Conversazioni, messaggi, piani e template arrivano nelle fasi successive.

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]

export async function getSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select().from(settings)
  const out: AppSettings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if ((SETTING_KEYS as string[]).includes(row.key)) {
      ;(out as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  return out
}

export async function setSettings(db: Db, patch: Partial<AppSettings>): Promise<AppSettings> {
  const entries = Object.entries(patch).filter(([k, v]) => (SETTING_KEYS as string[]).includes(k) && v !== undefined)
  for (const [key, value] of entries) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
  }
  return getSettings(db)
}
