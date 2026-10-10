import { PROTOCOL_VERSION, type ClientMsg, type RoomInfo, type ServerMsg } from '../shared/protocol';
import type { Team } from '../shared/map';

/**
 * Thin WebSocket wrapper: connect, create/join a room, send messages,
 * estimate round-trip time, and transparently reconnect with the room's
 * rejoin token if the connection drops.
 */

export type NetStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export function serverWsUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export function serverHttpUrl(path: string): string {
  const ws = serverWsUrl();
  return ws.replace(/^ws/, 'http').replace(/\/ws$/, path);
}

const tokenKey = (room: string) => `classic-strike.token.${room}`;

export class NetClient {
  status: NetStatus = 'idle';
  room = '';
  you = 0;
  rtt = 0.1;
  /** Latest room roster, kept so a screen attaching late can render it. */
  lastRoom: RoomInfo | null = null;
  private ws: WebSocket | null = null;
  private name = '';
  private wantClose = false;
  private retries = 0;
  private pingTimer = 0;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: NetStatus, detail?: string) => void = () => {};

  private setStatus(s: NetStatus, detail?: string): void {
    this.status = s;
    this.onStatus(s, detail);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(serverWsUrl());
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the game server.'));
      ws.onmessage = (e) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.t === 'room') this.lastRoom = m.info;
        if (m.t === 'pong') this.rtt = this.rtt * 0.7 + Math.max(0, (performance.now() - m.c) / 1000) * 0.3;
        this.onMessage(m);
      };
      ws.onclose = () => this.handleClose();
    });
  }

  private waitWelcome(): Promise<Extract<ServerMsg, { t: 'welcome' }>> {
    return new Promise((resolve, reject) => {
      const prev = this.onMessage;
      const timer = window.setTimeout(() => {
        this.onMessage = prev;
        reject(new Error('The server did not answer.'));
      }, 6000);
      this.onMessage = (m) => {
        if (m.t === 'welcome') {
          window.clearTimeout(timer);
          this.onMessage = prev;
          this.room = m.room;
          this.you = m.you;
          try {
            sessionStorage.setItem(tokenKey(m.room), m.token);
          } catch {
            /* reconnect just won't restore the slot */
          }
          resolve(m);
        } else if (m.t === 'error') {
          window.clearTimeout(timer);
          this.onMessage = prev;
          reject(new Error(m.text));
        }
        prev(m);
      };
    });
  }

  async create(name: string, team: Team | 'auto'): Promise<void> {
    this.name = name;
    this.setStatus('connecting');
    await this.open();
    const w = this.waitWelcome();
    this.send({ t: 'create', v: PROTOCOL_VERSION, name, team });
    await w;
    this.afterJoin();
  }

  async join(room: string, name: string): Promise<void> {
    this.name = name;
    this.setStatus('connecting');
    await this.open();
    const w = this.waitWelcome();
    let token: string | undefined;
    try {
      token = sessionStorage.getItem(tokenKey(room)) ?? undefined;
    } catch {
      token = undefined;
    }
    this.send({ t: 'join', v: PROTOCOL_VERSION, name, room, token });
    await w;
    this.afterJoin();
  }

  private afterJoin(): void {
    this.retries = 0;
    this.setStatus('open');
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 1000);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.wantClose = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.setStatus('closed');
  }

  private handleClose(): void {
    window.clearInterval(this.pingTimer);
    if (this.wantClose || !this.room) {
      if (!this.wantClose) this.setStatus('closed', 'Connection closed.');
      return;
    }
    // Unexpected drop: try to get back into the same room for ~20 s.
    if (this.retries >= 8) {
      this.setStatus('closed', 'Lost connection to the game server.');
      return;
    }
    this.retries++;
    this.setStatus('reconnecting', `Connection lost — reconnecting (${this.retries}/8)…`);
    window.setTimeout(() => {
      this.join(this.room, this.name).catch((e: Error) => {
        if (/does not exist|two players/.test(e.message)) {
          this.wantClose = true;
          this.setStatus('closed', e.message);
        } else {
          this.handleClose();
        }
      });
    }, 1000 + this.retries * 1500);
  }
}
