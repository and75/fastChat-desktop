// Lingua dei testi che l'app scrive per il modello, per la durata di una chiamata (docs/ruoli.md §5.5).
// Più conversazioni possono generare insieme: la lingua viaggia con la catena asincrona della chiamata, non in
// una variabile globale.
import { AsyncLocalStorage } from 'node:async_hooks'
import { setPromptLocaleSource, toLocale, type Locale } from '@shared/i18n'

const storage = new AsyncLocalStorage<Locale | null>()
setPromptLocaleSource(() => storage.getStore())

/** Esegue `fn` scrivendo i testi per il modello nella lingua indicata; senza lingua valgono quelli dell'interfaccia. */
export function withPromptLanguage<T>(language: string | null | undefined, fn: () => T): T {
  return storage.run(toLocale(language), fn)
}
