import initSqlJs from "sql.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, ".data");
const DB_PATH = path.join(DB_DIR, "whatsapp.db");

fs.mkdirSync(DB_DIR, { recursive: true });

let db = null;
let saveTimer = null;

// ── Init ────────────────────────────────────────────────────────────────

export async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing DB from disk or create new
  try {
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
  } catch {
    db = new SQL.Database();
  }

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_id     TEXT,
      chat_jid        TEXT NOT NULL,
      sender_jid      TEXT,
      sender_phone    TEXT,
      sender_name     TEXT,
      body            TEXT,
      media_type      TEXT,
      media_path      TEXT,
      is_group        INTEGER NOT NULL DEFAULT 0,
      group_name      TEXT,
      from_me         INTEGER NOT NULL DEFAULT 0,
      timestamp       INTEGER NOT NULL,
      is_read         INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Create indexes (ignore if exist)
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC)`); } catch {}
  try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa ON messages(whatsapp_id, chat_jid)`); } catch {}

  // Migration: Add media_path if it doesn't exist
  try {
    db.run(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
  } catch (err) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      jid         TEXT PRIMARY KEY,
      phone       TEXT,
      name        TEXT,
      updated_at  INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lid_mappings (
      lid         TEXT PRIMARY KEY,
      phone       TEXT NOT NULL,
      updated_at  INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      is_community  INTEGER NOT NULL DEFAULT 0,
      parent_jid    TEXT,
      parent_name   TEXT,
      display_name  TEXT,
      updated_at    INTEGER
    )
  `);

  // Auto-save to disk periodically
  scheduleFlush();
  return db;
}

function scheduleFlush() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushToDisk, 5000);
}

function flushToDisk() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (err) {
    console.error("Failed to flush DB:", err.message);
  }
  scheduleFlush();
}

function flushNow() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch {}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function queryAll(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = {}) {
  const rows = queryAll(sql, params);
  return rows[0] ?? null;
}

function runSql(sql, params = {}) {
  db.run(sql, params);
  scheduleFlush();
}

// ── Public API ──────────────────────────────────────────────────────────

export function insertMessage(msg) {
  try {
    runSql(
      `INSERT OR IGNORE INTO messages
        (whatsapp_id, chat_jid, sender_jid, sender_phone, sender_name, body, media_type, media_path, is_group, group_name, from_me, timestamp, is_read)
       VALUES
        ($whatsappId, $chatJid, $senderJid, $senderPhone, $senderName, $body, $mediaType, $mediaPath, $isGroup, $groupName, $fromMe, $timestamp, $isRead)`,
      {
        $whatsappId: msg.whatsappId ?? null,
        $chatJid: msg.chatJid,
        $senderJid: msg.senderJid ?? null,
        $senderPhone: msg.senderPhone ?? null,
        $senderName: msg.senderName ?? null,
        $body: msg.body ?? null,
        $mediaType: msg.mediaType ?? null,
        $mediaPath: msg.mediaPath ?? null,
        $isGroup: msg.isGroup ? 1 : 0,
        $groupName: msg.groupName ?? null,
        $fromMe: msg.fromMe ? 1 : 0,
        $timestamp: msg.timestamp ?? Date.now(),
        $isRead: msg.isRead ? 1 : 0,
      }
    );
  } catch (err) {
    // Duplicate key is fine (OR IGNORE)
    if (!err.message?.includes("UNIQUE")) {
      console.error("Insert message error:", err.message);
    }
  }
}

export function getChats() {
  return queryAll(`
    SELECT
      m.chat_jid       AS chatJid,
      m.is_group        AS isGroup,
      COALESCE(g.display_name, g.name, m.group_name) AS groupName,
      g.is_community   AS isCommunity,
      m.sender_name     AS lastSenderName,
      m.sender_phone    AS lastSenderPhone,
      m.body            AS lastBody,
      m.media_type      AS lastMediaType,
      m.media_path      AS lastMediaPath,
      m.timestamp       AS lastTimestamp,
      m.from_me         AS lastFromMe,
      (SELECT COUNT(*) FROM messages m2 WHERE m2.chat_jid = m.chat_jid AND m2.is_read = 0 AND m2.from_me = 0) AS unreadCount,
      CASE
        WHEN m.is_group = 1 THEN COALESCE(g.display_name, g.name, m.group_name)
        ELSE COALESCE(c.name, m.sender_name)
      END AS displayName,
      COALESCE(c.phone, m.sender_phone) AS displayPhone
    FROM messages m
    LEFT JOIN contacts c ON (m.is_group = 0 AND c.jid = m.chat_jid)
    LEFT JOIN groups g ON (m.is_group = 1 AND g.jid = m.chat_jid)
    WHERE m.id = (
      SELECT MAX(m3.id) FROM messages m3 WHERE m3.chat_jid = m.chat_jid
    )
    ORDER BY m.timestamp DESC
  `);
}

export function getMessages(chatJid, limit = 100, offset = 0) {
  return queryAll(
    `SELECT
      id, whatsapp_id AS whatsappId, chat_jid AS chatJid,
      sender_jid AS senderJid, sender_phone AS senderPhone, sender_name AS senderName,
      body, media_type AS mediaType, media_path AS mediaPath, is_group AS isGroup, group_name AS groupName,
      from_me AS fromMe, timestamp, is_read AS isRead
    FROM messages
    WHERE chat_jid = $chatJid
    ORDER BY timestamp ASC
    LIMIT $limit OFFSET $offset`,
    { $chatJid: chatJid, $limit: limit, $offset: offset }
  );
}

export function markChatRead(chatJid) {
  runSql(`UPDATE messages SET is_read = 1 WHERE chat_jid = $chatJid AND is_read = 0 AND from_me = 0`, { $chatJid: chatJid });
}

export function upsertContact(jid, phone, name) {
  runSql(
    `INSERT INTO contacts (jid, phone, name, updated_at) VALUES ($jid, $phone, $name, $now)
     ON CONFLICT(jid) DO UPDATE SET
       phone = COALESCE($phone, contacts.phone),
       name = COALESCE($name, contacts.name),
       updated_at = $now`,
    { $jid: jid, $phone: phone ?? null, $name: name ?? null, $now: Date.now() }
  );
}

export function getContacts() {
  return queryAll(`SELECT * FROM contacts ORDER BY name ASC`);
}

export function upsertLidMapping(lid, phone) {
  runSql(
    `INSERT INTO lid_mappings (lid, phone, updated_at) VALUES ($lid, $phone, $now)
     ON CONFLICT(lid) DO UPDATE SET phone = $phone, updated_at = $now`,
    { $lid: lid, $phone: phone, $now: Date.now() }
  );
}

export function getLidMapping(lid) {
  const row = queryOne(`SELECT phone FROM lid_mappings WHERE lid = $lid`, { $lid: lid });
  return row?.phone ?? null;
}

export function getMessageCount(chatJid) {
  const row = queryOne(`SELECT COUNT(*) AS count FROM messages WHERE chat_jid = $chatJid`, { $chatJid: chatJid });
  return row?.count ?? 0;
}

export function upsertGroup(jid, name, isCommunity, parentJid, parentName) {
  const displayName = parentName && name ? `${parentName} › ${name}` : name;
  runSql(
    `INSERT INTO groups (jid, name, is_community, parent_jid, parent_name, display_name, updated_at)
     VALUES ($jid, $name, $isCommunity, $parentJid, $parentName, $displayName, $now)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE($name, groups.name),
       is_community = $isCommunity,
       parent_jid = COALESCE($parentJid, groups.parent_jid),
       parent_name = COALESCE($parentName, groups.parent_name),
       display_name = COALESCE($displayName, groups.display_name),
       updated_at = $now`,
    { $jid: jid, $name: name ?? null, $isCommunity: isCommunity ? 1 : 0, $parentJid: parentJid ?? null, $parentName: parentName ?? null, $displayName: displayName ?? null, $now: Date.now() }
  );
}

export function getGroup(jid) {
  return queryOne(`SELECT jid, name, is_community AS isCommunity, parent_jid AS parentJid, parent_name AS parentName, display_name AS displayName FROM groups WHERE jid = $jid`, { $jid: jid });
}

// Flush on exit
process.on("exit", flushNow);
process.on("SIGINT", () => { flushNow(); process.exit(); });
process.on("SIGTERM", () => { flushNow(); process.exit(); });

export default { initDatabase };
