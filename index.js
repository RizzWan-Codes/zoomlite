// index.js — ZoomLite signaling server 💬 with contacts, presence, and 1:1 calls
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// 🧠 rooms: Map<roomId, Map<socketId, userMeta>>
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  // 🔁 Handle camera toggles
  socket.on("video-state-change", ({ roomId, peerId, enabled, name, avatar }) => {
    socket.to(roomId).emit("peer-video-state", { peerId, enabled, name, avatar });

    // Update participant’s state in memory
    const participants = rooms.get(roomId);
    if (participants && participants.has(peerId)) {
      const meta = participants.get(peerId);
      participants.set(peerId, { ...meta, videoEnabled: enabled, avatar });
    }
  });

  // 🚪 Join room (main signaling)
  socket.on("join-room", (roomId, userMeta = {}) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const participants = rooms.get(roomId);

    // Notify existing participants about the newcomer
    participants.forEach((info, pid) => {
      io.to(pid).emit("new-peer", { peerId: socket.id, info: userMeta });

      // 👥 Mutual contact exchange
      io.to(pid).emit("add-contact", userMeta);
      socket.emit("add-contact", info);
    });

    // Send all existing peers to the new user
    const existing = Array.from(participants.entries()).map(([pid, info]) => ({
      peerId: pid,
      info,
    }));
    socket.emit("existing-peers", existing);

    // Store new participant in room
    participants.set(socket.id, userMeta);
    socket.data.roomId = roomId;

    console.log(`👋 ${userMeta.name || "User"} joined room ${roomId}`);
  });

  // 📡 Relay WebRTC signals (offer / answer / ice)
  socket.on("signal", ({ to, from, data }) => {
    io.to(to).emit("signal", { from, data });
  });

  // 💬 Handle in-room chat
  socket.on("send-chat", ({ roomId, msg, sender }) => {
    io.to(roomId).emit("chat", { msg, sender, ts: Date.now() });
  });

  // 🟢 Presence tracking
  socket.on("register-user", (name) => {
    socket.data.userName = name;
    io.emit("user-online", name);

    const users = Array.from(io.sockets.sockets.values())
      .map((s) => s.data.userName)
      .filter(Boolean);
    io.emit("online-users", users);

    console.log(`🟢 ${name} came online`);
  });

 socket.on("call-user", ({ from, to }) => {
  console.log(`📞 Incoming call attempt: ${from} → ${to}`);
  console.log("📋 All registered users:", Array.from(io.sockets.sockets.values()).map(s => s.data.userName));

  const targetSocket = Array.from(io.sockets.sockets.values()).find(
    (s) => s.data.userName === to
  );

  if (targetSocket) {
    console.log(`✅ Found target socket for ${to}:`, targetSocket.id);
    targetSocket.emit("incoming-call", { from });
  } else {
    console.warn(`❌ Could not find socket for ${to}`);
    io.to(socket.id).emit("call-failed", { to });
  }
});


  socket.on("accept-call", ({ from, roomId }) => {
    const callerSocket = Array.from(io.sockets.sockets.values()).find(
      (s) => s.data.userName === from
    );
    if (callerSocket) {
      console.log(`✅ Call accepted by ${socket.data.userName}`);
      callerSocket.emit("call-accepted", { roomId, by: socket.data.userName });
    }
  });

  socket.on("reject-call", ({ from }) => {
    const callerSocket = Array.from(io.sockets.sockets.values()).find(
      (s) => s.data.userName === from
    );
    if (callerSocket) {
      console.log(`❌ Call rejected by ${socket.data.userName}`);
      callerSocket.emit("call-rejected", { by: socket.data.userName });
    }
  });

  // 🔴 Disconnect (offline + room cleanup)
  socket.on("disconnect", () => {
    const name = socket.data.userName;
    if (name) io.emit("user-offline", name);

    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const participants = rooms.get(roomId);
      participants.delete(socket.id);
      io.to(roomId).emit("peer-left", socket.id);

      if (participants.size === 0) {
        rooms.delete(roomId);
      }
    }

    console.log(`❌ Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Signaling server live at http://localhost:${PORT}`)
);
