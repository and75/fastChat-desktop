import type {
  AppSettings,
  BenchmarkProgress,
  MemoryStatus,
  ContextCall,
  KnowledgeDocument,
  KnowledgeProgress,
  KnowledgeSourceInfo,
  KnowledgeStatus,
  ModelSetting,
  ModelSettingPatch,
  PullProgress,
  BriefTemplate,
  Conversation,
  ConversationDetail,
  ConversationListQuery,
  ConversationPatch,
  ModelCapabilities,
  OllamaModel,
  Plan,
  PlanUpdate,
  Result,
  SendOptions,
  SendResult,
  StreamEvent
} from './types'
import type { SystemInfo } from './settings'

/** Variabili d'ambiente di Ollama per la sezione delle impostazioni. */
export interface OllamaEnvInfo {
  platform: string
  canApply: boolean
  values: Record<string, string | null>
  vars: Array<{ name: string; label: string; description: string; options: Array<{ value: string | null; label: string }> }>
}

/** Contratto di `window.api`, implementato dal preload. */
export interface Api {
  models: {
    list(): Promise<Result<OllamaModel[]>>
    capabilities(name: string): Promise<Result<ModelCapabilities>>
    /** Prova un URL di Ollama senza salvarlo: restituisce i modelli trovati. */
    check(url: string): Promise<Result<OllamaModel[]>>
    /** Configurazione di esecuzione (CPU/GPU) e risultati del test, per modello. */
    settings(): Promise<Result<ModelSetting[]>>
    setSetting(model: string, patch: ModelSettingPatch): Promise<Result<ModelSetting>>
    /** Scarica un modello; l'avanzamento arriva con onPullProgress. */
    pull(name: string): Promise<Result<void>>
    remove(name: string): Promise<Result<void>>
    /** Test CPU/GPU: prova le configurazioni, salva la più veloce e la restituisce. */
    benchmark(name: string): Promise<Result<ModelSetting>>
    onPullProgress(cb: (p: PullProgress) => void): () => void
    onBenchmarkProgress(cb: (p: BenchmarkProgress) => void): () => void
  }
  memory: {
    /** Stato della memoria della conversazione: pezzi indicizzati, da indicizzare, modello installato. */
    status(conversationId: string): Promise<Result<MemoryStatus>>
    /** Rifà l'indice da zero (es. dopo aver cambiato il modello di embedding). */
    rebuild(conversationId: string): Promise<Result<MemoryStatus>>
  }
  knowledge: {
    /** Plugin disponibili: etichette, estensioni lette, campi di configurazione. */
    sources(): Promise<Result<KnowledgeSourceInfo[]>>
    /** Documenti, connessioni, pezzi indicizzati e stato del modello di embedding. */
    status(conversationId: string): Promise<Result<KnowledgeStatus>>
    /** Aggiunge file per percorso (drag&drop): restituisce i documenti, indicizzati in sottofondo. */
    addFiles(conversationId: string, paths: string[]): Promise<Result<KnowledgeDocument[]>>
    /** Apre il dialog di scelta dei file e li aggiunge; null se annullato. */
    pickFiles(conversationId: string): Promise<Result<KnowledgeDocument[] | null>>
    remove(conversationId: string, documentId: string): Promise<Result<KnowledgeStatus>>
    /** Rifà l'indice di un documento (dopo un errore o un cambio di modello). */
    reindex(conversationId: string, documentId: string): Promise<Result<KnowledgeDocument>>
    /** Avanzamento dell'indicizzazione dei documenti. */
    onProgress(cb: (p: KnowledgeProgress) => void): () => void
    /** Percorso di un file trascinato nella finestra ('' se non è un file su disco). */
    pathForFile(file: File): string
  }
  context: {
    /** Ultime chiamate a Ollama della conversazione, dalla più recente. */
    calls(conversationId: string): Promise<Result<ContextCall[]>>
    onCall(cb: (call: ContextCall) => void): () => void
  }
  ollamaEnv: {
    /** Variabili d'ambiente di Ollama: valori attuali (Windows) e se l'app può applicarle da sola. */
    get(): Promise<Result<OllamaEnvInfo>>
    /** Su Windows salva e riavvia Ollama; altrove restituisce i comandi da copiare. */
    apply(values: Record<string, string | null>): Promise<Result<{ applied: boolean; restarted: boolean; commands: string }>>
  }
  system: {
    /** Lingua del sistema (o FASTCHAT_LANG), per la scelta «Automatica». */
    locale: string
    /** RAM e tipo di memoria della macchina, se Ollama gira qui: per il calcolo della memoria della conversazione. */
    info(): Promise<Result<SystemInfo>>
  }
  conversations: {
    list(query?: ConversationListQuery): Promise<Result<Conversation[]>>
    get(id: string): Promise<Result<ConversationDetail>>
    /** Nuova conversazione, vuota o con brief e impostazioni di un template. */
    create(fromTemplateId?: string): Promise<Result<Conversation>>
    update(id: string, patch: ConversationPatch): Promise<Result<Conversation>>
    /** Riporta temperatura, top_p e num_ctx ai valori suggeriti per modello e macchina. */
    calibrate(id: string): Promise<Result<Conversation>>
    /** Riassume subito i messaggi più vecchi (anche sotto la soglia automatica). */
    summarize(id: string): Promise<Result<Conversation>>
    remove(id: string): Promise<Result<void>>
    /** Chiede dove salvare e scrive il file; restituisce il percorso, o null se annullato. */
    export(id: string, format: 'md' | 'json'): Promise<Result<string | null>>
    /** Conversazioni modificate dal main (es. titolo generato automaticamente). */
    onUpdated(cb: (conversation: Conversation) => void): () => void
  }
  templates: {
    list(): Promise<Result<BriefTemplate[]>>
    /** Salva brief e impostazioni della conversazione come template. */
    create(conversationId: string, name: string): Promise<Result<BriefTemplate>>
    remove(id: string): Promise<Result<void>>
  }
  chat: {
    /** `options.knowledge`: scelta del bottone libro per questa domanda (assente = come la conversazione). */
    send(conversationId: string, text: string, options?: SendOptions): Promise<Result<SendResult>>
    regenerate(conversationId: string): Promise<Result<SendResult>>
    abort(streamId: string): Promise<Result<boolean>>
    /** Registra un listener per gli eventi di stream; restituisce la funzione per rimuoverlo. */
    onStream(cb: (event: StreamEvent) => void): () => void
  }
  plans: {
    /** Plan mode: salva il messaggio e avvia la proposta di un piano (evento 'done' con `plan`). */
    propose(conversationId: string, text: string, options?: SendOptions): Promise<Result<SendResult>>
    /** Nuovo piano per l'ultimo messaggio utente ancora senza risposta. */
    regenerate(conversationId: string): Promise<Result<SendResult>>
    update(planId: string, update: PlanUpdate): Promise<Result<Plan>>
    /** Approva (se serve) ed esegue il piano: la risposta arriva come un normale stream di chat. */
    execute(planId: string): Promise<Result<SendResult>>
  }
  /** Controlli della finestra (la barra del titolo di sistema non c'è). */
  window: {
    /** Piattaforma: su macOS i controlli sono i semafori nativi, altrove li disegna l'app. */
    platform: string
    minimize(): Promise<Result<void>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<void>>
    isMaximized(): Promise<Result<boolean>>
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
  clipboard: {
    /** Copia testo negli appunti di sistema (tramite il main: il renderer è in sandbox). */
    writeText(text: string): Promise<Result<void>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
}
