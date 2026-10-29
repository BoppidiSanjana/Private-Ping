const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-this-secret";
const MAX_FILE_BYTES = Math.max(1, Number(process.env.MAX_FILE_MB || 5)) * 1024 * 1024;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function initialDB() {
  return { users: [], conversations: [], messages: [] };
}
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return initialDB();
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return initialDB();
  }
}
let db = readDB();
function saveDB() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function id() { return crypto.randomUUID(); }
function clean(value, max = 500) { return String(value || "").trim().slice(0, max); }
function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, about: user.about || "", createdAt: user.createdAt };
}
function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });
}
function setAuth(res, user) {
  res.cookie("pp_token", signToken(user), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.pp_token || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Please sign in to continue." });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find((item) => item.id === payload.sub);
    if (!user) return res.status(401).json({ error: "Session expired. Please sign in again." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}
function conversationFor(userId, conversationId) {
  return db.conversations.find((c) => c.id === conversationId && c.members.includes(userId));
}
function viewConversation(c, currentUserId) {
  const members = c.members.map((uid) => {
    const u = db.users.find((x) => x.id === uid);
    return u ? publicUser(u) : null;
  }).filter(Boolean);
  const latest = db.messages.filter((m) => m.conversationId === c.id).slice(-1)[0] || null;
  return { ...c, members, latestMessage: latest ? { text: latest.text || (latest.attachment ? `📎 ${latest.attachment.name}` : ""), createdAt: latest.createdAt, senderId: latest.senderId } : null, unreadCount: db.messages.filter((m) => m.conversationId === c.id && m.senderId !== currentUserId && !(m.readBy || []).includes(currentUserId)).length };
}
function emitConversationUpdate(conversationId) {
  const c = db.conversations.find((x) => x.id === conversationId);
  if (!c) return;
  c.members.forEach((uid) => {
    for (const socketId of userSockets.get(uid) || []) io.to(socketId).emit("conversation:updated", viewConversation(c, uid));
  });
}
function emitToUser(userId, event, payload) {
  for (const socketId of userSockets.get(userId) || []) io.to(socketId).emit(event, payload);
}

app.use(express.json({ limit: "7mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "private-ping" }));

app.post("/api/auth/register", async (req, res) => {
  const name = clean(req.body.name, 50);
  const username = clean(req.body.username, 24).toLowerCase().replace(/[^a-z0-9_.]/g, "");
  const password = String(req.body.password || "");
  if (name.length < 2 || username.length < 3 || password.length < 8) return res.status(400).json({ error: "Use a name (2+ characters), username (3+ letters/numbers), and password (at least 8 characters)." });
  if (db.users.some((u) => u.username === username)) return res.status(409).json({ error: "That username is already taken." });
  const user = { id: id(), name, username, passwordHash: await bcrypt.hash(password, 12), about: "", createdAt: new Date().toISOString() };
  db.users.push(user); saveDB(); setAuth(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const username = clean(req.body.username, 50).toLowerCase();
  const password = String(req.body.password || "");
  const user = db.users.find((u) => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: "Incorrect username or password." });
  setAuth(res, user);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("pp_token", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch("/api/users/me", auth, (req, res) => {
  const name = clean(req.body.name, 50);
  const about = clean(req.body.about, 120);
  if (name.length < 2) return res.status(400).json({ error: "Name must contain at least 2 characters." });
  req.user.name = name;
  req.user.about = about;
  saveDB();
  res.json({ user: publicUser(req.user) });
});

app.get("/api/users/search", auth, (req, res) => {
  const q = clean(req.query.q, 50).toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = db.users.filter((u) => u.id !== req.user.id && (u.username.includes(q) || u.name.toLowerCase().includes(q))).slice(0, 15).map(publicUser);
  res.json({ users });
});

app.get("/api/conversations", auth, (req, res) => {
  const conversations = db.conversations.filter((c) => c.members.includes(req.user.id))
    .map((c) => viewConversation(c, req.user.id))
    .sort((a, b) => new Date(b.latestMessage?.createdAt || b.createdAt) - new Date(a.latestMessage?.createdAt || a.createdAt));
  res.json({ conversations });
});

app.post("/api/conversations/private", auth, (req, res) => {
  const target = db.users.find((u) => u.id === clean(req.body.userId, 80));
  if (!target || target.id === req.user.id) return res.status(400).json({ error: "Choose another registered user." });
  let c = db.conversations.find((x) => x.type === "private" && x.members.length === 2 && x.members.includes(req.user.id) && x.members.includes(target.id));
  if (!c) {
    c = { id: id(), type: "private", title: "", members: [req.user.id, target.id], admins: [], createdBy: req.user.id, createdAt: new Date().toISOString() };
    db.conversations.push(c); saveDB();
  }
  res.status(201).json({ conversation: viewConversation(c, req.user.id) });
});

app.post("/api/conversations/group", auth, (req, res) => {
  const title = clean(req.body.title, 60);
  const requested = Array.isArray(req.body.memberIds) ? req.body.memberIds.map((x) => clean(x, 80)) : [];
  const memberIds = [...new Set([req.user.id, ...requested])].filter((uid) => db.users.some((u) => u.id === uid));
  if (title.length < 2 || memberIds.length < 2) return res.status(400).json({ error: "Add a group name and at least one other registered member." });
  const c = { id: id(), type: "group", title, members: memberIds, admins: [req.user.id], createdBy: req.user.id, createdAt: new Date().toISOString() };
  db.conversations.push(c); saveDB();
  res.status(201).json({ conversation: viewConversation(c, req.user.id) });
});

app.post("/api/conversations/:id/members", auth, (req, res) => {
  const c = db.conversations.find((x) => x.id === req.params.id && x.type === "group");
  if (!c || !c.members.includes(req.user.id)) return res.status(404).json({ error: "Group not found." });
  if (!c.admins.includes(req.user.id)) return res.status(403).json({ error: "Only group admins can add members." });
  const target = db.users.find((u) => u.id === clean(req.body.userId, 80));
  if (!target) return res.status(404).json({ error: "User not found." });
  if (!c.members.includes(target.id)) c.members.push(target.id);
  saveDB();
  const view = viewConversation(c, req.user.id);
  c.members.forEach((uid) => emitToUser(uid, "conversation:updated", viewConversation(c, uid)));
  res.json({ conversation: view });
});

app.delete("/api/conversations/:id/members/:userId", auth, (req, res) => {
  const c = db.conversations.find((x) => x.id === req.params.id && x.type === "group");
  if (!c || !c.members.includes(req.user.id)) return res.status(404).json({ error: "Group not found." });
  const targetId = clean(req.params.userId, 80);
  if (targetId === req.user.id) {
    c.members = c.members.filter((uid) => uid !== req.user.id);
    c.admins = c.admins.filter((uid) => uid !== req.user.id);
  } else {
    if (!c.admins.includes(req.user.id)) return res.status(403).json({ error: "Only group admins can remove members." });
    c.members = c.members.filter((uid) => uid !== targetId);
    c.admins = c.admins.filter((uid) => uid !== targetId);
  }
  saveDB();
  c.members.forEach((uid) => emitToUser(uid, "conversation:updated", viewConversation(c, uid)));
  res.json({ ok: true });
});

app.get("/api/conversations/:id/messages", auth, (req, res) => {
  if (!conversationFor(req.user.id, req.params.id)) return res.status(403).json({ error: "You do not have access to this conversation." });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const before = req.query.before ? new Date(req.query.before).getTime() : Infinity;
  const messages = db.messages.filter((m) => m.conversationId === req.params.id && new Date(m.createdAt).getTime() < before).slice(-limit);
  res.json({ messages });
});

app.post("/api/conversations/:id/read", auth, (req, res) => {
  if (!conversationFor(req.user.id, req.params.id)) return res.status(403).json({ error: "You do not have access to this conversation." });
  db.messages.filter((m) => m.conversationId === req.params.id && m.senderId !== req.user.id).forEach((m) => {
    m.readBy = [...new Set([...(m.readBy || []), req.user.id])];
  });
  saveDB();
  io.to(req.params.id).emit("messages:read", { conversationId: req.params.id, userId: req.user.id });
  emitConversationUpdate(req.params.id);
  res.json({ ok: true });
});

app.get("/api/conversations/:id/search", auth, (req, res) => {
  if (!conversationFor(req.user.id, req.params.id)) return res.status(403).json({ error: "You do not have access to this conversation." });
  const q = clean(req.query.q, 100).toLowerCase();
  const messages = q ? db.messages.filter((m) => m.conversationId === req.params.id && (m.text || "").toLowerCase().includes(q)).slice(-100) : [];
  res.json({ messages });
});

app.post("/api/conversations/:id/messages", auth, (req, res) => {
  const c = conversationFor(req.user.id, req.params.id);
  if (!c) return res.status(403).json({ error: "You do not have access to this conversation." });
  const text = clean(req.body.text, 2000);
  if (!text && !req.body.attachment) return res.status(400).json({ error: "Message cannot be empty." });
  const message = { id: id(), conversationId: c.id, senderId: req.user.id, senderName: req.user.name, text, attachment: null, createdAt: new Date().toISOString(), deliveredTo: [], readBy: [] };
  if (req.body.attachment) {
    const a = req.body.attachment;
    const name = path.basename(clean(a.name, 120));
    const mime = clean(a.type, 100);
    const data = String(a.data || "");
    if (!name || !/^data:(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|application\/vnd.openxmlformats-officedocument\.wordprocessingml\.document);base64,/.test(data) || data.length > MAX_FILE_BYTES * 1.5) {
      return res.status(400).json({ error: "Unsupported or oversized file. Allowed: images, PDF, TXT, and DOCX." });
    }
    const match = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Invalid file data." });
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_FILE_BYTES) return res.status(413).json({ error: "File exceeds the upload limit." });
    const fileId = id();
    const ext = path.extname(name).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
    fs.writeFileSync(path.join(UPLOAD_DIR, fileId + ext), bytes, { flag: "wx" });
    message.attachment = { id: fileId, name, type: match[1], size: bytes.length };
  }
  db.messages.push(message); saveDB();
  c.members.forEach((uid) => emitToUser(uid, "message:new", message));
  emitConversationUpdate(c.id);
  res.status(201).json({ message });
});

app.get("/api/attachments/:id", auth, (req, res) => {
  const message = db.messages.find((m) => m.attachment && m.attachment.id === req.params.id);
  if (!message || !conversationFor(req.user.id, message.conversationId)) return res.status(404).json({ error: "Attachment not found." });
  const ext = path.extname(message.attachment.name).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
  const filePath = path.join(UPLOAD_DIR, req.params.id + ext);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File is no longer available." });
  res.setHeader("Content-Type", message.attachment.type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename="${message.attachment.name.replace(/["\r\n]/g, "")}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.use((err, _req, res, _next) => {
  console.error("Request failed:", err.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const userSockets = new Map();
const socketUsers = new Map();
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.request.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("pp_token="))?.slice("pp_token=".length);
    if (!token) return next(new Error("Please sign in again."));
    const payload = jwt.verify(decodeURIComponent(token), JWT_SECRET);
    const user = db.users.find((u) => u.id === payload.sub);
    if (!user) return next(new Error("Please sign in again."));
    socket.user = user;
    next();
  } catch { next(new Error("Please sign in again.")); }
});

io.on("connection", (socket) => {
  const userId = socket.user.id;
  socketUsers.set(socket.id, userId);
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);
  socket.join(`user:${userId}`);
  db.conversations.filter((c) => c.members.includes(userId)).forEach((c) => socket.join(c.id));
  socket.broadcast.emit("presence:update", { userId, online: true });

  socket.on("typing:start", ({ conversationId } = {}) => {
    const c = conversationFor(userId, clean(conversationId, 80));
    if (c) socket.to(c.id).emit("typing:update", { conversationId: c.id, userId, name: socket.user.name, isTyping: true });
  });
  socket.on("typing:stop", ({ conversationId } = {}) => {
    const c = conversationFor(userId, clean(conversationId, 80));
    if (c) socket.to(c.id).emit("typing:update", { conversationId: c.id, userId, name: socket.user.name, isTyping: false });
  });
  socket.on("disconnect", () => {
    const uid = socketUsers.get(socket.id);
    socketUsers.delete(socket.id);
    const sockets = userSockets.get(uid);
    if (sockets) {
      sockets.delete(socket.id);
      if (!sockets.size) {
        userSockets.delete(uid);
        socket.broadcast.emit("presence:update", { userId: uid, online: false });
      }
    }
  });
});

server.listen(PORT, () => console.log(`Private Ping running at http://localhost:${PORT}`));