// main.js — ZoomLite Avatar Synced + Blue Electric Speaker Glow ⚡️

const SERVER =
  location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://zoomlite.onrender.com";

const socket = io(SERVER);

// ---- Persisted user data from index.html modal ----
let userData = JSON.parse(localStorage.getItem("userData")) || null;
let userName = userData?.name || null;
let avatarData = userData?.avatar || null;

// ---- WebRTC state ----
const pcs = {};                    // peerId -> RTCPeerConnection
const remoteVideoEls = {};         // peerId -> <video>
const peerContainers = {};         // peerId -> .video-container (for glow)
const peerNames = {};              // peerId -> name (from 'new-peer' event)
let localStream = null;
let roomId = null;

// ---- Audio analysis (VAD) ----
let audioCtx;
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    console.log("🎧 AudioContext unlocked");
  }
}

const vadLoops = new Map(); // streamId -> { rafId, analyser, source, container }

// ---- ICE config ----
const cfg = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// ---- Elements ----
const videoGrid = document.getElementById("videoGrid");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomInput = document.getElementById("room");
const leaveBtn = document.getElementById("leaveBtn");
const toggleVideoBtn = document.getElementById("toggleVideoBtn");
const toggleAudioBtn = document.getElementById("toggleAudioBtn");
const shareScreenBtn = document.getElementById("shareScreenBtn");
const chatToggleBtn = document.getElementById("chatToggleBtn");
const chatPanel = document.getElementById("chatPanel");
const sendChatBtn = document.getElementById("sendChatBtn");
const chatInput = document.getElementById("chatin");
const chatMessages = document.getElementById("chatMessages");
const roomDisplay = document.getElementById("roomDisplay");
const activeControls = document.getElementById("activeControls");

// ---- Helpers: Avatar generation (uses saved gradient if available for self) ----
function generateAvatar(name, peerId, savedGradient) {
  const letter = (name || "?").charAt(0).toUpperCase();
  let gradient = savedGradient;
  if (!gradient) {
    // unique but deterministic per peer
    const seed = [...peerId].reduce((a, c) => a + c.charCodeAt(0), 0);
    const hue = seed % 360;
    const hue2 = (hue + 90 + (seed % 50)) % 360;
    gradient = `linear-gradient(135deg, hsl(${hue}, 80%, 55%), hsl(${hue2}, 80%, 55%))`;
  }

  const div = document.createElement("div");
  div.className =
    "avatar w-full h-full flex items-center justify-center text-5xl font-bold text-white select-none";
  div.style.background = gradient;
  div.textContent = letter;
  return div;
}

// ---- UI: Chat helpers ----
function appendChat({ msg, sender }) {
  const div = document.createElement("div");
  div.className =
    "chat-msg p-2 rounded-lg max-w-[80%] break-words text-sm text-slate-200";
  div.textContent = `${sender}: ${msg}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ---- VAD: Start analyser loop for a given MediaStream -> container glow ----
function startVAD(stream, container) {
  try {
    if (!stream || !stream.getAudioTracks().length) return;

    const id = stream.id;
    // If already analyzing, skip
    if (vadLoops.has(id)) return;

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastActiveTs = 0;

    const ACTIVE_CLASS =
      "ring-4 ring-blue-500/70 shadow-[0_0_24px_rgba(59,130,246,0.65)] transition-shadow duration-150";

    function tick(ts) {
      analyser.getByteFrequencyData(data);
      // Simple energy calc
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length) / 255; // 0..1

      // Threshold tweak: ~ speaking around >0.08–0.12 commonly
      const speaking = rms > 0.1;

      if (speaking) {
        lastActiveTs = ts;
        container.classList.add(...ACTIVE_CLASS.split(" "));
      } else {
        // decay after ~600ms silence
        if (ts - lastActiveTs > 600) {
          container.classList.remove(...ACTIVE_CLASS.split(" "));
        }
      }

      const rafId = requestAnimationFrame(tick);
      vadLoops.set(id, { rafId, analyser, source, container });
    }

    const rafId = requestAnimationFrame(tick);
    vadLoops.set(id, { rafId, analyser, source, container });
  } catch (e) {
    // Some browsers block AudioContext without user gesture; fail silently
    console.warn("VAD init failed:", e);
  }
}

function stopVADForStream(stream) {
  const entry = vadLoops.get(stream.id);
  if (!entry) return;
  cancelAnimationFrame(entry.rafId);
  try {
    entry.source.disconnect();
    entry.analyser.disconnect();
  } catch {}
  vadLoops.delete(stream.id);
}

// ---- Meeting flows ----
createRoomBtn.onclick = () => {
  const randomId = Math.random().toString(36).substring(2, 8);
  roomId = randomId;
  roomDisplay.textContent = `Room ID: ${roomId}`;
  roomDisplay.textContent += " • HD 🎥";
  startMeeting(roomId);
};

joinRoomBtn.onclick = () => {
  ensureAudioContext();
  const val = prompt("Enter Room ID:");
  if (!val) return;
  roomId = val.trim();
  roomDisplay.textContent = `Room ID: ${roomId}`;
  startMeeting(roomId);
};

async function startMeeting(room) {
  const stored = JSON.parse(localStorage.getItem("userData"));
  if (stored?.name) {
    userName = stored.name;
    avatarData = stored.avatar;
  }

  if (!userName) return alert("Please enter your name first!");

  createRoomBtn.disabled = true;
  joinRoomBtn.disabled = true;
  activeControls.classList.remove("hidden");

  leaveBtn.disabled = false;
  toggleVideoBtn.disabled = false;
  toggleAudioBtn.disabled = false;
  shareScreenBtn.disabled = false;
  sendChatBtn.disabled = false;

  await startLocalMedia();
  const videoOn = localStream?.getVideoTracks()?.[0]?.enabled ?? true;
socket.emit("join-room", room, {
  name: userName,
  avatar: avatarData,
  videoEnabled: videoOn,
});


  appendChat({ msg: "Waiting for others to join...", sender: "System" });
}
``

// ---- Local media + self-view ----
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: 1920 },   // target 1080p
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: "user"        // front camera on mobile
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});


    const container = document.createElement("div");
    container.className =
      "video-container self-view absolute w-44 h-32 bottom-4 right-4 rounded-xl overflow-hidden border border-slate-700 shadow-lg bg-black/40";
    peerContainers["self"] = container;

    // Avatar (synced gradient from modal)
    const avatar = generateAvatar(userName, "self", avatarData?.gradient);
    avatar.style.display = "none";
    container.appendChild(avatar);

    // Video
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = localStream;
    container.appendChild(video);

    videoGrid.appendChild(container);
    resizeGrid();

    // Start VAD glow for self
    startVAD(localStream, container);
  } catch (err) {
    console.error("Media error:", err);
    alert("Camera or microphone access denied!");
  }
}

// ---- Controls ----
toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  toggleAudioBtn.classList.toggle("bg-accent1", track.enabled);
};

toggleVideoBtn.onclick = () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;

  const container = document.querySelector(".self-view");
  const video = container?.querySelector("video");
  const avatar = container?.querySelector(".avatar");

  if (track.enabled) {
    avatar.style.display = "none";
    video.style.display = "block";
  } else {
    avatar.style.display = "flex";
    video.style.display = "none";
  }
  // 🔁 notify everyone else about your camera state
socket.emit("video-state-change", {
  roomId,
  peerId: socket.id,
  enabled: track.enabled,
  name: userName,
  avatar: avatarData,
});

};

shareScreenBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
    });
    const screenTrack = screenStream.getVideoTracks()[0];

    for (const pid in pcs) {
      const sender = pcs[pid]
        .getSenders()
        .find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(screenTrack);
    }

    screenTrack.onended = async () => {
      const camTrack = localStream.getVideoTracks()[0];
      for (const pid in pcs) {
        const sender = pcs[pid]
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(camTrack);
      }
    };
  } catch (e) {
    console.warn("Screen share failed", e);
  }
};

leaveBtn.onclick = () => {
  for (const pid in pcs) pcs[pid].close();
  Object.values(remoteVideoEls).forEach((v) => v.parentElement?.remove());
  Object.keys(pcs).forEach((k) => delete pcs[k]);
  if (localStream) {
    stopVADForStream(localStream);
    localStream.getTracks().forEach((t) => t.stop());
  }
  socket.disconnect();
  location.reload();
};

// ---- Chat ----
chatToggleBtn.onclick = () => {
  if (chatPanel.classList.contains("open")) {
    chatPanel.classList.remove("open");
    chatPanel.style.width = "0";
    chatPanel.style.opacity = "0";
  } else {
    chatPanel.classList.add("open");
    chatPanel.style.width = "320px";
    chatPanel.style.opacity = "1";
  }
};

sendChatBtn.onclick = sendChat;
chatInput.addEventListener("keypress", (e) => e.key === "Enter" && sendChat());
function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg || !roomId) return;
  socket.emit("send-chat", { roomId, msg, sender: userName });
  appendChat({ msg, sender: "me" });
  chatInput.value = "";
}
socket.on("chat", (m) => appendChat({ msg: m.msg, sender: m.sender }));

// ---- Signalling ----
socket.on("connect", () => console.log("✅ Connected:", socket.id));

// When new peer joins
socket.on("new-peer", ({ peerId, info }) => {
  peerNames[peerId] = info?.name || "User";
  peerInfoCache[peerId] = info;
  appendChat({ msg: `${peerNames[peerId]} joined the meeting.`, sender: "System" });
});
const peerInfoCache = {}; // peerId -> { name, avatar, videoEnabled }

// When receiving existing peers
socket.on("existing-peers", async (existing) => {
  for (const { peerId, info } of existing) {
    peerNames[peerId] = info?.name || "User";
    peerInfoCache[peerId] = info;
    await createOffer(peerId);
    if (info && info.videoEnabled === false) {
      const container = peerContainers[peerId];
      const avatarDiv = container?.querySelector(".avatar");
      const video = container?.querySelector("video");
      if (avatarDiv && video) {
        avatarDiv.style.display = "flex";
        video.style.display = "none";
      }
    }
  }
});


socket.on("signal", async ({ from, data }) => {
  if (data.type === "offer") await handleOffer(from, data);
  else if (data.type === "answer") await handleAnswer(from, data);
  else if (data.type === "ice") {
    const pc = pcs[from];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

socket.on("peer-left", (peerId) => {
  appendChat({ msg: `${peerNames[peerId] || "A participant"} left.`, sender: "System" });
  if (remoteVideoEls[peerId]) {
    const c = remoteVideoEls[peerId].parentElement;
    c?.remove();
    delete remoteVideoEls[peerId];
    delete peerContainers[peerId];
  }
  if (pcs[peerId]) {
    pcs[peerId].close();
    delete pcs[peerId];
  }
  resizeGrid();
});

// 🔊 when a peer toggles their video, show/hide their avatar
socket.on("peer-video-state", ({ peerId, enabled, name, avatar }) => {
  const container = peerContainers[peerId];
  if (!container) return;
  const avatarDiv = container.querySelector(".avatar");
  const video = container.querySelector("video");

  if (enabled) {
    avatarDiv.style.display = "none";
    video.style.display = "block";
  } else {
    avatarDiv.style.display = "flex";
    video.style.display = "none";
  }
});


// ---- WebRTC helpers ----
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(cfg);
  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  // 💎 Boost outgoing video bitrate
pc.getSenders().forEach((sender) => {
  if (sender.track && sender.track.kind === "video") {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 2500 * 1000; // 2.5 Mbps max bitrate
    params.encodings[0].scaleResolutionDownBy = 1; // no quality downgrade
    sender.setParameters(params);
  }
});


  pc.ontrack = (ev) => {
    if (!remoteVideoEls[peerId]) {
      const container = document.createElement("div");
      container.className =
        "video-container rounded-xl overflow-hidden bg-black/40 shadow-md relative";
      peerContainers[peerId] = container;

      // Avatar uses peer's *actual* saved gradient (from server or event)
const info = peerInfoCache?.[peerId] || {}; // we'll set this up below
const gradient = info.avatar?.gradient;
const letter = info.avatar?.letter || (peerNames[peerId]?.[0]?.toUpperCase() || "?");
const avatar = generateAvatar(letter, peerId, gradient);

      avatar.style.display = "none";
      container.appendChild(avatar);

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = ev.streams[0];
      container.appendChild(video);

      videoGrid.appendChild(container);
      remoteVideoEls[peerId] = video;
      resizeGrid();

      // Start VAD glow for remote stream
      startVAD(ev.streams[0], container);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", {
        to: peerId,
        from: socket.id,
        data: { type: "ice", candidate: e.candidate },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      const c = remoteVideoEls[peerId]?.parentElement;
      c?.remove();
      delete remoteVideoEls[peerId];
      delete peerContainers[peerId];
      pcs[peerId]?.close();
      delete pcs[peerId];
      resizeGrid();
    }
  };

  pcs[peerId] = pc;
  return pc;
}

// 🧩 Prefer VP9 codec for better quality at same bitrate
function preferCodec(sdp, codec) {
  const lines = sdp.split("\r\n");
  const mLineIndex = lines.findIndex((l) => l.startsWith("m=video"));
  if (mLineIndex === -1) return sdp;

  const codecIndex = lines.findIndex((l) =>
    l.toLowerCase().includes(codec.toLowerCase())
  );
  if (codecIndex === -1) return sdp;

  const mLine = lines[mLineIndex].split(" ");
  const payload = lines[codecIndex].match(/a=rtpmap:(\d+)/)?.[1];
  if (payload) {
    const filtered = [
      mLine[0],
      mLine[1],
      mLine[2],
      payload,
      ...mLine.slice(3).filter((p) => p !== payload),
    ];
    lines[mLineIndex] = filtered.join(" ");
  }
  return lines.join("\r\n");
}


async function createOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  offer.sdp = preferCodec(offer.sdp, "VP9"); // 🧠 prioritize VP9 codec
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, from: socket.id, data: offer });
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("signal", { to: from, from: socket.id, data: answer });
}

async function handleAnswer(from, answer) {
  const pc = pcs[from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

function resizeGrid() {
  const containers = videoGrid.querySelectorAll(".video-container:not(.self-view)");
  const count = containers.length;

  // Reset layout
  containers.forEach((c) => {
    Object.assign(c.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      borderRadius: "12px",
      overflow: "hidden",
      zIndex: "1",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    // make the video fill its container fully
    const vid = c.querySelector("video");
    if (vid) {
      Object.assign(vid.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
      });
    }
  });

  // Reset grid classes
  videoGrid.className = "";
  videoGrid.classList.add("flex-1", "bg-slate-950", "grid", "gap-4", "p-4");

  // Determine grid based on participant count
  let cols = 1;
  if (count === 1) cols = 1;
  else if (count === 2) cols = 2;
  else if (count <= 4) cols = 2;
  else if (count <= 6) cols = 3;
  else if (count <= 9) cols = 3;
  else if (count <= 12) cols = 4;
  else cols = 4;

  const rows = Math.ceil(count / cols);
  videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // 🎥 self-view overlay
  const selfView = document.querySelector(".self-view");
  if (selfView) {
    Object.assign(selfView.style, {
      position: "fixed",
      bottom: "5rem",
      right: "2rem",
      width: "280px",
      height: "200px",
      borderRadius: "14px",
      overflow: "hidden",
      zIndex: "10",
      boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
      background: "#000",
      transition: "all 0.3s ease",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    const vid = selfView.querySelector("video");
    if (vid) {
      Object.assign(vid.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
      });
    }
  }
}


// 🔁 Recalculate layout on window resize or orientation change
window.addEventListener("resize", resizeGrid);
window.addEventListener("orientationchange", resizeGrid);


