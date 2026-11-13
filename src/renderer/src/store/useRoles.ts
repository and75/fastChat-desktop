import { create } from 'zustand'
import { t } from '@shared/i18n'
import { GENERALIST_ROLE, type Role } from '@shared/roles'
import { GENERALIST_ROLE_ID, type Conversation, type RoleHealth, type RoleRecord } from '@shared/types'
import { useConversations } from './useConversations'
import { useChat } from './useChat'

interface RolesState {
  roles: RoleRecord[]
  /** Ruolo o basi mancanti, per conversazione (avviso non bloccante). */
  health: Record<string, RoleHealth>
  error: string | null
  refresh(): Promise<void>
  /** Sceglie un'opzione di un parametro: istruzioni e mente si aggiornano. */
  choose(conversationId: string, parameterId: string, value: string | string[]): Promise<void>
  /** Cambia il ruolo di una conversazione ancora vuota. */
  setRole(conversationId: string, roleId: string): Promise<boolean>
  checkHealth(conversationId: string): Promise<void>
}

const accept = (conv: Conversation): void => {
  useConversations.getState().upsertLocal(conv)
  useChat.getState().replaceConversation(conv)
}

export const useRoles = create<RolesState>((set, get) => ({
  roles: [],
  health: {},
  error: null,

  async refresh() {
    const res = await window.api.roles.list()
    if (res.ok) set({ roles: res.data, error: null })
    else set({ error: res.error })
  },

  async choose(conversationId, parameterId, value) {
    const res = await window.api.roles.choose(conversationId, parameterId, value)
    if (!res.ok) return set({ error: res.error })
    set({ error: null })
    accept(res.data)
  },

  async setRole(conversationId, roleId) {
    const res = await window.api.roles.set(conversationId, roleId)
    if (!res.ok) {
      set({ error: res.error })
      return false
    }
    set({ error: null })
    accept(res.data)
    void get().checkHealth(conversationId)
    return true
  },

  async checkHealth(conversationId) {
    const res = await window.api.roles.health(conversationId)
    if (res.ok) set((s) => ({ health: { ...s.health, [conversationId]: res.data } }))
  }
}))

/** Nome di un ruolo per l'interfaccia: il Generalista segue la lingua dell'app, gli altri sono scritti nella loro. */
export const roleName = (role: Pick<RoleRecord, 'id' | 'name'> | null | undefined): string =>
  !role || role.id === GENERALIST_ROLE_ID ? t('role.generalist') : role.name

export const roleDescription = (role: Pick<RoleRecord, 'id' | 'description'> | null | undefined): string =>
  !role || role.id === GENERALIST_ROLE_ID ? t('role.generalist.desc') : role.description

/** Il ruolo di una conversazione tra quelli installati; `null` se è il Generalista o se non c'è più. */
export function findRole(roles: RoleRecord[], conv: Pick<Conversation, 'roleId'> | null | undefined): RoleRecord | null {
  if (!conv?.roleId || conv.roleId === GENERALIST_ROLE_ID) return null
  return roles.find((r) => r.id === conv.roleId) ?? null
}

/** Definizione del ruolo di una conversazione: quella del Generalista se non ne ha uno suo (o non c'è più). */
export const definitionOf = (roles: RoleRecord[], conv: Pick<Conversation, 'roleId'> | null | undefined): Role => findRole(roles, conv)?.definition ?? GENERALIST_ROLE

/** Sigla della lingua accanto al nome, quando lo stesso ruolo è installato in più lingue. */
export function languageTag(roles: RoleRecord[], role: RoleRecord): string | null {
  if (!role.language || !role.group) return null
  return roles.some((r) => r.id !== role.id && r.group === role.group) ? role.language.toUpperCase() : null
}
