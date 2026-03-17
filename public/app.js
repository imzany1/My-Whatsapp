// ── State ──────────────────────────────────────────────────────────────

let ws = null;
let currentChatJid = null;
let chats = [];
let connectionStatus = "disconnected";
let qrPollTimer = null;
const renderedMessageIds = new Set();

// ── DOM Refs ──────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const loginScreen = $("#login-screen");
const qrArea = $("#qr-area");
const loginStatusEl = $("#login-status");
const loginStatusText = $("#login-status-text");
const chatListEl = $("#chat-list");
const searchInput = $("#search-input");
const mainArea = $("#main-area");
const emptyState = $("#empty-state");
const chatView = $("#chat-view");
const chatHeader = $("#chat-header");
const messagesContainer = $("#messages-container");
const composeInput = $("#compose-input");
const sendBtn = $("#send-btn");
const connectionDot = $("#connection-dot");
const selfPhoneEl = $("#self-phone");
const appEl = $("#app");

// ── Helpers ───────────────────────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatChatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatTime(ts);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getInitial(name) {
  if (!name) return "?";
  return name.trim().charAt(0).toUpperCase();
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getChatDisplayName(chat) {
  if (chat.isGroup && chat.groupName) return chat.groupName;
  if (chat.displayName) return chat.displayName;
  if (chat.displayPhone) return chat.displayPhone;
  if (chat.lastSenderPhone) return chat.lastSenderPhone;
  return chat.chatJid;
}

// ── WebSocket ─────────────────────────────────────────────────────────

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log("WebSocket connected");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch { /* */ }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected, reconnecting in 2s...");
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "status":
      updateConnectionStatus(msg.data);
      break;
    case "new_message":
      handleNewMessage(msg.data);
      break;
  }
}

// ── Connection Status ─────────────────────────────────────────────────

function updateConnectionStatus(data) {
  connectionStatus = data.status;

  // Connection dot in sidebar
  connectionDot.className = `connection-indicator ${data.status === "open" ? "open" : ""}`;

  // Self phone
  if (data.selfPhone) {
    selfPhoneEl.textContent = data.selfPhone;
  }

  // Login screen
  if (data.status === "open") {
    loginScreen.classList.add("hidden");
    clearInterval(qrPollTimer);
    loadChats();
  } else if (data.status === "qr") {
    loginScreen.classList.remove("hidden");
    if (data.qrDataUrl) {
      showQr(data.qrDataUrl);
    }
    startQrPolling();
    updateLoginBadge("connecting", "Scan QR Code");
  } else if (data.status === "connecting") {
    loginScreen.classList.remove("hidden");
    updateLoginBadge("connecting", "Connecting...");
  } else {
    loginScreen.classList.remove("hidden");
    updateLoginBadge("disconnected", "Disconnected");
  }
}

function showQr(dataUrl) {
  qrArea.innerHTML = `
    <div class="qr-container">
      <img src="${dataUrl}" alt="QR Code" />
    </div>
    <p style="color: var(--text-muted); font-size: 13px;">Open WhatsApp → Linked Devices → Link a Device</p>
  `;
}

function updateLoginBadge(cls, text) {
  loginStatusEl.className = `status-badge ${cls}`;
  loginStatusText.textContent = text;
}

function startQrPolling() {
  clearInterval(qrPollTimer);
  qrPollTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      updateConnectionStatus(data);
    } catch { /* */ }
  }, 3000);
}

// ── Chat List ─────────────────────────────────────────────────────────

async function loadChats() {
  try {
    const res = await fetch("/api/chats");
    chats = await res.json();
    renderChatList(chats);
  } catch (err) {
    console.error("Failed to load chats:", err);
  }
}

function renderChatList(items) {
  const filter = searchInput.value.toLowerCase().trim();
  const filtered = filter
    ? items.filter((c) => getChatDisplayName(c).toLowerCase().includes(filter))
    : items;

  chatListEl.innerHTML = filtered
    .map((chat) => {
      const name = escapeHtml(getChatDisplayName(chat));
      const initial = getInitial(getChatDisplayName(chat));
      const isActive = currentChatJid === chat.chatJid;
      const isGroup = chat.isGroup;
      const time = formatChatTime(chat.lastTimestamp);
      const preview = chat.lastFromMe
        ? `<span style="color:var(--text-muted)">You:</span> ${escapeHtml(truncate(chat.lastBody, 40))}`
        : (isGroup && chat.lastSenderName ? `<span style="color:var(--text-muted)">${escapeHtml(chat.lastSenderName)}:</span> ` : "") + escapeHtml(truncate(chat.lastBody, 50));
      const unread = chat.unreadCount > 0 ? `<span class="unread-badge">${chat.unreadCount}</span>` : "";
      const timeClass = chat.unreadCount > 0 ? "chat-time unread" : "chat-time";
      const avatarClass = isGroup ? (chat.isCommunity ? "chat-avatar community" : "chat-avatar group") : "chat-avatar";

      return `
        <li class="chat-item ${isActive ? "active" : ""}" data-jid="${escapeHtml(chat.chatJid)}" onclick="openChat('${escapeHtml(chat.chatJid)}')">
          <div class="${avatarClass}">${initial}</div>
          <div class="chat-info">
            <div class="chat-top">
              <span class="chat-name">${name}</span>
              <span class="${timeClass}">${time}</span>
            </div>
            <div class="chat-preview">${preview || "&nbsp;"}</div>
          </div>
          ${unread}
        </li>
      `;
    })
    .join("");
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

searchInput.addEventListener("input", () => {
  renderChatList(chats);
});

// ── Open Chat ─────────────────────────────────────────────────────────

async function openChat(chatJid) {
  currentChatJid = chatJid;
  emptyState.style.display = "none";
  chatView.style.display = "flex";
  appEl.classList.add("chat-open");

  // Update active state in sidebar
  chatListEl.querySelectorAll(".chat-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.jid === chatJid);
  });

  // Load messages
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(chatJid)}`);
    const messages = await res.json();
    renderMessages(messages, chatJid);

    // Find chat info
    const chat = chats.find((c) => c.chatJid === chatJid);
    renderChatHeader(chat, chatJid);

    // Mark as read
    if (messages.length > 0) {
      const lastMsg = messages.filter((m) => !m.fromMe).pop();
      if (lastMsg) {
        await fetch("/api/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatJid,
            messageId: lastMsg.whatsappId,
            senderJid: lastMsg.senderJid,
          }),
        });
      }
    }

    // Refresh chat list to update unread counts
    loadChats();
  } catch (err) {
    console.error("Failed to load messages:", err);
  }

  composeInput.focus();
}

// Expose openChat to inline onclick handlers
window.openChat = openChat;

function renderChatHeader(chat, chatJid) {
  const name = chat ? getChatDisplayName(chat) : chatJid;
  const initial = getInitial(name);
  const isGroup = chat?.isGroup;
  const sub = isGroup ? "Group" : (chat?.displayPhone ?? chatJid);

  chatHeader.innerHTML = `
    <div class="chat-header-avatar ${isGroup ? "group" : ""}">${initial}</div>
    <div class="chat-header-info">
      <div class="chat-header-name">${escapeHtml(name)}</div>
      <div class="chat-header-sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

function renderMessages(messages, chatJid) {
  let html = "";
  let lastDate = "";
  renderedMessageIds.clear();

  for (const msg of messages) {
    if (msg.whatsappId) renderedMessageIds.add(msg.whatsappId);

    const msgDate = formatDate(msg.timestamp);
    if (msgDate !== lastDate) {
      html += `<div class="date-divider"><span>${msgDate}</span></div>`;
      lastDate = msgDate;
    }

    const isMine = msg.fromMe;
    const cls = isMine ? "mine" : "theirs";
    const time = formatTime(msg.timestamp);

    // Don't show sender labels for self-sent messages (like WhatsApp)
    const senderLabel =
      msg.isGroup && !isMine
        ? `<div class="message-sender">${escapeHtml(msg.senderName || msg.senderPhone || "Unknown")}</div>`
        : "";

    html += `
      <div class="message ${cls}" data-id="${msg.whatsappId}">
        ${senderLabel}
        <div class="message-text">${escapeHtml(msg.body)}</div>
        <div class="message-meta">
          <span class="message-time">${time}</span>
          ${isMine ? '<span class="message-read">✓✓</span>' : ""}
        </div>
      </div>
    `;
  }

  messagesContainer.innerHTML = html;
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ── Send Message ──────────────────────────────────────────────────────

composeInput.addEventListener("input", () => {
  sendBtn.disabled = !composeInput.value.trim();
  // Auto-resize
  composeInput.style.height = "auto";
  composeInput.style.height = Math.min(composeInput.scrollHeight, 120) + "px";
});

composeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

sendBtn.addEventListener("click", doSend);

async function doSend() {
  const text = composeInput.value.trim();
  if (!text || !currentChatJid) return;

  composeInput.value = "";
  composeInput.style.height = "auto";
  sendBtn.disabled = true;

  // Optimistic render
  const tempId = "sending-" + Date.now();
  appendMessage({
    whatsappId: tempId,
    body: text,
    fromMe: true,
    timestamp: Date.now(),
    isGroup: chats.find(c => c.chatJid === currentChatJid)?.isGroup || false,
  });

  try {
    await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: currentChatJid, text }),
    });
  } catch (err) {
    console.error("Send failed:", err);
  }

  composeInput.focus();
}

function appendMessage(msg) {
  if (msg.whatsappId && renderedMessageIds.has(msg.whatsappId)) return;
  if (msg.whatsappId) renderedMessageIds.add(msg.whatsappId);

  const time = formatTime(msg.timestamp);
  const isMine = msg.fromMe;
  const cls = isMine ? "mine" : "theirs";

  // Don't show sender labels for self-sent messages (like WhatsApp)
  const senderLabel =
    msg.isGroup && !isMine
      ? `<div class="message-sender">${escapeHtml(msg.senderName || msg.senderPhone || "Unknown")}</div>`
      : "";

  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.dataset.id = msg.whatsappId;
  div.innerHTML = `
    ${senderLabel}
    <div class="message-text">${escapeHtml(msg.body)}</div>
    <div class="message-meta">
      <span class="message-time">${time}</span>
      ${isMine ? '<span class="message-read">✓✓</span>' : ""}
    </div>
  `;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ── Real-time New Messages ────────────────────────────────────────────

function handleNewMessage(data) {
  // Add to current chat if open
  if (currentChatJid === data.chatJid) {
    appendMessage(data);

    // Auto-mark as read if the chat is currently open
    if (!data.fromMe && data.whatsappId) {
      fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatJid: data.chatJid,
          messageId: data.whatsappId,
          senderJid: data.senderJid,
        }),
      }).catch(() => {});
    }
  }

  // Refresh chat list
  loadChats();
}

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
  connectWebSocket();

  // Initial status check
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    updateConnectionStatus(data);
  } catch { /* */ }
}

init();
