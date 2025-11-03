// main.js — ZoomLite Avatar Synced + FCM FIXED ⚡️

const SERVER =
  location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://zoomlite.onrender.com";

const socket = io(SERVER);

// ---- Persisted user data ----
let userData = JSON.parse(localStorage.getItem("userData")) || null;
let userName = userData?.name || null;
let avatarData = userData?.avatar || null;

// ---- WebRTC state ----
const pcs = {};
const remoteVideoEls = {};
const peerContainers = {};
const peerNames = {};
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

const vadLoops = new Map();
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

// ---- UI elements ----
const videoGrid = document.getElementById("videoGrid");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const roomDisplay = document.getElementById("roomDisplay");
const activeControls = document.getElementById("activeControls");
const leaveBtn = document.getElementById("leaveBtn");
const toggleVideoBtn = document.getElementById("toggleVideoBtn");
const toggleAudioBtn = document.getElementById("toggleAudioBtn");
const shareScreenBtn = document.getElementById("shareScreenBtn");
const chatToggleBtn = document.getElementById("chatToggleBtn");
const chatPanel = document.getElementById("chatPanel");
const sendChatBtn = document.getElementById("sendChatBtn");
const chatInput = document.getElementById("chatin");
const chatMessages = document.getElementById("chatMessages");

let contacts = JSON.parse(localStorage.getItem("contacts")) || [];

function saveContact(name, avatarData) {
  // prevent duplicates
  const exists = contacts.some(c => c.name === name);
  if (exists) return;

  // add to list
  const newContact = { name, avatar: avatarData };
  contacts.push(newContact);

  // save permanently
  localStorage.setItem("contacts", JSON.stringify(contacts));

  if (name === userName) return;

  // render immediately if panel is open
  renderContactsList();
}


function renderContactsList() {
  const list = document.getElementById("contactsList");
  if (!list) return;

  list.innerHTML = "";

  if (contacts.length === 0) {
    list.innerHTML = `<p class="text-slate-400 text-sm">No contacts yet</p>`;
    return;
  }

  contacts.forEach(({ name, avatar }) => {
    const item = document.createElement("div");
    item.className =
      "flex justify-between items-center p-2 bg-slate-800/60 rounded-lg border border-slate-700 hover:bg-slate-700/50 transition";

    item.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-full flex items-center justify-center font-semibold text-white text-sm"
             style="background:${avatar?.gradient || 'linear-gradient(135deg,#3b82f6,#2563eb)'}">
          ${avatar?.letter || name.charAt(0).toUpperCase()}
        </div>
        <span class="text-slate-200 font-medium">${name}</span>
      </div>
    <button 
  class="px-3 py-1 text-sm rounded bg-accent1 hover:bg-accent2 transition"
  onclick="startCall('${name}')">
  📞 Call
</button>

    `;


    // Handle calling action
    const callBtn = item.querySelector("button");
    callBtn.onclick = () => {
      console.log(`📞 Calling ${name}...`);
      socket.emit("call-user", { from: userName, to: name });
    };

    list.appendChild(item);
  });
}


    // 📞 Start a direct call
function startCall(targetName) {
  const target = contacts.find((c) => c.name === targetName);
  if (!target) return alert("Contact not found!");

  const isOnline = window.onlineUsers.includes(targetName);
  if (!isOnline) return alert(`${targetName} is offline.`);

  socket.emit("call-user", { from: userName, to: targetName });
  showToast(`📞 Calling ${targetName}...`);
}



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

  // ✅ Tell backend you're joining this room
  socket.emit("join-room", room, {
    name: userName,
    avatar: avatarData,
    videoEnabled: true,
  });

  roomId = room;
  roomDisplay.textContent = `Room ID: ${room}`;
  appendChat({ msg: "Waiting for others to join...", sender: "System" });
}

socket.on("add-contact", (contactInfo) => {
  if (!contactInfo?.name) return;
  console.log(`👥 Mutual contact added: ${contactInfo.name}`);
  saveContact(contactInfo.name, contactInfo.avatar);
});



async function startLocalMedia() {
  try {
    console.log("🎥 Starting local camera...");

    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: "user"
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 🧱 Make container first
    const container = document.createElement("div");
    container.className =
      "video-container self-view absolute w-44 h-32 bottom-4 right-4 rounded-xl overflow-hidden border border-slate-700 shadow-lg bg-black/40";
    peerContainers["self"] = container;

    // Avatar (invisible by default)
    const avatar = generateAvatar(userName, "self", avatarData?.gradient);
    avatar.style.display = "none";
    container.appendChild(avatar);

    // 🎥 Actual video
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = localStream;
    container.appendChild(video);

    // 🧠 Attach to grid *before* playing
    videoGrid.appendChild(container);
    resizeGrid();

    // 🧃 Kickstart autoplay properly (mobile Chrome fix)
    await video.play().catch(() => {
      console.warn("🔇 Autoplay blocked — user gesture required");
    });

    // 🧠 Keep the track references
    console.log("✅ Local media started:", localStream.getTracks());

    // 🎤 Start voice activity glow
    ensureAudioContext();
    startVAD(localStream, container);
  } catch (err) {
    console.error("🚨 Media error:", err);
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

chatToggleBtn.onclick = () => {
  const selfView = document.querySelector(".self-view");
  const chatIsOpen = chatPanel.classList.contains("open");

  if (chatIsOpen) {
    // CLOSE chat
    chatPanel.classList.remove("open");
    chatPanel.style.width = "0";
    chatPanel.style.opacity = "0";
    videoGrid.style.width = "100%";

    if (selfView) {
      selfView.style.right = "1rem"; // back to corner
    }
  } else {
    // OPEN chat
    chatPanel.classList.add("open");
    chatPanel.style.width = "320px";
    chatPanel.style.opacity = "1";
    videoGrid.style.width = "calc(100% - 320px)";
    videoGrid.style.transition = "width 0.3s ease";

    if (selfView) {
      selfView.style.right = "calc(1rem + 320px)";
    }
  }

  // Trigger grid resize to reposition self-view if needed
  resizeGrid();
};


const contactsMainBtn = document.getElementById("contactsMainBtn");
const contactsPanel = document.getElementById("contactsPanel");
const closeContacts = document.getElementById("closeContacts");

contactsMainBtn.onclick = () => {
  const isOpen = contactsPanel.classList.contains("open");
  if (isOpen) {
    contactsPanel.classList.remove("open");
    contactsPanel.style.width = "0";
    contactsPanel.style.opacity = "0";
  } else {
    contactsPanel.classList.add("open");
    contactsPanel.style.width = "320px";
    contactsPanel.style.opacity = "1";
  }
};

closeContacts.onclick = () => {
  contactsPanel.classList.remove("open");
  contactsPanel.style.width = "0";
  contactsPanel.style.opacity = "0";
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

socket.on("connect", () => {
  console.log("✅ Connected:", socket.id);
  if (userName) {
    console.log("🧠 Re-registering user:", userName);
    socket.emit("register-user", userName);
  }
});


// 🟢 Track online users
window.onlineUsers = [];

socket.on("online-users", (users) => {
  window.onlineUsers = users;
  renderContactsList();
});

socket.on("user-online", (name) => {
  if (!window.onlineUsers.includes(name)) window.onlineUsers.push(name);
  renderContactsList();
});

socket.on("user-offline", (name) => {
  window.onlineUsers = window.onlineUsers.filter((n) => n !== name);
  renderContactsList();
});


// When new peer joins
socket.on("new-peer", ({ peerId, info }) => {
  peerNames[peerId] = info?.name || "User";
  peerInfoCache[peerId] = info;
  appendChat({ msg: `${peerNames[peerId]} joined the meeting.`, sender: "System" });

  // 🧠 Auto-save to contacts
  if (info?.name && info?.avatar) {
    saveContact(info.name, info.avatar);
  }
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

  // 🧽 Clean layout for all video containers
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
      background: "rgba(0,0,0,0.45)",
      boxShadow: "0 0 10px rgba(0,0,0,0.3)",
      transition: "all 0.3s ease",
    });

    const vid = c.querySelector("video");
    if (vid) {
      Object.assign(vid.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        borderRadius: "inherit",
      });
    }
  });

  // 🧩 Reset grid
  videoGrid.className = "";
  videoGrid.classList.add("flex-1", "bg-slate-950", "grid", "gap-3", "p-3");
  videoGrid.style.position = "relative";

  // 📱 Detect screen size
  const isMobile = window.innerWidth < 768;
  const isTablet = window.innerWidth >= 768 && window.innerWidth < 1024;

  // 🧠 Smart grid logic
  let cols;
  if (isMobile) {
  if (count === 1) cols = 1;
  else if (count === 2) cols = 2;
  else if (count <= 4) cols = 2;
  else if (count <= 6) cols = 3;
  else cols = 3;

  // force square layout look
  videoGrid.style.gridAutoRows = "minmax(120px, 1fr)";
  videoGrid.style.gridAutoColumns = "minmax(120px, 1fr)";
  } else if (isTablet) {
    if (count <= 2) cols = 2;
    else if (count <= 4) cols = 2;
    else if (count <= 6) cols = 3;
    else cols = 3;
  } else {
    if (count === 1) cols = 1;
    else if (count === 2) cols = 2;
    else if (count <= 4) cols = 2;
    else if (count <= 6) cols = 3;
    else if (count <= 9) cols = 3;
    else if (count <= 12) cols = 4;
    else cols = 4;
  }

  const rows = Math.ceil(count / cols);
  Object.assign(videoGrid.style, {
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
    justifyItems: "stretch",
    alignItems: "stretch",
    height: "100%",
    width: "100%",
  });

  // 📏 Force all boxes to fill grid
  containers.forEach((c) => {
    Object.assign(c.style, {
      width: "100%",
      height: "100%",
      aspectRatio: "auto",
    });
  });

  // 🎥 Self-view (only PiP on non-mobile)
  const selfView = document.querySelector(".self-view");
  if (selfView) {
    if (isMobile) {
      // 👇 Make self-view join the grid
      Object.assign(selfView.style, {
        position: "relative",
        bottom: "auto",
        right: "auto",
        width: "100%",
        height: "100%",
        borderRadius: "12px",
        zIndex: "1",
        boxShadow: "none",
        background: "rgba(0,0,0,0.45)",
        pointerEvents: "auto",
      });

      // make sure it’s *inside* the grid properly
      if (!videoGrid.contains(selfView)) {
        videoGrid.appendChild(selfView);
      }
    } else {
      // 💻 Normal desktop PiP bottom-right
      const chatIsOpen = chatPanel.classList.contains("open");
      const rightOffset = chatIsOpen ? "calc(320px + 1rem)" : "1rem";

      Object.assign(selfView.style, {
        position: "fixed",
        bottom: "4.5rem",
        right: rightOffset,
        width: "260px",
        height: "185px",
        borderRadius: "14px",
        overflow: "hidden",
        zIndex: "99",
        boxShadow: "0 6px 30px rgba(0,0,0,0.6)",
        background: "#000",
        transition: "all 0.25s cubic-bezier(.25,.8,.25,1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
        backdropFilter: "blur(6px)",
        border: "1px solid rgba(255,255,255,0.08)",
      });

      // ensure it's appended last (top layer)
      document.body.appendChild(selfView);
    }

    // make video fill container always
    const vid = selfView.querySelector("video");
    if (vid) {
      Object.assign(vid.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        borderRadius: "inherit",
      });
    }
  }
  // 🧍 If alone in the room on mobile — go full screen
if (isMobile && count === 0) {
  const selfView = document.querySelector(".self-view");
  if (selfView) {
    Object.assign(selfView.style, {
      position: "relative",
      width: "100vw",
      height: "calc(100vh - 5rem)", // subtracts navbar height if you have one
      borderRadius: "0",
      zIndex: "1",
      boxShadow: "none",
      background: "#000",
      margin: "0",
    });

    const vid = selfView.querySelector("video");
    if (vid) {
      Object.assign(vid.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        borderRadius: "0",
      });
    }
  }

  // prevent grid from squishing
  Object.assign(videoGrid.style, {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  });
}

}

// 🔁 Recalculate layout on window resize or orientation change
window.addEventListener("resize", resizeGrid);
window.addEventListener("orientationchange", resizeGrid);
renderContactsList();

function showToast(msg) {
  const toast = document.createElement("div");
  toast.className = "fixed bottom-5 right-5 bg-slate-800 text-white px-4 py-2 rounded-lg shadow-lg opacity-90 z-50";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

socket.on("add-contact", (contactInfo) => {
  if (!contactInfo?.name) return;
  saveContact(contactInfo.name, contactInfo.avatar);
  showToast(`👋 ${contactInfo.name} added to your contacts`);
});



window.addEventListener("nameSet", async () => {
  console.log("🎯 Event: nameSet triggered — waiting 1s for Firebase...");
  await new Promise((r) => setTimeout(r, 1000));
  
  // 🧠 make sure server knows who you are
  socket.emit("register-user", userName);

  if (typeof registerUserFCM === "function") {
    registerUserFCM();
  }
});



// 🎵 Ringtone
const ringtone = new Audio("ringtone.mp3");
ringtone.loop = true;

// 📩 Incoming call
socket.on("incoming-call", ({ from }) => {
  console.log(`📞 Incoming call from ${from}`);
  ringtone.play();

  const modal = document.createElement("div");
  modal.className =
    "fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm z-[9999]";
  modal.innerHTML = `
    <div class="bg-slate-800/90 rounded-2xl p-6 shadow-2xl border border-slate-700 text-center animate-pop">
      <h2 class="text-xl font-semibold mb-3">📞 Incoming Call</h2>
      <p class="text-slate-300 mb-5">${from} is calling you...</p>
      <div class="flex justify-center gap-4">
        <button id="acceptCall" class="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-600 transition">Accept</button>
        <button id="rejectCall" class="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 transition">Reject</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const acceptBtn = modal.querySelector("#acceptCall");
  const rejectBtn = modal.querySelector("#rejectCall");

  acceptBtn.onclick = () => {
    ringtone.pause();
    modal.remove();
    const roomId = `${from}-${userName}-${Date.now()}`;
    socket.emit("accept-call", { from, roomId });
    startMeeting(roomId);
  };

  rejectBtn.onclick = () => {
    ringtone.pause();
    modal.remove();
    socket.emit("reject-call", { from });
  };
});

// 💚 Call accepted
socket.on("call-accepted", ({ roomId, by }) => {
  showToast(`✅ ${by} accepted your call`);
  startMeeting(roomId);
});

// 💔 Call rejected
socket.on("call-rejected", ({ by }) => {
  ringtone.pause();
  showToast(`❌ ${by} rejected your call`);
});
