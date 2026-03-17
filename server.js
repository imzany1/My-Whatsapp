import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectWhatsApp,
  setWsBroadcast,
  getStatus,
  sendMessage,
  markAsRead,
} from "./whatsapp.js";
import { initDatabase, getChats, getMessages, getContacts, markChatRead } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ── Express App ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── REST API ────────────────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  res.json(getStatus());
});

app.get("/api/chats", (_req, res) => {
  try {
    const chats = getChats();
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/messages/:chatJid", (req, res) => {
  try {
    const chatJid = decodeURIComponent(req.params.chatJid);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const messages = getMessages(chatJid, limit, offset);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/contacts", (_req, res) => {
  try {
    const contacts = getContacts();
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ error: "Missing 'to' or 'text'" });
    }
    const result = await sendMessage(to, text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/read", async (req, res) => {
  try {
    const { chatJid, messageId, senderJid } = req.body;
    if (!chatJid) {
      return res.status(400).json({ error: "Missing 'chatJid'" });
    }
    if (messageId) {
      await markAsRead(chatJid, messageId, senderJid);
    } else {
      markChatRead(chatJid);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP + WebSocket Server ─────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  // Send current status on connect
  ws.send(JSON.stringify({ type: "status", data: getStatus() }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(data) {
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch { /* */ }
    }
  }
}

setWsBroadcast(broadcast);

// ── Start ───────────────────────────────────────────────────────────────

async function start() {
  await initDatabase();
  console.log("📦 Database initialized");

  server.listen(PORT, () => {
    console.log(`\n🌐 Web UI: http://localhost:${PORT}\n`);
    connectWhatsApp();
  });
}

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
