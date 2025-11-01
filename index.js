// index.js — upgraded signalling server with synced avatars & states
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
  console.log("✅ socket connected:", socket.id);

  // 🔁 Handle video state changes (mute/unmute camera)
  socket.on("video-state-change", ({ roomId, peerId, enabled, name, avatar }) => {
    socket.to(roomId).emit("peer-video-state", { peerId, enabled, name, avatar });

    // Update participant’s current camera state in server memory
    const participants = rooms.get(roomId);
    if (participants && participants.has(peerId)) {
      const meta = participants.get(peerId);
      participants.set(peerId, { ...meta, videoEnabled: enabled, avatar });
    }
  });

  // 🚪 Handle join-room
  socket.on("join-room", (roomId, userMeta = {}) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const participants = rooms.get(roomId);

    // Notify existing participants about the newcomer
    participants.forEach((info, pid) => {
      io.to(pid).emit("new-peer", { peerId: socket.id, info: userMeta });
    });

    // Send existing participants (with their states) to newly joined user
    const existing = Array.from(participants.entries()).map(([pid, info]) => ({
      peerId: pid,
      info,
    }));
    socket.emit("existing-peers", existing);

    // Add this user to room map
    participants.set(socket.id, userMeta);
    socket.data.roomId = roomId;

    console.log(`${socket.id} joined room ${roomId}`);
  });

  // 📡 Relay signalling messages (offer/answer/ice)
  socket.on("signal", ({ to, from, data }) => {
    io.to(to).emit("signal", { from, data });
  });

  // 💬 Handle chat
  socket.on("send-chat", ({ roomId, msg, sender }) => {
    io.to(roomId).emit("chat", { msg, sender, ts: Date.now() });
  });

  // ❌ Handle disconnect
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const participants = rooms.get(roomId);
      participants.delete(socket.id);

      // Notify remaining peers
      io.to(roomId).emit("peer-left", socket.id);

      // Clean up empty rooms
      if (participants.size === 0) rooms.delete(roomId);
    }
    console.log("❌ socket disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Signalling server running at http://localhost:${PORT}`)
);
