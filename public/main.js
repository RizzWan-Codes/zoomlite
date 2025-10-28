// main.js 🚀 Zoom x1000 Lite

// 🌍 Server URL (local or deployed)
const SERVER = (location.hostname === 'localhost')
  ? 'http://localhost:3000'
  : 'https://zoomlite.onrender.com'; // ⚠️ Replace with your Render URL

const socket = io(SERVER);
let userName = localStorage.getItem('userName') || null;

// 🧠 Wait for name before joining
if (!userName) {
  window.addEventListener('nameSet', (e) => {
    userName = e.detail;
    console.log("✅ Name received:", userName);
    enableJoin();
  });
} else {
  console.log("🧠 Using saved name:", userName);
  enableJoin();
}

function enableJoin() {
  const joinBtn = document.getElementById('joinBtn');
  if (joinBtn) {
    joinBtn.disabled = false;
    console.log("🚀 Join button enabled");
  } else {
    console.warn("Join button not found yet");
  }
}

// --- WebRTC configuration ---
const cfg = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// --- Global variables ---
const pcs = {};               // peerId -> RTCPeerConnection
const remoteVideoEls = {};    // peerId -> video element
let localStream = null;
let roomId = null;

// --- Elements ---
const videoGrid = document.getElementById('videoGrid');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const roomInput = document.getElementById('room');
const chatToggleBtn = document.getElementById("chatToggleBtn");
const sendChatBtn = document.getElementById("sendChatBtn");
const chatInput = document.getElementById("chatin");
const chatBox = document.getElementById("chatMessages");

// --- Initial States ---
chatToggleBtn.disabled = false; // Always active
sendChatBtn.disabled = true;    // Locked until joining

joinBtn.onclick = async () => {
  if (!userName) return alert("Please enter your name first!");
  if (!roomInput.value) return alert("Enter a room ID");
  roomId = roomInput.value.trim();

  await startLocalMedia();
  socket.emit("join-room", roomId, { name: userName });

  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  toggleVideoBtn.disabled = false;
  toggleAudioBtn.disabled = false;
  shareScreenBtn.disabled = false;
  sendChatBtn.disabled = false;

  appendChat({ msg: "Waiting for others to join the meeting...", sender: "System" });
};


// --- Leave Room ---
leaveBtn.onclick = () => {
  for (const pid in pcs) pcs[pid].close();
  Object.values(remoteVideoEls).forEach(v => v.remove());
  Object.keys(pcs).forEach(k => delete pcs[k]);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  sendChatBtn.disabled = true;

  socket.disconnect();
  location.reload();
};

// --- Toggle Cam ---
toggleVideoBtn.onclick = () => {
  if (!localStream) return;
  const vidTrack = localStream.getVideoTracks()[0];
  if (!vidTrack) return;
  vidTrack.enabled = !vidTrack.enabled;
  toggleVideoBtn.textContent = vidTrack.enabled ? '🎥 Cam Off' : '🎥 Cam On';
};

// --- Toggle Mic ---
toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toggleAudioBtn.textContent = audioTrack.enabled ? '🎙️ Mic Off' : '🎙️ Mic On';
};

// --- Screen Share ---
shareScreenBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];

    for (const pid in pcs) {
      const sender = pcs[pid].getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    }

    screenTrack.onended = async () => {
      const camTrack = localStream.getVideoTracks()[0];
      for (const pid in pcs) {
        const sender = pcs[pid].getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack);
      }
    };
  } catch (e) {
    console.warn('Screen share failed', e);
  }
};

// --- Start Camera ---
async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const localV = document.createElement('video');
  localV.autoplay = true;
  localV.muted = true;
  localV.playsInline = true;
  localV.srcObject = localStream;
  localV.dataset.type = 'local';
  videoGrid.appendChild(localV);
  resizeGrid();
}

// --- Socket.IO handlers ---
socket.on('connect', () => console.log('✅ Connected to signalling server:', socket.id));

socket.on('existing-peers', async (existing) => {
  for (const peerId of existing) await createOffer(peerId);
});

socket.on('new-peer', ({ peerId, info }) => {
  appendChat({ msg: `${info.name || 'Someone'} joined the meeting.`, sender: 'System' });
});

socket.on('signal', async ({ from, data }) => {
  if (data.type === 'offer') await handleOffer(from, data);
  else if (data.type === 'answer') await handleAnswer(from, data);
  else if (data.type === 'ice') {
    const pc = pcs[from];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

socket.on('peer-left', (peerId) => {
  appendChat({ msg: "A participant left the meeting.", sender: "System" });
  if (remoteVideoEls[peerId]) {
    remoteVideoEls[peerId].remove();
    delete remoteVideoEls[peerId];
    resizeGrid();
  }
  if (pcs[peerId]) {
    pcs[peerId].close();
    delete pcs[peerId];
  }
});

// --- Chat System ---
sendChatBtn.onclick = sendChatMessage;
chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

function sendChatMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !roomId) return;
  socket.emit('send-chat', { roomId, msg, sender: userName });
  appendChat({ msg, sender: 'me' });
  chatInput.value = '';
}

socket.on('chat', m => appendChat({ msg: m.msg, sender: m.sender }));

function appendChat({ msg, sender }) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' +
    (sender === 'me' ? 'you' : sender === 'System' ? 'system' : 'other');
  div.textContent = (sender === 'me')
    ? `You: ${msg}`
    : sender === 'System'
    ? msg
    : `${sender}: ${msg}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;

  const chatPanel = document.getElementById('chatPanel');
  if (!chatPanel.classList.contains('open') && sender !== 'me') {
    chatPanel.classList.add('open');
  }
}

// --- WebRTC connections ---
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(cfg);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (ev) => {
    if (!remoteVideoEls[peerId]) {
      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = ev.streams[0];
      v.dataset.peer = peerId;
      videoGrid.appendChild(v);
      remoteVideoEls[peerId] = v;
      resizeGrid();
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, from: socket.id, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (remoteVideoEls[peerId]) {
        remoteVideoEls[peerId].remove();
        delete remoteVideoEls[peerId];
        resizeGrid();
      }
      pc.close();
      delete pcs[peerId];
    }
  };

  pcs[peerId] = pc;
  return pc;
}

async function createOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, from: socket.id, data: offer });
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('signal', { to: from, from: socket.id, data: answer });
}

async function handleAnswer(from, answer) {
  const pc = pcs[from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

// --- Auto layout like Zoom (FIXED GRID) ---
function resizeGrid() {
  const grid = document.getElementById('videoGrid');
  const videos = Array.from(grid.querySelectorAll('video'));
  const count = videos.length;

  if (count === 0) return;

  let cols = 1;
  if (count === 1) cols = 1;
  else if (count === 2) cols = 2;
  else if (count <= 4) cols = 2;
  else if (count <= 6) cols = 3;
  else if (count <= 9) cols = 3;
  else cols = 4;

  const rows = Math.ceil(count / cols);
  const width = 100 / cols;
  const height = 100 / rows;

  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.style.justifyItems = 'center';
  grid.style.alignItems = 'center';
  grid.style.gap = '8px';

  videos.forEach((v) => {
    v.style.width = `${width}vw`;
    v.style.height = `${height}vh`;
    v.style.objectFit = 'cover';
    v.style.borderRadius = '12px';
  });
}
