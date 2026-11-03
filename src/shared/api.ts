import type {
  AppSettings,
  Conversation,
  ConversationDetail,
  ConversationListQuery,
  ConversationPatch,
  ModelCapabilities,
  OllamaModel,
  Plan,
  PlanUpdate,
  Result,
  SendResult,
  StreamEvent
} from './types'

/** Contratto di `window.api`, implementato dal preload. */
export interface Api {
  models: {
    list(): Promise<Result<OllamaModel[]>>
    capabilities(name: string): Promise<Result<ModelCapabilities>>
  }
  conversations: {
    list(query?: ConversationListQuery): Promise<Result<Conversation[]>>
    get(id: string): Promise<Result<ConversationDetail>>
    create(): Promise<Result<Conversation>>
    update(id: string, patch: ConversationPatch): Promise<Result<Conversation>>
    remove(id: string): Promise<Result<void>>
  }
  chat: {
    send(conversationId: string, text: string): Promise<Result<SendResult>>
    regenerate(conversationId: string): Promise<Result<SendResult>>
    abort(streamId: string): Promise<Result<boolean>>
    /** Registra un listener per gli eventi di stream; restituisce la funzione per rimuoverlo. */
    onStream(cb: (event: StreamEvent) => void): () => void
  }
  plans: {
    /** Plan mode: salva il messaggio e avvia la proposta di un piano (evento 'done' con `plan`). */
    propose(conversationId: string, text: string): Promise<Result<SendResult>>
    /** Nuovo piano per l'ultimo messaggio utente ancora senza risposta. */
    regenerate(conversationId: string): Promise<Result<SendResult>>
    update(planId: string, update: PlanUpdate): Promise<Result<Plan>>
    /** Approva (se serve) ed esegue il piano: la risposta arriva come un normale stream di chat. */
    execute(planId: string): Promise<Result<SendResult>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
}
