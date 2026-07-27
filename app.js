'use strict';

const elements = {
  prejoinView: document.querySelector('#prejoinView'),
  meetingView: document.querySelector('#meetingView'),
  joinForm: document.querySelector('#joinForm'),
  nameInput: document.querySelector('#nameInput'),
  roomInput: document.querySelector('#roomInput'),
  newRoomButton: document.querySelector('#newRoomButton'),
  modeButtons: Array.from(document.querySelectorAll('.mode-option')),
  joinButton: document.querySelector('#joinButton'),
  joinButtonLabel: document.querySelector('#joinButtonLabel'),
  joinError: document.querySelector('#joinError'),
  previewStage: document.querySelector('#previewStage'),
  previewVideo: document.querySelector('#previewVideo'),
  previewAvatar: document.querySelector('#previewAvatar'),
  previewLabel: document.querySelector('#previewLabel'),
  previewMicStatus: document.querySelector('#previewMicStatus'),
  previewCameraStatus: document.querySelector('#previewCameraStatus'),
  permissionHint: document.querySelector('#permissionHint'),
  meetingRoomName: document.querySelector('#meetingRoomName'),
  elapsedTime: document.querySelector('#elapsedTime'),
  participantCount: document.querySelector('#participantCount'),
  videoGrid: document.querySelector('#videoGrid'),
  roomCodeDisplay: document.querySelector('#roomCodeDisplay'),
  micButton: document.querySelector('#micButton'),
  cameraButton: document.querySelector('#cameraButton'),
  inviteButton: document.querySelector('#inviteButton'),
  leaveButton: document.querySelector('#leaveButton'),
  connectionBanner: document.querySelector('#connectionBanner'),
  participantTemplate: document.querySelector('#participantTemplate'),
  toast: document.querySelector('#toast')
};

const defaultRtcConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};

const state = {
  mode: 'video',
  roomId: '',
  displayName: '',
  localStream: new MediaStream(),
  mediaQueue: Promise.resolve(),
  socket: null,
  selfId: null,
  peers: new Map(),
  rtcConfiguration: defaultRtcConfiguration,
  joining: false,
  joined: false,
  intentionalClose: false,
  joinResolve: null,
  joinReject: null,
  joinTimeout: null,
  startedAt: null,
  timer: null
};

const roomWords = {
  first: ['amber', 'brisk', 'calm', 'clear', 'coral', 'fresh', 'gold', 'kind', 'lucky', 'mint', 'open', 'quiet', 'rapid', 'solar', 'warm'],
  second: ['bird', 'brook', 'cloud', 'field', 'grove', 'harbor', 'leaf', 'moon', 'orbit', 'pine', 'river', 'spark', 'stone', 'wave', 'willow']
};

let toastTimer;

function randomItem(items) {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return items[values[0] % items.length];
}

function generateRoomId() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return `${randomItem(roomWords.first)}-${randomItem(roomWords.second)}-${100 + (values[0] % 900)}`;
}

function normalizeRoomId(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return 'Y';
  }

  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function getLiveTrack(kind) {
  return state.localStream.getTracks().find((track) => track.kind === kind && track.readyState === 'live');
}

function getLocalMediaState() {
  const audioTrack = getLiveTrack('audio');
  const videoTrack = getLiveTrack('video');
  return {
    audio: Boolean(audioTrack && audioTrack.enabled),
    video: Boolean(videoTrack && videoTrack.enabled)
  };
}

function setUseIcon(container, iconId) {
  const use = container.querySelector('use');
  if (use) {
    use.setAttribute('href', `#${iconId}`);
  }
}

function mediaErrorMessage(error) {
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    return 'Camera and microphone access requires HTTPS.';
  }
  if (error && error.name === 'NotAllowedError') {
    return 'Camera or microphone permission was blocked. Allow access in your browser settings.';
  }
  if (error && error.name === 'NotFoundError') {
    return 'No matching camera or microphone was found.';
  }
  if (error && error.name === 'NotReadableError') {
    return 'Your camera or microphone is already in use by another app.';
  }
  return 'Could not access your camera or microphone.';
}

function bindTrackEnd(track) {
  track.addEventListener('ended', () => {
    state.localStream.removeTrack(track);
    syncLocalMediaUi();
    sendMediaState();
  }, { once: true });
}

async function acquireForMode(mode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Media devices are not supported in this browser.');
  }

  if (mode === 'audio') {
    for (const videoTrack of state.localStream.getVideoTracks()) {
      videoTrack.stop();
      state.localStream.removeTrack(videoTrack);
    }
  }

  const needsAudio = !getLiveTrack('audio');
  const needsVideo = mode === 'video' && !getLiveTrack('video');

  if (!needsAudio && !needsVideo) {
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: needsAudio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    } : false,
    video: needsVideo ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    } : false
  });

  for (const track of stream.getTracks()) {
    state.localStream.addTrack(track);
    bindTrackEnd(track);
  }
}

function ensureMedia(mode) {
  const request = state.mediaQueue
    .catch(() => undefined)
    .then(() => acquireForMode(mode));
  state.mediaQueue = request;
  return request;
}

async function acquireSingleTrack(kind) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Media devices are not supported in this browser.');
  }

  const constraints = kind === 'audio'
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
    : { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getTracks()[0];

  state.localStream.addTrack(track);
  bindTrackEnd(track);
  await attachTrackToPeers(track);
  return track;
}

async function attachTrackToPeers(track) {
  const replacements = [];

  for (const peer of state.peers.values()) {
    const matchingSender = peer.connection.getSenders().find((sender) => sender.track && sender.track.kind === track.kind);
    if (matchingSender) {
      replacements.push(matchingSender.replaceTrack(track));
    } else {
      peer.connection.addTrack(track, state.localStream);
    }
  }

  await Promise.allSettled(replacements);
}

function syncPreview() {
  const media = getLocalMediaState();
  const name = elements.nameInput.value.trim() || state.displayName || 'You';

  if (state.localStream.getTracks().length && elements.previewVideo.srcObject !== state.localStream) {
    elements.previewVideo.srcObject = state.localStream;
  } else if (!state.localStream.getTracks().length && elements.previewVideo.srcObject) {
    elements.previewVideo.srcObject = null;
  }

  elements.previewStage.classList.toggle('camera-on', media.video);
  elements.previewAvatar.textContent = getInitials(name);
  elements.previewLabel.textContent = name;

  elements.previewMicStatus.classList.toggle('is-off', !media.audio);
  elements.previewMicStatus.lastChild.textContent = media.audio ? ' Mic on' : ' Mic off';
  setUseIcon(elements.previewMicStatus, media.audio ? 'icon-mic' : 'icon-mic-off');

  elements.previewCameraStatus.classList.toggle('is-off', !media.video);
  elements.previewCameraStatus.lastChild.textContent = media.video ? ' Camera on' : ' Camera off';
  setUseIcon(elements.previewCameraStatus, media.video ? 'icon-camera' : 'icon-camera-off');
}

function syncControlButton(button, enabled, kind) {
  button.classList.toggle('is-off', !enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `Turn ${kind} ${enabled ? 'off' : 'on'}`);
}

function syncLocalMediaUi() {
  const media = getLocalMediaState();
  syncPreview();
  syncControlButton(elements.micButton, media.audio, 'microphone');
  syncControlButton(elements.cameraButton, media.video, 'camera');

  const localTile = elements.videoGrid.querySelector('[data-local="true"]');
  if (localTile) {
    updateTileMedia(localTile, media, state.localStream);
  }
}

function send(message) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function sendMediaState() {
  if (!state.joined) {
    return;
  }

  send({ type: 'media-state', media: getLocalMediaState() });
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function createParticipantTile(id, name, media, stream, isLocal = false) {
  const tile = elements.participantTemplate.content.firstElementChild.cloneNode(true);
  const video = tile.querySelector('video');

  tile.dataset.peerId = id;
  tile.dataset.local = String(isLocal);
  tile.classList.toggle('is-local', isLocal);
  tile.querySelector('.tile-name').textContent = isLocal ? `${name} (You)` : name;
  tile.querySelector('.tile-avatar').textContent = getInitials(name);
  video.muted = isLocal;
  video.srcObject = stream;
  video.addEventListener('loadedmetadata', () => {
    video.play().catch(() => {
      if (!isLocal) {
        showToast('Tap the page to start participant audio.');
      }
    });
    updateTileMedia(tile, media, stream);
  });

  updateTileMedia(tile, media, stream);
  elements.videoGrid.append(tile);
  updateParticipantCount();
  return tile;
}

function updateTileMedia(tile, media, stream) {
  const liveVideo = stream && stream.getVideoTracks().some((track) => track.readyState === 'live');
  const cameraOn = Boolean(media.video && liveVideo);
  const micOn = Boolean(media.audio);

  tile.classList.toggle('camera-on', cameraOn);
  tile.classList.toggle('mic-off', !micOn);
  const micStatus = tile.querySelector('.tile-mic');
  micStatus.setAttribute('aria-label', micOn ? 'Microphone on' : 'Microphone off');
}

function updateParticipantCount() {
  const count = state.joined ? state.peers.size + 1 : 0;
  elements.participantCount.textContent = String(count);
  elements.videoGrid.dataset.count = String(Math.min(count, 4));
}

function updatePeerConnectionState(peer) {
  const connectionState = peer.connection.connectionState;
  peer.tile.classList.toggle('is-connected', connectionState === 'connected');
  peer.tile.classList.toggle('has-failed', connectionState === 'failed');
  const label = peer.tile.querySelector('.tile-connection');

  if (connectionState === 'failed') {
    label.textContent = 'Connection failed';
  } else if (connectionState === 'disconnected') {
    label.textContent = 'Reconnecting';
  } else {
    label.textContent = 'Connecting';
  }
}

function sendSignal(target, payload) {
  send({ type: 'signal', target, payload });
}

function createPeer(peerInfo) {
  const existing = state.peers.get(peerInfo.id);
  if (existing) {
    existing.name = peerInfo.name || existing.name;
    existing.media = peerInfo.media || existing.media;
    existing.tile.querySelector('.tile-name').textContent = existing.name;
    existing.tile.querySelector('.tile-avatar').textContent = getInitials(existing.name);
    updateTileMedia(existing.tile, existing.media, existing.stream);
    return existing;
  }

  const connection = new RTCPeerConnection(state.rtcConfiguration);
  const remoteStream = new MediaStream();
  const peer = {
    id: peerInfo.id,
    name: peerInfo.name || 'Guest',
    media: peerInfo.media || { audio: true, video: true },
    connection,
    stream: remoteStream,
    tile: null,
    polite: state.selfId.localeCompare(peerInfo.id) > 0,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    pendingCandidates: []
  };

  state.peers.set(peer.id, peer);
  peer.tile = createParticipantTile(peer.id, peer.name, peer.media, remoteStream);

  connection.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) {
      sendSignal(peer.id, { candidate });
    }
  });

  connection.addEventListener('track', (event) => {
    if (event.streams[0]) {
      peer.stream = event.streams[0];
    } else if (!peer.stream.getTracks().includes(event.track)) {
      peer.stream.addTrack(event.track);
    }

    const video = peer.tile.querySelector('video');
    if (video.srcObject !== peer.stream) {
      video.srcObject = peer.stream;
    }

    event.track.addEventListener('unmute', () => updateTileMedia(peer.tile, peer.media, peer.stream));
    event.track.addEventListener('ended', () => updateTileMedia(peer.tile, peer.media, peer.stream));
    updateTileMedia(peer.tile, peer.media, peer.stream);
  });

  connection.addEventListener('connectionstatechange', () => {
    updatePeerConnectionState(peer);
    if (connection.connectionState === 'failed' && typeof connection.restartIce === 'function') {
      connection.restartIce();
    }
  });

  connection.addEventListener('negotiationneeded', async () => {
    try {
      peer.makingOffer = true;
      await connection.setLocalDescription();
      sendSignal(peer.id, { description: connection.localDescription });
    } catch (error) {
      if (connection.signalingState !== 'closed') {
        console.error('Could not negotiate a peer connection:', error);
      }
    } finally {
      peer.makingOffer = false;
    }
  });

  for (const track of state.localStream.getTracks()) {
    connection.addTrack(track, state.localStream);
  }

  return peer;
}

async function addPendingCandidates(peer) {
  const candidates = peer.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      if (!peer.ignoreOffer) {
        throw error;
      }
    }
  }
}

async function handleSignal(message) {
  let peer = state.peers.get(message.from);
  if (!peer) {
    peer = createPeer({ id: message.from, name: 'Guest', media: { audio: true, video: true } });
  }

  const { connection } = peer;
  const payload = message.payload || {};

  try {
    if (payload.description) {
      const description = payload.description;
      const readyForOffer = !peer.makingOffer &&
        (connection.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }

      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await connection.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;
      await addPendingCandidates(peer);

      if (description.type === 'offer') {
        await connection.setLocalDescription();
        sendSignal(peer.id, { description: connection.localDescription });
      }
    } else if (payload.candidate) {
      if (peer.ignoreOffer) {
        return;
      }
      if (!connection.remoteDescription) {
        peer.pendingCandidates.push(payload.candidate);
      } else {
        await connection.addIceCandidate(payload.candidate);
      }
    }
  } catch (error) {
    if (!peer.ignoreOffer && connection.signalingState !== 'closed') {
      console.error('Could not apply signaling data:', error);
    }
  }
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) {
    return;
  }

  peer.connection.close();
  peer.tile.remove();
  state.peers.delete(id);
  updateParticipantCount();
}

function handleSocketMessage(event) {
  let message;

  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  if (message.type === 'welcome') {
    clearTimeout(state.joinTimeout);
    state.selfId = message.id;
    state.roomId = message.roomId;
    state.joined = true;
    state.joining = false;
    enterMeeting(message.peers || []);
    if (state.joinResolve) {
      state.joinResolve();
    }
  } else if (message.type === 'peer-joined') {
    createPeer(message.peer);
  } else if (message.type === 'peer-left') {
    removePeer(message.id);
  } else if (message.type === 'signal') {
    handleSignal(message);
  } else if (message.type === 'media-state') {
    const peer = state.peers.get(message.id);
    if (peer) {
      peer.media = message.media;
      updateTileMedia(peer.tile, peer.media, peer.stream);
    }
  } else if (message.type === 'error') {
    const error = new Error(message.message || 'Could not join the room.');
    if (!state.joined && state.joinReject) {
      clearTimeout(state.joinTimeout);
      state.joinReject(error);
    } else {
      showToast(error.message, true);
    }
  }
}

function websocketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/signal`;
}

function connectToRoom() {
  return new Promise((resolve, reject) => {
    state.joinResolve = resolve;
    state.joinReject = reject;
    state.intentionalClose = false;
    state.socket = new WebSocket(websocketUrl());

    state.joinTimeout = setTimeout(() => {
      reject(new Error('The room server did not respond. Try again.'));
      if (state.socket) {
        state.socket.close();
      }
    }, 10_000);

    state.socket.addEventListener('open', () => {
      send({
        type: 'join',
        roomId: state.roomId,
        name: state.displayName,
        media: getLocalMediaState()
      });
    });

    state.socket.addEventListener('message', handleSocketMessage);

    state.socket.addEventListener('error', () => {
      if (!state.joined) {
        clearTimeout(state.joinTimeout);
        reject(new Error('Could not connect to the room server.'));
      }
    });

    state.socket.addEventListener('close', () => {
      if (!state.joined) {
        clearTimeout(state.joinTimeout);
        reject(new Error('The room connection closed before you joined.'));
      } else if (!state.intentionalClose) {
        elements.connectionBanner.hidden = false;
      }
    });
  });
}

function startMeetingTimer() {
  clearInterval(state.timer);
  state.startedAt = Date.now();

  const update = () => {
    const elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    elements.elapsedTime.textContent = hours
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  update();
  state.timer = setInterval(update, 1000);
}

function inviteUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', state.roomId);
  return url.toString();
}

function enterMeeting(existingPeers) {
  const url = new URL(inviteUrl());
  history.replaceState({}, '', `${url.pathname}${url.search}`);

  elements.prejoinView.hidden = true;
  elements.meetingView.hidden = false;
  elements.connectionBanner.hidden = true;
  document.body.classList.add('in-meeting');

  elements.meetingRoomName.textContent = state.roomId;
  elements.roomCodeDisplay.textContent = state.roomId;
  elements.videoGrid.replaceChildren();
  createParticipantTile(state.selfId, state.displayName, getLocalMediaState(), state.localStream, true);

  for (const peerInfo of existingPeers) {
    createPeer(peerInfo);
  }

  syncLocalMediaUi();
  startMeetingTimer();
  elements.leaveButton.focus();
}

async function copyInvite() {
  const text = inviteUrl();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('input');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  showToast('Invitation link copied.');
}

async function toggleTrack(kind) {
  let track = getLiveTrack(kind);

  try {
    if (!track) {
      track = await acquireSingleTrack(kind);
      track.enabled = true;
    } else {
      track.enabled = !track.enabled;
    }

    syncLocalMediaUi();
    sendMediaState();
  } catch (error) {
    showToast(mediaErrorMessage(error), true);
  }
}

function resetMeeting() {
  clearInterval(state.timer);
  state.timer = null;
  state.intentionalClose = true;

  send({ type: 'leave' });
  if (state.socket && state.socket.readyState < WebSocket.CLOSING) {
    state.socket.close(1000, 'Left meeting');
  }

  for (const peer of state.peers.values()) {
    peer.connection.close();
  }
  state.peers.clear();

  for (const track of state.localStream.getTracks()) {
    track.stop();
  }
  state.localStream = new MediaStream();
  state.socket = null;
  state.selfId = null;
  state.joined = false;
  state.joining = false;

  elements.videoGrid.replaceChildren();
  elements.meetingView.hidden = true;
  elements.prejoinView.hidden = false;
  elements.connectionBanner.hidden = true;
  elements.joinButton.disabled = false;
  elements.joinButtonLabel.textContent = 'Enter the room';
  elements.permissionHint.textContent = 'You left the room. Your camera and microphone are off.';
  document.body.classList.remove('in-meeting');
  syncLocalMediaUi();
  elements.joinButton.focus();
}

async function chooseMode(mode) {
  if (state.joining || state.joined) {
    return;
  }

  state.mode = mode;
  for (const button of elements.modeButtons) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }

  elements.permissionHint.textContent = mode === 'video'
    ? 'Requesting camera and microphone access...'
    : 'Requesting microphone access...';

  try {
    await ensureMedia(mode);
    elements.permissionHint.textContent = 'Your media stays on this device until you enter.';
  } catch (error) {
    elements.permissionHint.textContent = mediaErrorMessage(error);
  }

  syncLocalMediaUi();
}

async function submitJoin(event) {
  event.preventDefault();
  if (state.joining) {
    return;
  }

  const name = elements.nameInput.value.trim().slice(0, 40);
  const roomId = normalizeRoomId(elements.roomInput.value);
  elements.nameInput.value = name;
  elements.roomInput.value = roomId;
  elements.joinError.textContent = '';

  if (!name) {
    elements.joinError.textContent = 'Enter your name before joining.';
    elements.nameInput.focus();
    return;
  }
  if (roomId.length < 3) {
    elements.joinError.textContent = 'Enter a room code with at least 3 characters.';
    elements.roomInput.focus();
    return;
  }

  state.displayName = name;
  state.roomId = roomId;
  state.joining = true;
  elements.joinButton.disabled = true;
  elements.joinButtonLabel.textContent = 'Preparing your media...';
  syncPreview();

  try {
    await ensureMedia(state.mode);
    const media = getLocalMediaState();
    if (!media.audio || (state.mode === 'video' && !media.video)) {
      throw new Error('The selected microphone or camera is not available.');
    }

    try {
      localStorage.setItem('roomly-name', name);
    } catch {
      // Storage may be disabled; it is not required to join.
    }
    elements.joinButtonLabel.textContent = 'Entering the room...';
    await connectToRoom();
  } catch (error) {
    state.intentionalClose = true;
    if (!state.joined && state.socket && state.socket.readyState < WebSocket.CLOSING) {
      state.socket.close();
    }
    state.joining = false;
    elements.joinButton.disabled = false;
    elements.joinButtonLabel.textContent = 'Enter the room';
    const isMediaError = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(error.name);
    elements.joinError.textContent = isMediaError ? mediaErrorMessage(error) : error.message;
  }
}

async function loadRtcConfiguration() {
  try {
    const response = await fetch('/config', { cache: 'no-store' });
    if (response.ok) {
      const configuration = await response.json();
      if (Array.isArray(configuration.iceServers)) {
        state.rtcConfiguration = configuration;
      }
    }
  } catch {
    state.rtcConfiguration = defaultRtcConfiguration;
  }
}

function initialize() {
  const roomFromUrl = normalizeRoomId(new URLSearchParams(location.search).get('room') || '');
  elements.roomInput.value = roomFromUrl || generateRoomId();
  try {
    elements.nameInput.value = localStorage.getItem('roomly-name') || '';
  } catch {
    elements.nameInput.value = '';
  }
  syncPreview();
  loadRtcConfiguration();

  elements.joinForm.addEventListener('submit', submitJoin);
  elements.newRoomButton.addEventListener('click', () => {
    elements.roomInput.value = generateRoomId();
    elements.roomInput.focus();
  });
  elements.roomInput.addEventListener('input', () => {
    elements.roomInput.value = normalizeRoomId(elements.roomInput.value);
  });
  elements.nameInput.addEventListener('input', syncPreview);

  for (const button of elements.modeButtons) {
    button.addEventListener('click', () => chooseMode(button.dataset.mode));
  }

  elements.micButton.addEventListener('click', () => toggleTrack('audio'));
  elements.cameraButton.addEventListener('click', () => toggleTrack('video'));
  elements.inviteButton.addEventListener('click', copyInvite);
  elements.leaveButton.addEventListener('click', resetMeeting);

  document.addEventListener('keydown', (event) => {
    if (!state.joined || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return;
    }

    if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      toggleTrack('audio');
    } else if (event.key.toLowerCase() === 'v') {
      event.preventDefault();
      toggleTrack('video');
    }
  });

  document.addEventListener('pointerdown', () => {
    if (state.joined) {
      for (const video of elements.videoGrid.querySelectorAll('video')) {
        video.play().catch(() => undefined);
      }
    }
  }, { passive: true });

  window.addEventListener('beforeunload', () => {
    state.intentionalClose = true;
    send({ type: 'leave' });
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  });

  elements.permissionHint.textContent = 'Camera and microphone access is requested when you enter.';
}

initialize();
