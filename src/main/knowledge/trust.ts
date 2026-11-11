// Chiavi pubbliche riconosciute per i pacchetti (.fcpack): un pacchetto firmato con una di queste è «verificato».
// Le chiavi private restano a chi pubblica e non stanno mai nel repository. Per aggiungerne una:
//   node scripts/pack-keys.mjs            genera una coppia Ed25519 e stampa la chiave pubblica
// e si incolla qui la chiave pubblica con il suo id. Finché l'elenco è vuoto, ogni pacchetto importato è
// «non firmato» o «firma sconosciuta» e richiede la conferma dell'utente; quelli integrati nell'app sono fidati.
import type { TrustedKeys } from './pack'

export const TRUSTED_KEYS: TrustedKeys = {}
