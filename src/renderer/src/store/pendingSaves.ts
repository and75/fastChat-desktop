/**
 * Salvataggi con debounce ancora in sospeso (impostazioni del modello, brief).
 * Prima di inviare un messaggio vanno scritti tutti, altrimenti il main userebbe i valori vecchi:
 * chi cambia un'impostazione e invia subito deve vedere applicata la nuova.
 */
const flushers = new Set<() => Promise<void>>()

/** Registra la funzione che scrive i propri salvataggi in sospeso; restituisce la funzione per rimuoverla. */
export function registerPendingSave(flush: () => Promise<void>): () => void {
  flushers.add(flush)
  return () => {
    flushers.delete(flush)
  }
}

export async function flushPendingSaves(): Promise<void> {
  await Promise.all([...flushers].map((f) => f().catch(() => undefined)))
}
