// Il ruolo nella vita di una conversazione (docs/ruoli-piano.md, passo 2.5): creazione con un ruolo, cambio a
// conversazione vuota, scelta delle opzioni, ritocchi manuali alla mente, riassunto portato in una nuova
// conversazione. La mente effettiva resta scritta nelle impostazioni della conversazione, come sempre: qui si
// decide quando il ruolo la riscrive.
import { transcriptChunks } from '@shared/prompt'
import { governedSettings, MIND_FIELDS, mindPatch, releaseOverrides, resolveChoices, withManualOverrides, type Role } from '@shared/roles'
import { t } from '@shared/i18n'
import { GENERALIST_ROLE_ID, type Conversation, type ConversationPatch } from '@shared/types'
import type { Db } from './db/client'
import {
  conversationFromTemplate,
  createConversation,
  getConversation,
  getRole,
  getTemplate,
  listLinkedBases,
  listMessages,
  roleOf,
  unlinkBase,
  updateConversation
} from './db/repo'
import type { Knowledge } from './knowledge'
import { withPromptLanguage } from './promptLocale'

export interface RoleSessionDeps {
  db: Db
  knowledge: Pick<Knowledge, 'linkDefaults' | 'linkRole'>
  /** Valori suggeriti per un modello su questa macchina (temperatura, top_p, memoria); {} se Ollama non risponde. */
  suggest(model: string): Promise<ConversationPatch>
  /** Modello per una nuova conversazione senza altre indicazioni. */
  initialModel(): Promise<string>
  /** Il modello è installato in Ollama? */
  modelInstalled(model: string): Promise<boolean>
  /** Aggiorna il riassunto di una conversazione (anche sotto la soglia). Può fallire: si prosegue senza. */
  summarize?(conversationId: string): Promise<unknown>
}

export interface CreateOptions {
  templateId?: string
  roleId?: string
  /** Conversazione di cui portare il riassunto (cambio di ruolo a conversazione avviata). */
  carryFrom?: string
}

/** Quanto testo della conversazione precedente si porta al massimo, oltre al suo riassunto. */
const CARRY_TAIL_CHARS = 2400

const FALLBACKS = { think: false, planMode: false, style: 'normal' } as const

export function createRoleSession({ db, knowledge, suggest, initialModel, modelInstalled, summarize }: RoleSessionDeps) {
  /** Il modello consigliato dal ruolo, se è installato; altrimenti quello indicato. */
  async function modelFor(role: Role, fallback: string): Promise<string> {
    const wanted = role.mind?.model
    return wanted && (await modelInstalled(wanted).catch(() => false)) ? wanted : fallback
  }

  /**
   * Riassunto da portare in una nuova conversazione: quello della precedente, aggiornato, più gli ultimi
   * messaggi che il riassunto non copre (entro un tetto). null se la precedente è vuota.
   */
  async function carriedSummary(conversationId: string): Promise<string | null> {
    await summarize?.(conversationId).catch(() => undefined)
    const prev = await getConversation(db, conversationId)
    if (!prev) return null
    const history = await listMessages(db, conversationId)
    const from = prev.summary && prev.summaryUpTo ? history.findIndex((m) => m.id === prev.summaryUpTo) + 1 : 0
    const covered = prev.summary && (from > 0 || !prev.summaryUpTo) ? prev.summary.trim() : ''
    // Il testo è per il modello: nella lingua del ruolo della conversazione precedente, come il suo riassunto.
    const tail = withPromptLanguage((await roleOf(db, prev)).language, () => transcriptChunks(history.slice(from), CARRY_TAIL_CHARS).at(-1) ?? '')
    const text = [covered, tail].filter(Boolean).join('\n\n')
    return text || null
  }

  /** Nuova conversazione: vuota (Generalista), da un template, o con un ruolo; può partire dal riassunto di un'altra. */
  async function create(options: CreateOptions = {}): Promise<Conversation> {
    const model = await initialModel()
    let init: ConversationPatch = { model }
    if (options.templateId) {
      const template = await getTemplate(db, options.templateId)
      if (!template) throw new Error(t('err.templateNotFound'))
      init = conversationFromTemplate(template, model)
    } else if (options.roleId && options.roleId !== GENERALIST_ROLE_ID) {
      const role = await getRole(db, options.roleId)
      if (!role) throw new Error(t('err.role.notFound'))
      init = { model: await modelFor(role.definition, model), roleId: role.id }
    }
    if (options.carryFrom) {
      const summary = await carriedSummary(options.carryFrom)
      if (summary) init.summary = summary
    }
    const conv = await createConversation(db, init)
    const { definition } = await roleOf(db, conv)
    // Valori suggeriti per il modello, poi la mente del ruolo; ciò che il template ha salvato vince su entrambi.
    const saved: ConversationPatch = {}
    for (const key of MIND_FIELDS) if (init[key] !== undefined) Object.assign(saved, { [key]: init[key] })
    const patch = { ...(await suggest(conv.model)), ...mindPatch(definition, { choices: conv.roleParams, model: conv.model, overrides: conv.mindOverrides }), ...saved }
    // Le basi segnate «collega alle nuove conversazioni» arrivano già collegate; quelle del ruolo, con il loro tipo.
    await knowledge.linkDefaults(conv).catch(() => undefined)
    await knowledge.linkRole(conv).catch(() => undefined)
    return Object.keys(patch).length ? updateConversation(db, conv.id, patch) : conv
  }

  /** Cambia il ruolo di una conversazione ancora vuota (D23). Scelte e ritocchi ripartono da quelli del nuovo ruolo. */
  async function setRole(conversationId: string, roleId: string): Promise<Conversation> {
    const conv = await getConversation(db, conversationId)
    if (!conv) throw new Error(t('err.convNotFound'))
    if ((await listMessages(db, conv.id)).length > 0) throw new Error(t('err.role.started'))
    const next = roleId === GENERALIST_ROLE_ID ? null : await getRole(db, roleId)
    if (roleId !== GENERALIST_ROLE_ID && !next) throw new Error(t('err.role.notFound'))
    const previous = (await roleOf(db, conv)).definition
    const definition = next?.definition ?? {}
    const model = await modelFor(definition, conv.model)
    // Le basi del ruolo precedente se ne vanno con lui, salvo quelle che anche il nuovo richiede.
    const keep = new Set((definition.bases ?? []).map((b) => b.id))
    const gone = new Set((previous.bases ?? []).map((b) => b.id).filter((id) => !keep.has(id)))
    for (const base of await listLinkedBases(db, conv.id)) if (base.packageId && gone.has(base.packageId)) await unlinkBase(db, conv.id, base.id)
    const patch: ConversationPatch = {
      // Si riparte dai valori suggeriti e dai predefiniti: nulla del ruolo precedente resta nella mente.
      ...FALLBACKS,
      ...(await suggest(model)),
      ...mindPatch(definition, { model }),
      model,
      roleId: next?.id ?? GENERALIST_ROLE_ID,
      roleParams: null,
      mindOverrides: null
    }
    const updated = await updateConversation(db, conv.id, patch)
    await knowledge.linkRole(updated).catch(() => undefined)
    return updated
  }

  /**
   * L'utente sceglie un'opzione di un parametro del ruolo. «Vince l'ultima azione»: i ritocchi manuali sulle
   * impostazioni che quel parametro governa decadono, e la mente si ricalcola. Un'impostazione che nessuno
   * fissa più torna al valore suggerito per il modello.
   */
  async function choose(conversationId: string, parameterId: string, value: unknown): Promise<Conversation> {
    const conv = await getConversation(db, conversationId)
    if (!conv) throw new Error(t('err.convNotFound'))
    const { definition } = await roleOf(db, conv)
    const parameter = (definition.parameters ?? []).find((p) => p.id === parameterId)
    if (!parameter) throw new Error(t('err.role.parameter'))
    const ids = parameter.options.map((o) => o.id)
    const valid = parameter.type === 'multi' ? Array.isArray(value) && value.every((v) => typeof v === 'string' && ids.includes(v)) : typeof value === 'string' && ids.includes(value)
    if (!valid) throw new Error(t('err.role.option'))
    const choices = resolveChoices(definition, { ...resolveChoices(definition, conv.roleParams), [parameterId]: value as string | string[] })
    const overrides = releaseOverrides(definition, conv.mindOverrides, parameterId)
    const mind = mindPatch(definition, { choices, model: conv.model, overrides })
    const patch: ConversationPatch = { ...mind, roleParams: choices, mindOverrides: overrides }
    const unset = governedSettings(definition, parameterId).filter((key) => mind[key] === undefined)
    if (unset.length) {
      const suggested = await suggest(conv.model)
      for (const key of unset) Object.assign(patch, { [key]: key in FALLBACKS ? FALLBACKS[key as keyof typeof FALLBACKS] : (suggested[key] ?? null) })
    }
    return updateConversation(db, conv.id, patch)
  }

  /**
   * Un aggiornamento che arriva dall'interfaccia. Per una conversazione con un ruolo: i valori della mente
   * toccati a mano si registrano come ritocchi (valgono finché non cambia l'opzione che li governa); al cambio
   * di modello valgono i valori suggeriti per il nuovo modello, poi la mente del ruolo con il suo profilo.
   */
  async function update(conversationId: string, patch: ConversationPatch): Promise<Conversation> {
    const current = await getConversation(db, conversationId)
    if (!current) return updateConversation(db, conversationId, patch)
    const { definition } = await roleOf(db, current)
    const hasRole = !!current.roleId && current.roleId !== GENERALIST_ROLE_ID
    let next = { ...patch }
    const manual = MIND_FIELDS.some((key) => patch[key] !== undefined)
    const overrides = hasRole && manual && patch.mindOverrides === undefined ? withManualOverrides(current.mindOverrides, patch) : current.mindOverrides
    if (hasRole && manual && patch.mindOverrides === undefined) next.mindOverrides = overrides
    if (typeof patch.model === 'string' && current.model !== patch.model) {
      next = { ...(await suggest(patch.model)), ...mindPatch(definition, { choices: current.roleParams, model: patch.model, overrides }), ...next }
    }
    return updateConversation(db, conversationId, next)
  }

  /** «Tutti i valori suggeriti»: temperatura, top_p e memoria tornano a quelli del modello, o del ruolo se li fissa. */
  async function calibrate(conversationId: string): Promise<Conversation> {
    const conv = await getConversation(db, conversationId)
    if (!conv) throw new Error(t('err.convNotFound'))
    const fill = await suggest(conv.model)
    if (!Object.keys(fill).length) throw new Error(t('err.calibrateNoOllama'))
    const { definition } = await roleOf(db, conv)
    const overrides = { ...(conv.mindOverrides ?? {}) }
    for (const key of ['temperature', 'topP', 'numCtx'] as const) delete overrides[key]
    const mind = mindPatch(definition, { choices: conv.roleParams, model: conv.model, overrides })
    const fromRole: ConversationPatch = {}
    for (const key of ['temperature', 'topP', 'numCtx'] as const) if (mind[key] !== undefined) Object.assign(fromRole, { [key]: mind[key] })
    return updateConversation(db, conv.id, { ...fill, ...fromRole, ...(conv.mindOverrides ? { mindOverrides: overrides } : {}) })
  }

  return { create, setRole, choose, update, calibrate, carriedSummary }
}

export type RoleSession = ReturnType<typeof createRoleSession>
