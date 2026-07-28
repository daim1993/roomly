'use strict';

/**
 * Voice channel engine: WebRTC mesh with perfect negotiation, camera + screen
 * share as separate streams, and lightweight speaking detection.
 *
 * The signaling server only relays `signal` payloads between connections in
 * the same voice channel; everything here is browser-to-browser.
 */

export class VoiceManager {
  constructor({ socket, onUpdate, onSpeaking, onEnded }) {
    this.socket = socket;
    this.onUpdate = onUpdate; // any peer/media change -> re-render voice UI
    this.onSpeaking = onSpeaking; // (connId|'self', speaking)
    this.onEnded = onEnded; // we left / were kicked

    this.active = false;
    this.channelKey = null;
    this.selfConnId = null;
    this.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];

    this.localStream = new MediaStream();
    this.screenStream = null;
    this.micEnabled = false;
    this.camEnabled = false;

    this.peers = new Map(); // connId -> peer

    this.audioContext = null;
    this.analysers = new Map(); // key ('self' | connId) -> {analyser, data, speaking}
    this.speakTimer = null;
  }

  media() {
    return { audio: this.micEnabled, video: this.camEnabled, screen: Boolean(this.screenStream) };
  }

  // ------------------------------------------------------------ local media

  async ensureMic() {
    if (this.localStream.getAudioTracks().some((track) => track.readyState === 'live')) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      this.localStream.removeTrack(track);
      this.micEnabled = false;
      this.pushMediaState();
      this.onUpdate();
    }, { once: true });
    this.localStream.addTrack(track);
    await this.attachTrackEverywhere(track);
    this.watchSelfAudio();
  }

  async ensureCam() {
    if (this.localStream.getVideoTracks().some((track) => track.readyState === 'live')) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    });
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      this.localStream.removeTrack(track);
      this.camEnabled = false;
      this.pushMediaState();
      this.onUpdate();
    }, { once: true });
    this.localStream.addTrack(track);
    await this.attachTrackEverywhere(track);
  }

  /** Replace an existing sender of the same kind, or add a new track. */
  async attachTrackEverywhere(track) {
    const jobs = [];
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find(
        (candidate) => candidate.track && candidate.track.kind === track.kind &&
          !peer.screenSenders.has(candidate)
      );
      const idleSender = !sender && peer.pc.getSenders().find(
        (candidate) => !candidate.track && candidate._kind === track.kind && !peer.screenSenders.has(candidate)
      );
      if (sender) {
        jobs.push(sender.replaceTrack(track));
      } else if (idleSender) {
        jobs.push(idleSender.replaceTrack(track));
      } else {
        const added = peer.pc.addTrack(track, this.localStream);
        added._kind = track.kind;
      }
    }
    await Promise.allSettled(jobs);
    this.sendMetaToAll();
  }

  async toggleMic() {
    if (!this.active) {
      return;
    }
    const track = this.localStream.getAudioTracks().find((candidate) => candidate.readyState === 'live');
    if (!track) {
      await this.ensureMic();
      this.micEnabled = true;
    } else {
      this.micEnabled = !this.micEnabled;
      track.enabled = this.micEnabled;
    }
    this.pushMediaState();
    this.onUpdate();
  }

  async toggleCam() {
    if (!this.active) {
      return;
    }
    const track = this.localStream.getVideoTracks().find((candidate) => candidate.readyState === 'live');
    if (this.camEnabled && track) {
      // Turn the camera fully off so the hardware light goes out.
      track.stop();
      this.localStream.removeTrack(track);
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((candidate) => candidate.track === track);
        if (sender) {
          sender._kind = 'video';
          sender.replaceTrack(null).catch(() => {});
        }
      }
      this.camEnabled = false;
    } else {
      await this.ensureCam();
      this.camEnabled = true;
    }
    this.pushMediaState();
    this.onUpdate();
  }

  async startScreen() {
    if (!this.active || this.screenStream) {
      return;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false
    });
    this.screenStream = stream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => this.stopScreen(), { once: true });

    for (const peer of this.peers.values()) {
      const sender = peer.pc.addTrack(track, stream);
      peer.screenSenders.add(sender);
    }
    this.pushMediaState();
    this.sendMetaToAll();
    this.onUpdate();
  }

  stopScreen() {
    if (!this.screenStream) {
      return;
    }
    for (const track of this.screenStream.getTracks()) {
      track.stop();
    }
    for (const peer of this.peers.values()) {
      for (const sender of peer.screenSenders) {
        try {
          peer.pc.removeTrack(sender);
        } catch {}
      }
      peer.screenSenders.clear();
    }
    this.screenStream = null;
    this.pushMediaState();
    this.sendMetaToAll();
    this.onUpdate();
  }

  pushMediaState() {
    if (this.active) {
      this.socket.push('voice-media', { media: this.media() });
    }
  }

  // ------------------------------------------------------------- lifecycle

  async join(channelKey, { video = false } = {}) {
    if (this.active && this.channelKey === channelKey) {
      return null;
    }
    if (this.active) {
      await this.leave();
    }

    await this.ensureMic();
    this.micEnabled = true;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = true;
    }
    if (video) {
      try {
        await this.ensureCam();
        this.camEnabled = true;
      } catch {
        this.camEnabled = false; // no camera is fine; join with voice only
      }
    }

    const ack = await this.socket.request('voice-join', {
      channelKey,
      media: { audio: this.micEnabled, video: this.camEnabled }
    });

    this.active = true;
    this.channelKey = channelKey;
    this.joinedAt = Date.now();
    this.syncPeers(ack.participants || []);
    this.startSpeakingLoop();
    this.onUpdate();
    return ack;
  }

  async leave({ notifyServer = true } = {}) {
    if (!this.active && !this.localStream.getTracks().length) {
      return;
    }
    if (notifyServer) {
      this.socket.push('voice-leave');
    }
    this.active = false;
    this.channelKey = null;
    this.joinedAt = null;

    for (const peer of this.peers.values()) {
      this.destroyPeer(peer, false);
    }
    this.peers.clear();

    for (const track of this.localStream.getTracks()) {
      track.stop();
    }
    this.localStream = new MediaStream();
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        track.stop();
      }
      this.screenStream = null;
    }
    this.micEnabled = false;
    this.camEnabled = false;
    this.stopSpeakingLoop();
    this.onUpdate();
    if (this.onEnded) {
      this.onEnded();
    }
  }

  /** Server truth arrived (voice-state / join ack): align the mesh with it. */
  syncPeers(participants) {
    if (!this.active) {
      return;
    }
    const wanted = new Map();
    for (const participant of participants) {
      if (participant.connId !== this.selfConnId) {
        wanted.set(participant.connId, participant);
      }
    }

    for (const [connId, peer] of this.peers) {
      if (!wanted.has(connId)) {
        this.destroyPeer(peer, true);
      }
    }
    for (const participant of wanted.values()) {
      if (!this.peers.has(participant.connId)) {
        this.createPeer(participant);
      }
    }
    this.onUpdate();
  }

  /** After a websocket reconnect our connId changed; rebuild every link. */
  async resync(selfConnId) {
    this.selfConnId = selfConnId;
    if (!this.active || !this.channelKey) {
      return;
    }
    for (const peer of this.peers.values()) {
      this.destroyPeer(peer, true);
    }
    try {
      const ack = await this.socket.request('voice-join', {
        channelKey: this.channelKey,
        media: { audio: this.micEnabled, video: this.camEnabled, screen: Boolean(this.screenStream) }
      });
      this.pushMediaState();
      this.syncPeers(ack.participants || []);
    } catch {
      await this.leave({ notifyServer: false });
    }
  }

  createPeer(participant) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // Exactly one side starts the first offer: the newer connection (ids are
    // time-sortable). Symmetric auto-offers guarantee glare, and Chromium's
    // offer rollback can leave ICE without candidates — so we avoid it.
    const initiator = String(this.selfConnId) > String(participant.connId);
    const peer = {
      connId: participant.connId,
      userId: participant.userId,
      pc,
      initiator,
      handshakeDone: false,
      polite: String(this.selfConnId) > String(participant.connId),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      pendingCandidates: [],
      cameraStream: null,
      screenStream: null,
      screenSenders: new Set(),
      meta: null,
      connected: false
    };
    this.peers.set(peer.connId, peer);

    for (const track of this.localStream.getTracks()) {
      const sender = pc.addTrack(track, this.localStream);
      sender._kind = track.kind;
    }
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        const sender = pc.addTrack(track, this.screenStream);
        peer.screenSenders.add(sender);
      }
    }

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        this.socket.push('signal', { target: peer.connId, payload: { candidate } });
      }
    });

    pc.addEventListener('negotiationneeded', async () => {
      if (!peer.initiator && !peer.handshakeDone) {
        return; // the initiator's first offer is on its way; answer instead
      }
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.socket.push('signal', { target: peer.connId, payload: { description: pc.localDescription } });
      } catch (error) {
        if (pc.signalingState !== 'closed') {
          console.error('Negotiation failed:', error);
        }
      } finally {
        peer.makingOffer = false;
      }
    });

    pc.addEventListener('track', (event) => {
      const stream = event.streams[0];
      if (stream) {
        this.classifyStream(peer, stream);
        stream.addEventListener('removetrack', () => this.onUpdate());
      }
      event.track.addEventListener('unmute', () => this.onUpdate());
      event.track.addEventListener('ended', () => this.onUpdate());
      this.onUpdate();
    });

    pc.addEventListener('connectionstatechange', () => {
      peer.connected = pc.connectionState === 'connected';
      if (pc.connectionState === 'failed' && typeof pc.restartIce === 'function') {
        pc.restartIce();
      }
      this.onUpdate();
    });

    this.sendMeta(peer);
    return peer;
  }

  classifyStream(peer, stream) {
    if (peer.meta && stream.id === peer.meta.screen) {
      peer.screenStream = stream;
      return;
    }
    if (peer.meta && stream.id === peer.meta.camera) {
      peer.cameraStream = stream;
      this.watchPeerAudio(peer);
      return;
    }
    // Meta not seen yet: audio-bearing stream is the camera/mic bundle.
    if (stream.getAudioTracks().length || !peer.cameraStream) {
      peer.cameraStream = stream;
      this.watchPeerAudio(peer);
    } else {
      peer.screenStream = stream;
    }
  }

  reclassifyStreams(peer) {
    if (!peer.meta) {
      return;
    }
    const known = [peer.cameraStream, peer.screenStream].filter(Boolean);
    peer.cameraStream = null;
    peer.screenStream = null;
    for (const stream of known) {
      this.classifyStream(peer, stream);
    }
    if (!peer.meta.screen) {
      peer.screenStream = null;
    }
  }

  destroyPeer(peer, removeFromMap) {
    try {
      peer.pc.close();
    } catch {}
    this.analysers.delete(peer.connId);
    if (removeFromMap) {
      this.peers.delete(peer.connId);
    }
  }

  sendMeta(peer) {
    this.socket.push('signal', {
      target: peer.connId,
      payload: {
        meta: {
          camera: this.localStream.id,
          screen: this.screenStream ? this.screenStream.id : null
        }
      }
    });
  }

  sendMetaToAll() {
    for (const peer of this.peers.values()) {
      this.sendMeta(peer);
    }
  }

  async handleSignal({ from, fromUserId, payload }) {
    if (!this.active) {
      return;
    }
    let peer = this.peers.get(from);
    if (!peer) {
      peer = this.createPeer({ connId: from, userId: fromUserId });
    }

    if (payload.meta) {
      peer.meta = payload.meta;
      this.reclassifyStreams(peer);
      this.onUpdate();
      if (!payload.description && !payload.candidate) {
        return;
      }
    }

    const { pc } = peer;
    try {
      if (payload.description) {
        const description = payload.description;
        const readyForOffer = !peer.makingOffer &&
          (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) {
          return;
        }

        peer.settingRemoteAnswer = description.type === 'answer';
        await pc.setRemoteDescription(description);
        peer.settingRemoteAnswer = false;
        peer.handshakeDone = true;

        const queued = peer.pendingCandidates.splice(0);
        for (const candidate of queued) {
          try {
            await pc.addIceCandidate(candidate);
          } catch {}
        }

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.socket.push('signal', { target: peer.connId, payload: { description: pc.localDescription } });
        }
      } else if (payload.candidate) {
        if (peer.ignoreOffer) {
          return;
        }
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(payload.candidate);
        } else {
          await pc.addIceCandidate(payload.candidate);
        }
      }
    } catch (error) {
      if (!peer.ignoreOffer && pc.signalingState !== 'closed') {
        console.error('Could not apply signaling data:', error);
      }
    }
  }

  // ---------------------------------------------------------- speaking loop

  ensureAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  watchSelfAudio() {
    this.watchStream('self', this.localStream);
  }

  watchPeerAudio(peer) {
    if (peer.cameraStream && peer.cameraStream.getAudioTracks().length) {
      this.watchStream(peer.connId, peer.cameraStream);
    }
  }

  watchStream(key, stream) {
    try {
      if (!stream.getAudioTracks().length) {
        return;
      }
      const context = this.ensureAudioContext();
      const existing = this.analysers.get(key);
      if (existing && existing.streamId === stream.id) {
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.analysers.set(key, {
        analyser,
        streamId: stream.id,
        data: new Uint8Array(analyser.frequencyBinCount),
        speaking: false
      });
    } catch {
      // Speaking rings are a nicety.
    }
  }

  startSpeakingLoop() {
    this.stopSpeakingLoop();
    this.speakTimer = setInterval(() => {
      for (const [key, entry] of this.analysers) {
        if (key === 'self' && !this.micEnabled) {
          if (entry.speaking) {
            entry.speaking = false;
            this.onSpeaking('self', false);
          }
          continue;
        }
        entry.analyser.getByteTimeDomainData(entry.data);
        let sum = 0;
        for (let index = 0; index < entry.data.length; index += 1) {
          const deviation = entry.data[index] - 128;
          sum += deviation * deviation;
        }
        const rms = Math.sqrt(sum / entry.data.length);
        const speaking = rms > 5.5;
        if (speaking !== entry.speaking) {
          entry.speaking = speaking;
          this.onSpeaking(key, speaking);
        }
      }
    }, 160);
  }

  stopSpeakingLoop() {
    clearInterval(this.speakTimer);
    this.speakTimer = null;
    for (const entry of this.analysers.values()) {
      entry.speaking = false;
    }
    this.analysers.clear();
  }
}
