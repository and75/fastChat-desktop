import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { exportHtml, readChats } from '../src/main/core/export.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'wa-exp-'))
}

function iosDb() {
  const dir = tmp()
  const p = join(dir, 'ChatStorage.sqlite')
  const db = new Database(p)
  db.exec(`CREATE TABLE ZWACHATSESSION(Z_PK INTEGER PRIMARY KEY, ZPARTNERNAME TEXT, ZCONTACTJID TEXT, ZLASTMESSAGEDATE REAL);
           CREATE TABLE ZWAMESSAGE(Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMESSAGEDATE REAL, ZISFROMME INTEGER, ZTEXT TEXT, ZFROMJID TEXT, ZPUSHNAME TEXT);
           CREATE TABLE ZWAMEDIAITEM(Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH TEXT);`)
  db.prepare('INSERT INTO ZWACHATSESSION VALUES (1,?,?,?)').run('Mario', '39333@s.whatsapp.net', 700000000)
  db.prepare('INSERT INTO ZWAMESSAGE VALUES (1,1,?,0,?,?,?)').run(700000000, 'Ciao!', '39333@s.whatsapp.net', 'Mario')
  db.prepare('INSERT INTO ZWAMESSAGE VALUES (2,1,?,1,?,NULL,NULL)').run(700000100, 'Ciao Mario')
  db.prepare('INSERT INTO ZWAMESSAGE VALUES (3,1,?,0,NULL,?,?)').run(700000200, '39333@s.whatsapp.net', 'Mario')
  db.prepare('INSERT INTO ZWAMEDIAITEM VALUES (1,3,?)').run('Media/foto/IMG_1.jpg')
  db.close()
  return p
}

function androidDb() {
  const dir = tmp()
  const p = join(dir, 'msgstore.db')
  const db = new Database(p)
  db.exec(`CREATE TABLE jid(_id INTEGER PRIMARY KEY, raw_string TEXT);
           CREATE TABLE chat(_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT, sort_timestamp INTEGER);
           CREATE TABLE message(_id INTEGER PRIMARY KEY, chat_row_id INTEGER, sender_jid_row_id INTEGER, from_me INTEGER, timestamp INTEGER, text_data TEXT);`)
  db.prepare('INSERT INTO jid VALUES (1,?)').run('39333@s.whatsapp.net')
  db.prepare('INSERT INTO chat VALUES (1,1,NULL,?)').run(1700000000000)
  db.prepare('INSERT INTO message VALUES (1,1,1,0,?,?)').run(1700000000000, 'Ehi')
  db.prepare('INSERT INTO message VALUES (2,1,NULL,1,?,?)').run(1700000100000, 'Rispondo')
  db.close()
  return p
}

function legacyDb() {
  const dir = tmp()
  const p = join(dir, 'msgstore.db')
  const db = new Database(p)
  db.exec(`CREATE TABLE messages(_id INTEGER PRIMARY KEY, key_remote_jid TEXT, key_from_me INTEGER, data TEXT, timestamp INTEGER, remote_resource TEXT);`)
  db.prepare('INSERT INTO messages VALUES (1,?,0,?,?,NULL)').run('39333@s.whatsapp.net', 'Vecchio messaggio', 1500000000000)
  db.prepare('INSERT INTO messages VALUES (2,?,1,?,?,NULL)').run('39333@s.whatsapp.net', 'Risposta', 1500000100000)
  db.close()
  return p
}

test('iOS: legge chat, mittenti, date Apple e media', () => {
  const { schema, chats } = readChats(iosDb())
  assert.equal(schema, 'ios')
  assert.equal(chats.length, 1)
  assert.equal(chats[0].name, 'Mario')
  assert.equal(chats[0].messages.length, 3)
  assert.equal(chats[0].messages[0].text, 'Ciao!')
  assert.equal(chats[0].messages[1].fromMe, true)
  assert.equal(chats[0].messages[2].media, 'Media/foto/IMG_1.jpg')
  // data Apple → 2001-01-01 + 700000000 s
  assert.equal(chats[0].messages[0].ts.getUTCFullYear(), 2023)
})

test('Android moderno: message/chat/jid', () => {
  const { schema, chats } = readChats(androidDb())
  assert.equal(schema, 'android')
  assert.equal(chats[0].messages[0].text, 'Ehi')
  assert.equal(chats[0].messages[1].fromMe, true)
  assert.equal(chats[0].messages[0].ts.getUTCFullYear(), 2023)
})

test('Android storico: tabella messages', () => {
  const { schema, chats } = readChats(legacyDb())
  assert.equal(schema, 'android-legacy')
  assert.equal(chats[0].messages.length, 2)
  assert.equal(chats[0].messages[0].text, 'Vecchio messaggio')
})

test('export HTML: indice + una pagina per chat', async () => {
  const out = tmp()
  const res = await exportHtml(iosDb(), out, 'test')
  assert.equal(res.chats, 1)
  assert.equal(res.messages, 3)
  const index = readFileSync(join(out, 'index.html'), 'utf8')
  assert.match(index, /Mario/)
  const chat = readFileSync(join(out, 'chat-0.html'), 'utf8')
  assert.match(chat, /Ciao!/)
  assert.match(chat, /IMG_1\.jpg/)
})
