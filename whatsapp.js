import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidGroup,
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  insertMessage,
  upsertContact,
  upsertLidMapping,
  getLidMapping,
  markChatRead,
  upsertGroup,
  getGroup,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, ".data", "auth");
const LID_DIR = path.join(__dirname, ".data", "lid-cache");

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(LID_DIR, { recursive: true });

// ── State ───────────────────────────────────────────────────────────────

let sock = null;
let connectionStatus = "disconnected"; // disconnected | connecting | open | qr
let currentQr = null;
let currentQrDataUrl = null;
let selfJid = null;
let selfPhone = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let wsBroadcast = null; // set by server.js
let lidLookup = null;

const MAX_RECONNECT_ATTEMPTS = 15;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_FACTOR = 1.8;

const logger = pino({ level: "silent" });

// ── JID Resolution ──────────────────────────────────────────────────────

function normalizeE164(number) {
  const cleaned = number.replace(/^whatsapp:/i, "").trim();
  const digits = cleaned.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

function jidToE164(jid) {
  if (!jid) return null;
  // Standard user JID: 1234567890:0@s.whatsapp.net → +1234567890
  const match = jid.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (match) return `+${match[1]}`;

  // LID format: check disk cache first, then DB
  const lidMatch = jid.match(/^(\d+)(?::\d+)?@lid$/);
  if (lidMatch) {
    const lid = lidMatch[1];
    // Check DB
    const dbPhone = getLidMapping(lid);
    if (dbPhone) return dbPhone;
    // Check disk cache
    const filePath = path.join(LID_DIR, `lid-${lid}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data) {
        upsertLidMapping(lid, normalizeE164(String(data)));
        return normalizeE164(String(data));
      }
    } catch { /* not cached */ }
  }
  return null;
}

async function resolveJidToE164(jid) {
  if (!jid) return null;
  const direct = jidToE164(jid);
  if (direct) return direct;

  // Try runtime LID lookup via Baileys signal repository
  if (/@lid$/.test(jid) && lidLookup?.getPNForLID) {
    try {
      const pnJid = await lidLookup.getPNForLID(jid);
      if (pnJid) {
        const phone = jidToE164(pnJid);
        if (phone) {
          // Persist the mapping
          const lid = jid.match(/^(\d+)/)?.[1];
          if (lid) {
            upsertLidMapping(lid, phone);
            const filePath = path.join(LID_DIR, `lid-${lid}.json`);
            fs.writeFileSync(filePath, JSON.stringify(phone));
          }
          return phone;
        }
      }
    } catch { /* lookup failed */ }
  }
  return null;
}

export function toWhatsappJid(number) {
  const cleaned = number.replace(/^whatsapp:/i, "").trim();
  if (cleaned.includes("@")) return cleaned;
  const digits = cleaned.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function isGroupJid(jid) {
  return jid?.toLowerCase().endsWith("@g.us") ?? false;
}

function shouldIgnore(jid) {
  if (!jid) return true;
  return jid.endsWith("@status") || jid.endsWith("@broadcast");
}

// ── Message Extraction ──────────────────────────────────────────────────

function extractText(rawMessage) {
  if (!rawMessage) return undefined;
  const message = normalizeMessageContent(rawMessage);
  if (!message) return undefined;

  if (message.conversation?.trim()) return message.conversation.trim();
  if (message.extendedTextMessage?.text?.trim()) return message.extendedTextMessage.text.trim();

  const caption =
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption;
  if (caption?.trim()) return caption.trim();

  return undefined;
}

function extractMediaType(rawMessage) {
  const message = normalizeMessageContent(rawMessage);
  if (!message) return null;
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  return null;
}

// ── Group Metadata Cache ────────────────────────────────────────────────

const groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

async function getGroupMeta(jid) {
  const cached = groupCache.get(jid);
  if (cached && cached.expires > Date.now()) return cached.data;

  // Try DB first for instant lookups
  const dbGroup = getGroup(jid);

  try {
    const meta = await sock.groupMetadata(jid);
    const name = meta.subject ?? undefined;
    const participants = meta.participants?.map((p) => p.id) ?? [];

    // Detect community sub-groups via linkedParent
    let isCommunity = false;
    let parentJid = null;
    let parentName = null;
    let displayName = name;

    if (meta.linkedParent) {
      // This is a community sub-group (General, Announcement, etc.)
      isCommunity = true;
      parentJid = meta.linkedParent;
      try {
        const parentMeta = await sock.groupMetadata(meta.linkedParent);
        parentName = parentMeta.subject ?? null;
        if (parentName && name) {
          displayName = `${parentName} \u203a ${name}`;
        }
      } catch {
        // Couldn't fetch parent — use whatever we have in DB
        if (dbGroup?.parentName && name) {
          parentName = dbGroup.parentName;
          displayName = `${parentName} \u203a ${name}`;
        }
      }
    } else if (meta.isCommunity || meta.isCommunityAnnounce) {
      // This IS the parent community itself
      isCommunity = true;
      displayName = name;
    }

    // Persist to DB
    upsertGroup(jid, name, isCommunity, parentJid, parentName);

    const data = {
      subject: name,
      displayName: displayName ?? name,
      participants,
      isCommunity,
      parentJid,
      parentName,
    };
    groupCache.set(jid, { data, expires: Date.now() + GROUP_CACHE_TTL });
    return data;
  } catch {
    // Couldn't fetch from Baileys — fall back to DB cache
    if (dbGroup) {
      const data = {
        subject: dbGroup.name,
        displayName: dbGroup.displayName ?? dbGroup.name,
        participants: [],
        isCommunity: Boolean(dbGroup.isCommunity),
        parentJid: dbGroup.parentJid,
        parentName: dbGroup.parentName,
      };
      groupCache.set(jid, { data, expires: Date.now() + GROUP_CACHE_TTL });
      return data;
    }
    return { subject: undefined, displayName: undefined, participants: [], isCommunity: false };
  }
}

// ── Deduplication ───────────────────────────────────────────────────────

const recentIds = new Map();
const DEDUP_TTL = 60_000;

function isDuplicate(chatJid, messageId) {
  const key = `${chatJid}:${messageId}`;
  if (recentIds.has(key)) return true;
  recentIds.set(key, Date.now());
  // Cleanup old entries periodically
  if (recentIds.size > 500) {
    const now = Date.now();
    for (const [k, ts] of recentIds) {
      if (now - ts > DEDUP_TTL) recentIds.delete(k);
    }
  }
  return false;
}

// ── Inbound Message Handler ─────────────────────────────────────────────

async function handleMessagesUpsert(upsert) {
  if (upsert.type !== "notify" && upsert.type !== "append") return;

  for (const msg of upsert.messages ?? []) {
    try {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || shouldIgnore(remoteJid)) continue;

      const messageId = msg.key?.id;
      if (messageId && isDuplicate(remoteJid, messageId)) continue;

      const isGroup = isJidGroup(remoteJid) === true;
      const fromMe = Boolean(msg.key?.fromMe);
      const timestamp = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now();

      // Sender identification
      let senderJid, senderPhone;
      if (isGroup) {
        senderJid = msg.key?.participant ?? undefined;
        senderPhone = senderJid ? await resolveJidToE164(senderJid) : null;
      } else {
        senderJid = remoteJid;
        senderPhone = fromMe ? selfPhone : await resolveJidToE164(remoteJid);
      }

      const senderName = msg.pushName ?? undefined;
      const body = extractText(msg.message) ?? (extractMediaType(msg.message) ? `[${extractMediaType(msg.message)}]` : null);
      const mediaType = extractMediaType(msg.message);

      if (!body && !mediaType) continue;

      // Group metadata
      let groupName = null;
      if (isGroup) {
        const meta = await getGroupMeta(remoteJid);
        groupName = meta.displayName ?? meta.subject ?? null;
      }

      // Save contact info
      if (senderJid && (senderPhone || senderName)) {
        upsertContact(senderJid, senderPhone, senderName);
      }

      // Insert into DB
      const data = {
        whatsappId: messageId,
        chatJid: remoteJid,
        senderJid,
        senderPhone,
        senderName: fromMe ? "You" : senderName,
        body,
        mediaType,
        isGroup,
        groupName,
        fromMe,
        timestamp,
        isRead: fromMe,
      };
      insertMessage(data);

      // Broadcast to web UI
      if (wsBroadcast) {
        wsBroadcast(JSON.stringify({
          type: "new_message",
          data: {
            ...data,
            displayPhone: isGroup
              ? undefined
              : (fromMe ? selfPhone : senderPhone),
          },
        }));
      }
    } catch (err) {
      console.error("Error processing inbound message:", err.message);
    }
  }
}

// ── Connection Manager ──────────────────────────────────────────────────

function setStatus(status) {
  connectionStatus = status;
  if (wsBroadcast) {
    wsBroadcast(JSON.stringify({
      type: "status",
      data: { status, selfPhone, selfJid },
    }));
  }
}

async function connectWhatsApp() {
  setStatus("connecting");
  currentQr = null;
  currentQrDataUrl = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      browser: ["MyWhatsApp", "web", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Grab LID lookup reference if available
    lidLookup = sock.signalRepository?.lidMapping ?? null;

    // Persist credentials
    sock.ev.on("creds.update", saveCreds);

    // Connection events
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch { /* */ }
        setStatus("qr");
        reconnectAttempt = 0;
      }

      if (connection === "open") {
        selfJid = sock.user?.id ?? null;
        selfPhone = selfJid ? jidToE164(selfJid) : null;
        currentQr = null;
        currentQrDataUrl = null;
        reconnectAttempt = 0;
        setStatus("open");
        console.log(`✅ WhatsApp connected as ${selfPhone ?? selfJid}`);
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.status;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`⚠️  Connection closed (statusCode: ${statusCode}, loggedOut: ${isLoggedOut})`);

        if (isLoggedOut) {
          // Session invalidated — clear stale auth and start fresh
          console.log("🔑 Clearing auth for fresh QR...");
          sock = null;
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch {}
          reconnectAttempt = 0;
          setTimeout(() => connectWhatsApp(), 2000);
          return;
        }

        // Temporary disconnect — reconnect with backoff
        if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempt++;
          const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, reconnectAttempt - 1),
            RECONNECT_MAX_MS
          );
          const jitter = delay * 0.25 * (Math.random() * 2 - 1);
          const wait = Math.round(delay + jitter);
          console.log(`🔄 Reconnecting in ${wait}ms (attempt ${reconnectAttempt})...`);
          setStatus("connecting");
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => connectWhatsApp(), wait);
        } else {
          console.log("❌ Max reconnect attempts reached. Clearing auth and restarting...");
          sock = null;
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch {}
          reconnectAttempt = 0;
          setTimeout(() => connectWhatsApp(), 3000);
        }
      }
    });

    // WebSocket error handler
    if (sock.ws) {
      sock.ws.on("error", (err) => {
        console.error("WebSocket error:", err.message);
      });
    }

    // Inbound messages
    sock.ev.on("messages.upsert", handleMessagesUpsert);

    // NOTE: Do NOT call sendPresenceUpdate("available") here.
    // Doing so during the initial pairing handshake can cause WhatsApp
    // to reject the session. Presence is managed lazily on first send.

  } catch (err) {
    console.error("Connection error:", err.message);
    setStatus("disconnected");
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export function setWsBroadcast(fn) {
  wsBroadcast = fn;
}

export function getStatus() {
  return { status: connectionStatus, selfPhone, selfJid, qrDataUrl: currentQrDataUrl };
}

export async function sendMessage(to, text) {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp is not connected");
  }
  const jid = toWhatsappJid(to);
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch { /* */ }

  const result = await sock.sendMessage(jid, { text });
  const messageId = result?.key?.id ?? null;

  // Fetch group name if applicable
  let groupName = null;
  if (isGroupJid(jid)) {
    const meta = await getGroupMeta(jid);
    groupName = meta.displayName ?? meta.subject ?? null;
  }

  // Store in DB
  insertMessage({
    whatsappId: messageId,
    chatJid: jid,
    senderJid: selfJid,
    senderPhone: selfPhone,
    senderName: "You",
    body: text,
    mediaType: null,
    isGroup: isGroupJid(jid),
    groupName: groupName,
    fromMe: true,
    timestamp: Date.now(),
    isRead: true,
  });

  return { messageId, toJid: jid, groupName };
}

export async function markAsRead(chatJid, messageId, participantJid) {
  if (!sock || connectionStatus !== "open") return;
  try {
    const keys = [{
      remoteJid: chatJid,
      id: messageId,
      participant: participantJid ?? undefined,
      fromMe: false,
    }];
    await sock.readMessages(keys);
  } catch (err) {
    console.error("Failed to send read receipt:", err.message);
  }
  markChatRead(chatJid);
}

export { connectWhatsApp, jidToE164 };
