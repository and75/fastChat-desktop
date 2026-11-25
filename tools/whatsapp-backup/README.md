# Backup WhatsApp

App desktop (Electron, Windows) per fare una **copia locale sul PC** del database di WhatsApp dal
**tuo** telefono, collegato via **USB**. Supporta **iPhone** e **Android**. Pensata per il backup dei
propri messaggi: non installa né lascia software sul telefono.

> Usa questo strumento solo sui tuoi dispositivi e dati, o con l'esplicito consenso del proprietario.

## Cosa fa

- Copia il database delle chat (e, se vuoi, i media) in una cartella datata sul PC.
- Se fornisci la chiave di cifratura, **decifra** il database in un file SQLite leggibile.
- Crea un **export HTML** sfogliabile delle conversazioni (indice + una pagina per chat).

## «Nessuna traccia sul telefono»: cosa è davvero possibile

### iPhone (USB)
- I dati si leggono tramite il **servizio di backup ufficiale di Apple** (lo stesso di iTunes/Finder),
  pilotato via USB con `libimobiledevice`. Il backup è scritto **sul PC**; sul telefono **non si installa
  nulla**.
- Segni inevitabili lato device: il **pairing** («Autorizza questo computer») alla prima connessione.
- Il DB chat (`ChatStorage.sqlite`) sta nel container condiviso dell'app, incluso nel backup. Se sul
  telefono è **già attivo** il backup cifrato, serve la sua **password**; l'app **non cambia** quell'impostazione.
- Il backup grezzo resta sul PC (per aggiornamenti incrementali veloci); puoi non conservarlo.

### Android (USB)
- WhatsApp **disattiva `adb backup`**, e il database «vivo» in `/data/data` richiede **root**. Senza root e
  senza modificare il telefono, l'unica copia leggibile è il **backup cifrato che WhatsApp crea da sé** sulla
  memoria condivisa (`…/WhatsApp/Databases/msgstore.db.crypt15` + cartella `Media`): questi si copiano con
  `adb pull`, operazione di **sola lettura** sul device.
- L'unica modifica lato telefono è l'attivazione del **Debug USB** (la fai tu; è reversibile).
- Quei file sono cifrati. Per **decifrarli** serve la **chiave a 64 cifre** del backup crittografato
  end-to-end (WhatsApp → Impostazioni → Chat → Backup → Backup crittografato end-to-end → «Visualizza chiave»).
  Senza chiave l'app copia i file, ma restano illeggibili (la decifratura richiederebbe root, che lascia traccia:
  l'app non lo fa).

## Preparazione

1. **Node 22+** e, per impacchettare, Windows.
2. Metti i binari esterni in `resources/bin/win/` (vedi `resources/bin/README.md`):
   - **adb** (Android Platform-Tools) per Android;
   - **libimobiledevice** (`idevice_id`, `ideviceinfo`, `idevicebackup2` + DLL) per iPhone.
   - In alternativa, se sono già nel `PATH`, l'app li usa da lì.

## Comandi

```bash
npm install            # installa dipendenze e ricostruisce better-sqlite3 per Electron
npm start              # avvia l'app in sviluppo
npm test               # test (decifratura crypt15 + lettura dei tre schemi di DB + export)
npm run dist:win       # installer e versione portable per Windows in dist/
```

## Architettura

- `src/main/core/`
  - `plist.mjs` — lettura dei plist Apple (binari e XML).
  - `keybag.mjs` — cifratura dei backup iPhone (keybag, AES key unwrap, decifratura file).
  - `backup.mjs` — apertura del backup iPhone (`Manifest.db`) ed estrazione dei file di WhatsApp.
  - `idevice.mjs` — `libimobiledevice`: rileva l'iPhone, crea il backup via USB, estrae WhatsApp.
  - `crypt.mjs` — decifratura dei backup Android `.crypt15` (header protobuf, HKDF-SHA256, AES-256-GCM, zlib).
  - `android.mjs` — `adb`: rileva il telefono, elenca i backup, copia DB e media, decifra.
  - `export.mjs` — legge il DB (iOS / Android moderno / Android storico) ed esporta le chat in HTML.
  - `tools.mjs` — localizza i binari esterni (inclusi nell'app o nel `PATH`).
- `src/main/index.mjs` — processo principale Electron, IPC, orchestrazione.
- `src/preload/index.cjs` — ponte sicuro: espone solo `window.api`.
- `src/renderer/` — interfaccia (HTML/CSS/JS, senza framework).

## Note sul formato

La decifratura `.crypt15` segue il formato verificato sul progetto open source
[`ElDavoo/wa-crypt-tools`](https://github.com/ElDavoo/wa-crypt-tools): header `BackupPrefix` (protobuf),
IV in `e2ee_key_data.encryption_iv` (16 byte), chiave AES derivata con HKDF-SHA256
(salt = 32 zeri, info = `"backup encryption"`), payload AES-256-GCM compresso con zlib. La correttezza è
coperta da test di round-trip.
