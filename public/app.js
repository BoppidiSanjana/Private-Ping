const $ = (id) => document.getElementById(id);
let me = null, socket = null, conversations = [], active = null, authMode = "login", searchTimer = null, typingTimer = null, lastTyping = 0;
const onlineUsers = new Set();
const seenMessageIds = new Set();

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed. Please try again.");
  return data;
}
function toast(message) {
  const el = document.createElement("div"); el.className = "toast"; el.textContent = message; $("toast-root").append(el);
  setTimeout(() => el.remove(), 3000);
}
function avatarText(name = "?") { return name.trim().split(/\s+/).slice(0, 2).map(x => x[0] || "").join("").toUpperCase(); }
function escapeText(value) { return String(value ?? ""); }
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
  $("name-label").classList.toggle("hidden", mode !== "register");
  $("auth-title").textContent = mode === "login" ? "Welcome back." : "Make yourself at home.";
  $("auth-subtitle").textContent = mode === "login" ? "Your conversations are waiting." : "Create an account and find your people.";
  $("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("auth-error").textContent = "";
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => setAuthMode(t.dataset.mode)));
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("auth-error").textContent = "";
  try {
    const payload = { username: $("auth-username").value.trim(), password: $("auth-password").value };
    if (authMode === "register") payload.name = $("auth-name").value.trim();
    const result = await api(`/api/auth/${authMode === "register" ? "register" : "login"}`, { method: "POST", body: JSON.stringify(payload) });
    me = result.user; await enterApp();
  } catch (err) { $("auth-error").textContent = err.message; }
});

async function boot() {
  try { const result = await api("/api/auth/me"); me = result.user; await enterApp(); }
  catch { $("auth-screen").classList.remove("hidden"); }
}
async function enterApp() {
  $("auth-screen").classList.add("hidden"); $("app").classList.remove("hidden");
  $("my-name").textContent = me.name; $("my-username").textContent = "@" + me.username; $("my-avatar").textContent = avatarText(me.name);
  const theme = localStorage.getItem("pp-theme");
  document.body.classList.toggle("light-theme", theme === "light");
  socket?.disconnect();
  socket = io();
  socket.on("connect_error", () => toast("Live connection lost. Refresh after checking the server."));
  socket.on("presence:update", ({ userId, online }) => { online ? onlineUsers.add(userId) : onlineUsers.delete(userId); renderConversations(); updateChatStatus(); });
  socket.on("conversation:updated", (c) => {
    const i = conversations.findIndex(x => x.id === c.id);
    if (i >= 0) conversations[i] = c; else conversations.push(c);
    renderConversations();
  });
  socket.on("message:new", (message) => {
    if (active?.id === message.conversationId) {
      appendMessage(message);
      markRead(active.id).catch(() => {});
    }
    loadConversations().catch(() => {});
  });
  socket.on("messages:read", ({ conversationId }) => { if (active?.id === conversationId) loadMessages(conversationId).catch(() => {}); });
  socket.on("typing:update", ({ conversationId, userId, name, isTyping }) => {
    if (active?.id !== conversationId || userId === me.id) return;
    $("typing-indicator").textContent = isTyping ? `${name} is typing…` : "";
    clearTimeout(typingTimer);
    if (isTyping) typingTimer = setTimeout(() => $("typing-indicator").textContent = "", 1800);
  });
  await loadConversations();
}
async function loadConversations() {
  const result = await api("/api/conversations");
  conversations = result.conversations;
  renderConversations();
}
function otherMember(c) { return c.members.find(m => m.id !== me.id) || me; }
function conversationTitle(c) { return c.type === "group" ? c.title : otherMember(c).name; }
function renderConversations() {
  $("chat-count").textContent = conversations.length;
  const list = $("conversation-list"); list.innerHTML = "";
  if (!conversations.length) {
    const empty = document.createElement("div"); empty.className = "muted-empty"; empty.style.cssText = "padding:20px 8px;color:var(--muted);font-size:11px;line-height:1.6"; empty.textContent = "No conversations yet. Start a new chat to say hello."; list.append(empty); return;
  }
  conversations.forEach(c => {
    const member = otherMember(c);
    const item = document.createElement("div"); item.className = "conversation-item" + (active?.id === c.id ? " active" : "");
    const av = document.createElement("div"); av.className = "avatar" + (c.type === "private" && onlineUsers.has(member.id) ? " online" : ""); av.textContent = c.type === "group" ? "✦" : avatarText(member.name);
    const meta = document.createElement("div"); meta.className = "conversation-meta";
    const top = document.createElement("div"); top.className = "conversation-top";
    const title = document.createElement("b"); title.textContent = conversationTitle(c);
    const time = document.createElement("time"); time.textContent = c.latestMessage ? formatTime(c.latestMessage.createdAt) : "";
    top.append(title, time);
    const bottom = document.createElement("div"); bottom.className = "conversation-bottom";
    const preview = document.createElement("span"); preview.textContent = c.latestMessage ? (c.latestMessage.senderId === me.id ? "You: " : "") + c.latestMessage.text : (c.type === "group" ? `${c.members.length} members` : "Start a conversation");
    bottom.append(preview);
    if (c.unreadCount > 0 && active?.id !== c.id) { const unread = document.createElement("span"); unread.className = "unread"; unread.textContent = c.unreadCount; bottom.append(unread); }
    meta.append(top, bottom); item.append(av, meta); item.addEventListener("click", () => openConversation(c.id)); list.append(item);
  });
}
function formatTime(date) {
  const d = new Date(date);
  return Date.now() - d.getTime() < 86400000 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
async function openConversation(id) {
  try {
    const c = conversations.find(x => x.id === id) || (await api("/api/conversations")).conversations.find(x => x.id === id);
    if (!c) return;
    active = c;
    $("empty-state").classList.add("hidden"); $("chat-view").classList.remove("hidden");
    $("chat-title").textContent = conversationTitle(c); $("chat-avatar").textContent = c.type === "group" ? "✦" : avatarText(otherMember(c).name);
    $("message-input").disabled = false; $("send-btn").disabled = false;
    $("message-list").innerHTML = ""; $("typing-indicator").textContent = "";
    renderConversations(); updateChatStatus(); await loadMessages(id); await markRead(id);
    document.body.classList.toggle("mobile-chat", window.innerWidth <= 600);
    $("message-input").focus();
  } catch (err) { toast(err.message); }
}
function updateChatStatus() {
  if (!active) return;
  if (active.type === "group") $("chat-status").textContent = `${active.members.length} members · Group conversation`;
  else $("chat-status").textContent = onlineUsers.has(otherMember(active).id) ? "● Online now" : "Private conversation";
}
async function loadMessages(id) {
  const result = await api(`/api/conversations/${id}/messages?limit=100`);
  $("message-list").innerHTML = ""; seenMessageIds.clear();
  result.messages.forEach(appendMessage);
}
async function markRead(id) { await api(`/api/conversations/${id}/read`, { method: "POST", body: "{}" }); }
function appendMessage(m) {
  if (seenMessageIds.has(m.id)) return;
  seenMessageIds.add(m.id);
  const list = $("message-list");
  const row = document.createElement("article"); row.className = "message" + (m.senderId === me.id ? " mine" : "");
  const av = document.createElement("div"); av.className = "avatar"; av.textContent = avatarText(m.senderName || "User");
  const content = document.createElement("div"); content.className = "message-content";
  if (active?.type === "group" && m.senderId !== me.id) { const sender = document.createElement("div"); sender.className = "sender"; sender.textContent = m.senderName; content.append(sender); }
  const bubble = document.createElement("div"); bubble.className = "bubble";
  if (m.attachment) {
    if (m.attachment.type?.startsWith("image/")) {
      const img = document.createElement("img"); img.className = "attachment-preview"; img.alt = m.attachment.name; img.src = `/api/attachments/${encodeURIComponent(m.attachment.id)}`; img.onerror = () => img.remove(); bubble.append(img);
    }
    const link = document.createElement("a"); link.className = "attachment-link"; link.href = `/api/attachments/${encodeURIComponent(m.attachment.id)}`; link.innerHTML = "<span>↧</span>"; const label = document.createElement("div"); const strong = document.createElement("b"); strong.textContent = m.attachment.name; strong.style.cssText = "display:block;font-size:11px"; const small = document.createElement("small"); small.textContent = `${formatBytes(m.attachment.size)} · Download`; small.style.cssText = "display:block;font-size:9px;margin-top:4px"; label.append(strong, small); link.append(label); bubble.append(link);
  }
  if (m.text) { const text = document.createElement("div"); text.textContent = m.text; bubble.append(text); }
  content.append(bubble);
  const foot = document.createElement("div"); foot.className = "message-foot";
  const stamp = document.createElement("time"); stamp.textContent = formatTime(m.createdAt); foot.append(stamp);
  if (m.senderId === me.id) { const receipt = document.createElement("span"); receipt.className = "receipt"; receipt.textContent = (m.readBy || []).some(uid => uid !== me.id) ? "✓✓ Read" : "✓ Sent"; foot.append(receipt); }
  content.append(foot); row.append(av, content); list.append(row); list.scrollTop = list.scrollHeight;
}
function formatBytes(n = 0) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

$("message-form").addEventListener("submit", async e => {
  e.preventDefault(); if (!active) return;
  const input = $("message-input"); const text = input.value.trim(); const file = $("attachment").files[0];
  if (!text && !file) return;
  const payload = { text };
  try {
    if (file) {
      if (file.size > 5 * 1024 * 1024) return toast("Files must be smaller than 5 MB.");
      payload.attachment = await fileToData(file);
    }
    input.value = ""; input.style.height = "auto"; $("attachment").value = "";
    socket.emit("typing:stop", { conversationId: active.id });
    await api(`/api/conversations/${active.id}/messages`, { method: "POST", body: JSON.stringify(payload) });
  } catch (err) { toast(err.message); }
});
function fileToData(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, data: reader.result }); reader.onerror = reject; reader.readAsDataURL(file); });
}
$("message-input").addEventListener("input", () => {
  const el = $("message-input"); el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  if (!active) return;
  if (Date.now() - lastTyping > 500) { socket.emit("typing:start", { conversationId: active.id }); lastTyping = Date.now(); }
  clearTimeout(typingTimer); typingTimer = setTimeout(() => socket.emit("typing:stop", { conversationId: active?.id }), 1200);
});
$("message-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("message-form").requestSubmit(); } });
$("new-chat").addEventListener("click", () => { $("user-search").focus(); $("user-search").placeholder = "Type a name or username…"; toast("Search for a registered user to start a private chat."); });
$("empty-new-chat").addEventListener("click", () => $("new-chat").click());
$("user-search").addEventListener("input", () => {
  clearTimeout(searchTimer); const q = $("user-search").value.trim();
  if (!q) { $("search-results").classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      const box = $("search-results"); box.innerHTML = ""; box.classList.remove("hidden");
      if (!result.users.length) { box.textContent = "No users found"; box.style.padding = "14px"; return; }
      result.users.forEach(u => {
        const item = document.createElement("div"); item.className = "search-result";
        const av = document.createElement("div"); av.className = "avatar"; av.textContent = avatarText(u.name);
        const meta = document.createElement("div"); const b = document.createElement("b"); b.textContent = u.name; const sm = document.createElement("small"); sm.textContent = "@" + u.username; meta.append(b, sm); item.append(av, meta);
        item.addEventListener("click", async () => {
          try {
            const created = await api("/api/conversations/private", { method: "POST", body: JSON.stringify({ userId: u.id }) });
            $("search-results").classList.add("hidden"); $("user-search").value = "";
            await loadConversations(); await openConversation(created.conversation.id);
          } catch (err) { toast(err.message); }
        }); box.append(item);
      });
    } catch (err) { toast(err.message); }
  }, 250);
});
document.addEventListener("click", e => { if (!e.target.closest(".search-wrap") && !e.target.closest(".search-results")) $("search-results").classList.add("hidden"); });

$("new-group").addEventListener("click", async () => {
  const title = prompt("Choose a name for your group:");
  if (!title?.trim()) return;
  const names = prompt("Enter member usernames separated by commas (not including yourself):");
  if (!names?.trim()) return toast("Add at least one other member username.");
  try {
    const found = [];
    for (const username of names.split(",").map(s => s.trim()).filter(Boolean)) {
      const result = await api(`/api/users/search?q=${encodeURIComponent(username)}`);
      const user = result.users.find(u => u.username === username.toLowerCase());
      if (user) found.push(user.id);
    }
    if (!found.length) return toast("No matching registered users found.");
    const result = await api("/api/conversations/group", { method: "POST", body: JSON.stringify({ title: title.trim(), memberIds: found }) });
    await loadConversations(); await openConversation(result.conversation.id); toast("Group created.");
  } catch (err) { toast(err.message); }
});
$("profile-btn").addEventListener("click", async () => {
  const name = prompt("Your display name:", me.name); if (name === null) return;
  const about = prompt("A short status/about message:", me.about || ""); if (about === null) return;
  try { const result = await api("/api/users/me", { method: "PATCH", body: JSON.stringify({ name, about }) }); me = result.user; $("my-name").textContent = me.name; $("my-avatar").textContent = avatarText(me.name); toast("Profile updated."); }
  catch (err) { toast(err.message); }
});
$("logout").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {} socket?.disconnect(); location.reload(); });
$("theme-toggle").addEventListener("click", () => { const light = document.body.classList.toggle("light-theme"); localStorage.setItem("pp-theme", light ? "light" : "dark"); });
$("mobile-back").addEventListener("click", () => { document.body.classList.remove("mobile-chat"); active = null; $("chat-view").classList.add("hidden"); $("empty-state").classList.remove("hidden"); renderConversations(); });
$("search-messages").addEventListener("click", () => $("search-bar").classList.toggle("hidden"));
$("close-search").addEventListener("click", () => $("search-bar").classList.add("hidden"));
$("run-search").addEventListener("click", async () => {
  if (!active) return;
  try {
    const q = $("message-query").value.trim(); const result = await api(`/api/conversations/${active.id}/search?q=${encodeURIComponent(q)}`);
    $("message-list").innerHTML = ""; seenMessageIds.clear();
    if (!result.messages.length) { const empty = document.createElement("div"); empty.className = "system-message"; empty.textContent = "No matching messages found."; $("message-list").append(empty); }
    else result.messages.forEach(appendMessage);
  } catch (err) { toast(err.message); }
});
$("message-query").addEventListener("keydown", e => { if (e.key === "Enter") $("run-search").click(); });
$("chat-info").addEventListener("click", () => {
  if (!active) return;
  $("info-panel").classList.remove("hidden"); $("info-title").textContent = conversationTitle(active); $("info-description").textContent = active.type === "group" ? `${active.members.length} members · Group chat` : (otherMember(active).about || "Private one-to-one conversation");
  $("info-avatar").textContent = active.type === "group" ? "✦" : avatarText(otherMember(active).name);
  const members = $("info-members"); members.innerHTML = "";
  active.members.forEach(m => { const row = document.createElement("div"); row.className = "member-row"; const av = document.createElement("div"); av.className = "avatar"; av.textContent = avatarText(m.name); const name = document.createElement("span"); name.textContent = m.name + (m.id === active.createdBy ? " · Admin" : ""); row.append(av, name); members.append(row); });
});
$("close-info").addEventListener("click", () => $("info-panel").classList.add("hidden"));
window.addEventListener("resize", () => { if (window.innerWidth > 600) document.body.classList.remove("mobile-chat"); });

boot().catch(() => {});
