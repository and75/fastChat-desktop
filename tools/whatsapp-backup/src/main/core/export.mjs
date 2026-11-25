// Lettura del database decifrato ed export delle chat in HTML leggibile.
// Supporta tre schemi: iOS (ChatStorage.sqlite), Android moderno (message/chat/jid) e Android storico (messages).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const APPLE_EPOCH = 978307200 // 2001-01-01 in secondi Unix

function tableSet(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  return new Set(rows.map((r) => r.name))
}

/** Riconosce lo schema del database. */
export function detectSchema(db) {
  const t = tableSet(db)
  if (t.has('ZWAMESSAGE') && t.has('ZWACHATSESSION')) return 'ios'
  if (t.has('message') && t.has('chat') && t.has('jid')) return 'android'
  if (t.has('messages')) return 'android-legacy'
  throw new Error('Database non riconosciuto: non sembra un archivio di WhatsApp.')
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

function jidName(raw) {
  if (!raw) return 'Sconosciuto'
  const user = raw.split('@')[0]
  if (raw.endsWith('@g.us')) return `Gruppo ${user}`
  return user
}

// --- lettura per schema: restituisce [{ id, name, messages: [{ ts, fromMe, sender, text, media }] }] ---

function readIos(db) {
  const chats = db
    .prepare('SELECT Z_PK AS id, ZPARTNERNAME AS name, ZCONTACTJID AS jid FROM ZWACHATSESSION ORDER BY ZLASTMESSAGEDATE DESC')
    .all()
  const stmt = db.prepare(
    `SELECT ZMESSAGEDATE AS ts, ZISFROMME AS fromMe, ZTEXT AS text, ZFROMJID AS fromJid, ZPUSHNAME AS pushName,
            (SELECT ZMEDIALOCALPATH FROM ZWAMEDIAITEM WHERE ZWAMEDIAITEM.ZMESSAGE = ZWAMESSAGE.Z_PK) AS media
     FROM ZWAMESSAGE WHERE ZCHATSESSION = ? ORDER BY ZMESSAGEDATE ASC`
  )
  return chats.map((c) => ({
    id: c.id,
    name: c.name || jidName(c.jid),
    messages: stmt.all(c.id).map((m) => ({
      ts: m.ts != null ? new Date((m.ts + APPLE_EPOCH) * 1000) : null,
      fromMe: !!m.fromMe,
      sender: m.fromMe ? 'Io' : m.pushName || c.name || jidName(c.jid),
      text: m.text,
      media: m.media
    }))
  }))
}

function readAndroid(db) {
  const chats = db
    .prepare(
      `SELECT chat._id AS id, jid.raw_string AS jid,
              COALESCE(NULLIF(chat.subject,''), jid.raw_string) AS name
       FROM chat JOIN jid ON jid._id = chat.jid_row_id
       ORDER BY chat.sort_timestamp DESC`
    )
    .all()
  // Il nome mostrato del mittente in un gruppo sta spesso in message_system / jid.
  const stmt = db.prepare(
    `SELECT m.timestamp AS ts, m.from_me AS fromMe, m.text_data AS text,
            sj.raw_string AS senderJid
     FROM message m
     LEFT JOIN jid sj ON sj._id = m.sender_jid_row_id
     WHERE m.chat_row_id = ? AND m.timestamp > 0
     ORDER BY m.timestamp ASC`
  )
  return chats.map((c) => ({
    id: c.id,
    name: c.name?.endsWith?.('@g.us') ? jidName(c.name) : c.name,
    messages: stmt.all(c.id).map((m) => ({
      ts: m.ts ? new Date(Number(m.ts)) : null,
      fromMe: !!m.fromMe,
      sender: m.fromMe ? 'Io' : jidName(m.senderJid || c.jid),
      text: m.text,
      media: null
    }))
  }))
}

function readAndroidLegacy(db) {
  const jids = db
    .prepare('SELECT DISTINCT key_remote_jid FROM messages WHERE key_remote_jid IS NOT NULL')
    .all()
    .map((r) => r.key_remote_jid)
  const stmt = db.prepare(
    `SELECT timestamp AS ts, key_from_me AS fromMe, data AS text, remote_resource AS sender
     FROM messages WHERE key_remote_jid = ? AND timestamp > 0 ORDER BY timestamp ASC`
  )
  return jids.map((jid) => ({
    id: jid,
    name: jidName(jid),
    messages: stmt.all(jid).map((m) => ({
      ts: m.ts ? new Date(Number(m.ts)) : null,
      fromMe: !!m.fromMe,
      sender: m.fromMe ? 'Io' : jidName(m.sender || jid),
      text: m.text,
      media: null
    }))
  }))
}

export function readChats(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const schema = detectSchema(db)
    const chats = schema === 'ios' ? readIos(db) : schema === 'android' ? readAndroid(db) : readAndroidLegacy(db)
    return { schema, chats: chats.filter((c) => c.messages.length > 0) }
  } finally {
    db.close()
  }
}

const fmtDate = (d) =>
  d ? d.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : ''

function chatHtml(chat) {
  const rows = chat.messages
    .map((m) => {
      const side = m.fromMe ? 'me' : 'them'
      const body = m.text ? esc(m.text) : m.media ? `📎 <em>${esc(m.media.split('/').pop())}</em>` : '<em>—</em>'
      return `<div class="msg ${side}"><div class="meta">${esc(m.sender)} · ${fmtDate(m.ts)}</div><div class="body">${body}</div></div>`
    })
    .join('\n')
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(chat.name)}</title><style>
:root{--bg:#efeae2;--me:#d9fdd3;--them:#fff;--ink:#111b21;--sub:#667781}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{position:sticky;top:0;background:#008069;color:#fff;padding:12px 16px;font-weight:600}
.wrap{max-width:820px;margin:0 auto;padding:16px}
.msg{max-width:75%;margin:6px 0;padding:6px 9px;border-radius:8px;box-shadow:0 1px 1px rgba(0,0,0,.1);word-wrap:break-word;white-space:pre-wrap}
.me{background:var(--me);margin-left:auto}.them{background:var(--them)}
.meta{font-size:12px;color:var(--sub);margin-bottom:2px}
a.back{color:#fff;text-decoration:none}
</style></head><body>
<header><a class="back" href="index.html">← Chat</a> &nbsp; ${esc(chat.name)}</header>
<div class="wrap">${rows}</div></body></html>`
}

function indexHtml(chats, meta) {
  const items = chats
    .map(
      (c, i) =>
        `<li><a href="chat-${i}.html">${esc(c.name)}</a> <span class="n">${c.messages.length} messaggi</span></li>`
    )
    .join('\n')
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backup WhatsApp</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f7f7f5;color:#111b21}
header{background:#008069;color:#fff;padding:16px}
.wrap{max-width:820px;margin:0 auto;padding:16px}
ul{list-style:none;padding:0}li{padding:10px 12px;border-bottom:1px solid #e9e9e6;background:#fff}
li:first-child{border-radius:8px 8px 0 0}li:last-child{border-radius:0 0 8px 8px}
a{color:#027eb5;text-decoration:none;font-weight:600}.n{color:#667781;font-size:13px;float:right}
.meta{color:#667781;font-size:13px;margin:8px 0 16px}
</style></head><body>
<header><strong>Backup WhatsApp</strong></header>
<div class="wrap">
<div class="meta">${esc(meta)} · ${chats.length} chat</div>
<ul>${items}</ul></div></body></html>`
}

/** Scrive l'export HTML (indice + una pagina per chat) in `outDir`. */
export async function exportHtml(dbPath, outDir, meta = '') {
  const { schema, chats } = readChats(dbPath)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), indexHtml(chats, meta || schema))
  await Promise.all(chats.map((c, i) => writeFile(join(outDir, `chat-${i}.html`), chatHtml(c))))
  const messages = chats.reduce((n, c) => n + c.messages.length, 0)
  return { schema, chats: chats.length, messages, indexPath: join(outDir, 'index.html') }
}
