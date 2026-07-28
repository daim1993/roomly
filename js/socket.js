'use strict';

/**
 * WebSocket client with request/response support and automatic reconnection.
 * Every reconnect produces a fresh `ready` snapshot from the server, which the
 * app treats as the new source of truth.
 */

export class RoomlySocket {
  constructor() {
    this.socket = null;
    this.listeners = new Map(); // event type -> Set<fn>
    this.pending = new Map(); // req id -> {resolve, reject, timer}
    this.nextReq = 1;
    this.closedByUser = false;
    this.retryDelay = 800;
    this.retryTimer = null;
    this.everConnected = false;
  }

  on(type, handler) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  emit(type, payload) {
    for (const handler of this.listeners.get(type) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`Listener for "${type}" failed:`, error);
      }
    }
  }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.retryTimer);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryDelay = 800;
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message.t !== 'string') {
        return;
      }

      if (message.t === 'ack') {
        const pending = this.pending.get(message.req);
        if (pending) {
          this.pending.delete(message.req);
          clearTimeout(pending.timer);
          if (message.ok) {
            pending.resolve(message);
          } else {
            pending.reject(new Error(message.error || 'The request failed.'));
          }
        }
        return;
      }

      if (message.t === 'ready') {
        this.everConnected = true;
      }
      this.emit(message.t, message);
    });

    const onGone = () => {
      if (socket !== this.socket) {
        return;
      }
      this.failAllPending();
      this.emit('socket-closed', {});
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };

    socket.addEventListener('close', onGone);
    socket.addEventListener('error', () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.closedByUser) {
        this.connect();
      }
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.7, 12_000);
  }

  failAllPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The connection dropped. Trying to reconnect…'));
    }
    this.pending.clear();
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    if (this.socket) {
      this.socket.close(1000, 'Bye');
    }
  }

  /** Fire and forget. */
  push(op, data = {}) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ op, ...data }));
    }
  }

  /** Request/response with a timeout. */
  request(op, data = {}, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected right now. Hold on…'));
        return;
      }
      const req = this.nextReq;
      this.nextReq += 1;
      const timer = setTimeout(() => {
        this.pending.delete(req);
        reject(new Error('The server took too long to answer.'));
      }, timeoutMs);
      this.pending.set(req, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ op, req, ...data }));
    });
  }
}
