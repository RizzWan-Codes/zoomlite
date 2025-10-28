// index.js — simple signalling server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// room -> set(socketId)
const rooms = new Map();

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('join-room', (roomId, userMeta = {}) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const participants = rooms.get(roomId);
    // notify existing participants about the newcomer
    participants.forEach(pid => {
      io.to(pid).emit('new-peer', { peerId: socket.id, info: userMeta });
    });

    // send existing participants list to newly joined socket
    const existing = Array.from(participants);
    socket.emit('existing-peers', existing);

    participants.add(socket.id);
    socket.data.roomId = roomId;
    console.log(`${socket.id} joined ${roomId}`);
  });

  socket.on('signal', ({ to, from, data }) => {
    // relay signalling messages (offer/answer/ice)
    io.to(to).emit('signal', { from, data });
  });

  socket.on('send-chat', ({ roomId, msg, sender }) => {
    io.to(roomId).emit('chat', { msg, sender, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const participants = rooms.get(roomId);
      participants.delete(socket.id);
      // notify remaining peers
      io.to(roomId).emit('peer-left', socket.id);
      if (participants.size === 0) rooms.delete(roomId);
    }
    console.log('socket disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signalling server running on :${PORT}`));
