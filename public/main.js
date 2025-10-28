// main.js
const SERVER = (location.hostname === 'localhost') ? 'http://localhost:3000' : 'https://zoomlite.onrender.com';
const socket = io(SERVER);

const cfg = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:relay1.expressturn.com:3478',
      username: 'efree',
      credential: 'efree'
    }
  ]
};


const pcs = {}; // peerId -> RTCPeerConnection
const remoteVideoEls = {}; // peerId -> video element
let localStream = null;
let roomId = null;

const videos = document.getElementById('videos');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const toggleVideoBtn = document.getElementById('toggleVideoBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const roomInput = document.getElementById('room');
const chatin = document.getElementById('chatin');
const sendChatBtn = document.getElementById('sendChatBtn');

joinBtn.onclick = async () => {
  if (!roomInput.value) return alert('Enter a room id');
  roomId = roomInput.value;
  await startLocalMedia();
  socket.emit('join-room', roomId, { name: 'guest' });
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  toggleVideoBtn.disabled = false;
  toggleAudioBtn.disabled = false;
  shareScreenBtn.disabled = false;
  sendChatBtn.disabled = false;
};

leaveBtn.onclick = () => {
  // close connections
  for (const pid in pcs) pcs[pid].close();
  Object.values(remoteVideoEls).forEach(v => v.remove());
  Object.keys(pcs).forEach(k => delete pcs[k]);
  for (const t of localStream.getTracks()) t.stop();
  socket.disconnect();
  location.reload();
};

toggleVideoBtn.onclick = () => {
  if (!localStream) return;
  const vidTrack = localStream.getVideoTracks()[0];
  if (!vidTrack) return;
  vidTrack.enabled = !vidTrack.enabled;
  toggleVideoBtn.textContent = vidTrack.enabled ? 'Cam Off' : 'Cam On';
};

toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toggleAudioBtn.textContent = audioTrack.enabled ? 'Mic Off' : 'Mic On';
};

shareScreenBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    // replace tracks for all peer connections
    const screenTrack = screenStream.getVideoTracks()[0];
    for (const pid in pcs) {
      const sender = pcs[pid].getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    }
    // when screen sharing stops, revert to camera
    screenTrack.onended = async () => {
      const camTrack = localStream.getVideoTracks()[0];
      for (const pid in pcs) {
        const sender = pcs[pid].getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(camTrack);
      }
    };
  } catch (e) {
    console.warn('screen share failed', e);
  }
};

sendChatBtn.onclick = () => {
  const msg = chatin.value.trim();
  if (!msg) return;
  socket.emit('send-chat', { roomId, msg, sender: socket.id });
  appendChat({ msg, sender: 'me' });
  chatin.value = '';
};

function appendChat({ msg, sender }) {
  const d = document.createElement('div');
  d.textContent = (sender === 'me') ? `You: ${msg}` : `${sender}: ${msg}`;
  d.style.padding = '6px';
  d.style.fontSize = '13px';
  d.style.opacity = '0.85';
  videos.appendChild(d);
  videos.scrollTop = videos.scrollHeight;
}

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  // show local video
  const localV = document.createElement('video');
  localV.autoplay = true;
  localV.muted = true; // avoid echo
  localV.playsInline = true;
  localV.srcObject = localStream;
  videos.prepend(localV);
}

// Signalling handlers
socket.on('connect', () => console.log('connected to signalling', socket.id));

socket.on('existing-peers', async (existing) => {
  // existing = array of peer ids already in room
  for (const peerId of existing) await createOffer(peerId);
});

socket.on('new-peer', async ({ peerId }) => {
  // someone new joined — wait for their offer; but we can create answer when they offer
  console.log('new peer joined', peerId);
  // nothing to do until they send offer
});

socket.on('signal', async ({ from, data }) => {
  // data.type can be 'offer' / 'answer' / 'ice'
  if (data.type === 'offer') {
    await handleOffer(from, data);
  } else if (data.type === 'answer') {
    await handleAnswer(from, data);
  } else if (data.type === 'ice') {
    const pc = pcs[from];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

socket.on('peer-left', (peerId) => {
  if (remoteVideoEls[peerId]) {
    remoteVideoEls[peerId].remove();
    delete remoteVideoEls[peerId];
  }
  if (pcs[peerId]) {
    pcs[peerId].close();
    delete pcs[peerId];
  }
});

// chat
socket.on('chat', m => appendChat({ msg: m.msg, sender: m.sender }));

// create peer connection & attach local tracks
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(cfg);

  // add local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // when remote track arrives, create a video element
  pc.ontrack = (ev) => {
    if (!remoteVideoEls[peerId]) {
      const v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = ev.streams[0];
      videos.appendChild(v);
      remoteVideoEls[peerId] = v;
    } else {
      remoteVideoEls[peerId].srcObject = ev.streams[0];
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, from: socket.id, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      if (remoteVideoEls[peerId]) remoteVideoEls[peerId].remove();
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
  if (!pc) return console.warn('no pc for', from);
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

