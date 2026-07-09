/* ============================================================
 * socket.js — thin, dependency-free wrapper around the Socket.io
 * client. Knows *nothing* about carrom; it only deals with
 * connecting, acknowledgements and reconnection.
 * ============================================================ */
'use strict';

class SocketClient extends EventBus {
  constructor() {
    super();
    this.socket = null;
    this.url = '';
    this.connected = false;
    this.latency = 0;
    this._pingTimer = null;
  }

  static available() { return typeof window !== 'undefined' && typeof window.io === 'function'; }

  /**
   * Where does the match server live?
   *  1. explicit Settings override
   *  2. CONFIG.NET.PUBLIC_SERVER (baked in at build time)
   *  3. same origin — correct when Express serves this page
   */
  static resolveUrl() {
    const s = Settings.load();
    if (s.serverUrl) return s.serverUrl;
    if (CONFIG.NET.PUBLIC_SERVER) return CONFIG.NET.PUBLIC_SERVER;
    if (location.protocol === 'file:') return '';
    // A static host (GitHub Pages) cannot possibly be the game server.
    if (/github\.io$/i.test(location.hostname) || /pages\.dev$/i.test(location.hostname)) return '';
    return location.origin;
  }

  /** @returns {Promise<void>} resolves on connect, rejects on timeout */
  connect(timeoutMs = 9000) {
    if (this.connected) return Promise.resolve();
    if (!SocketClient.available()) {
      return Promise.reject(new Error('Socket.io client failed to load.'));
    }

    this.url = SocketClient.resolveUrl();
    if (!this.url) {
      return Promise.reject(new Error('No server URL. Set one in Settings → Multiplayer Server URL.'));
    }

    return new Promise((resolve, reject) => {
      let done = false;

      this.socket = window.io(this.url, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
        timeout: timeoutMs
      });

      const fail = (err) => {
        if (done) return;
        done = true;
        reject(err instanceof Error ? err : new Error(String(err && err.message || err)));
      };

      this.socket.on('connect', () => {
        this.connected = true;
        this._startPing();
        this.emit('connected');
        if (!done) { done = true; resolve(); }
      });

      this.socket.on('connect_error', fail);
      this.socket.io.on('error', fail);

      this.socket.on('disconnect', (reason) => {
        this.connected = false;
        this._stopPing();
        this.emit('disconnected', reason);
      });

      this.socket.io.on('reconnect_attempt', (n) => this.emit('reconnecting', n));
      this.socket.io.on('reconnect', () => this.emit('reconnected'));
      this.socket.io.on('reconnect_failed', () => this.emit('reconnect-failed'));

      // Re-broadcast every server event on our own bus.
      this.socket.onAny((evt, ...args) => this.emit(evt, ...args));

      setTimeout(() => fail(new Error('Connection timed out.')), timeoutMs + 500);
    });
  }

  /** Fire and forget. */
  send(evt, payload) {
    if (this.socket && this.connected) this.socket.emit(evt, payload);
  }

  /** Emit with an acknowledgement callback. */
  request(evt, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) return reject(new Error('Not connected'));
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Request timed out')); } }, timeoutMs);
      this.socket.emit(evt, payload, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (res && res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  }

  disconnect() {
    this._stopPing();
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.connected = false;
  }

  /* ---- round-trip time, purely informational ---- */

  _startPing() {
    this._stopPing();
    const beat = () => {
      if (!this.connected) return;
      const t0 = performance.now();
      this.socket.timeout(4000).emit('ping-rtt', null, (err) => {
        if (!err) {
          this.latency = Math.round(performance.now() - t0);
          this.emit('latency', this.latency);
        }
      });
    };
    beat();
    this._pingTimer = setInterval(beat, 4000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }
}

globalThis.SocketClient = SocketClient;
