import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from '../src/shared/protocol';
import { TICK_DT } from '../src/shared/sim';
import { EMPTY_ROOM_TTL_S, Room, makeRoomCode, type Conn } from './room';

/**
 * CLASSIC STRIKE game server: serves the built client (optional) and hosts
 * private rooms over WebSocket at /ws. All rooms live in memory in this one
 * process, so it must run as a single instance.
 */

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir?: string | null;
  debug?: boolean;
  allowedOrigins?: string[];
  maxRooms?: number;
  log?: (msg: string) => void;
}

export interface RunningServer {
  http: Server;
  rooms: Map<string, Room>;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(`[server] ${m}`));
  const rooms = new Map<string, Room>();
  const maxRooms = opts.maxRooms ?? 500;
  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;

  const http = createServer((req, res) => serveHttp(req, res, staticRoot, rooms));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (opts.allowedOrigins?.length && (!origin || !opts.allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket): void {
    let conn: Conn | null = null;
    let room: Room | null = null;
    let alive = true;
    let budget = 240; // messages per second, refilled below
    const refill = setInterval(() => (budget = 240), 1000);
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 10000);
    ws.on('pong', () => (alive = true));
    const send = (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    ws.on('message', (data, isBinary) => {
      alive = true;
      if (isBinary || --budget < 0) {
        if (budget < -240) ws.close(1008, 'rate limit');
        return;
      }
      const msg = parseClientMsg(data.toString());
      if (!msg) return send({ t: 'error', code: 'bad_message', text: 'Malformed message.' });

      if (!conn) {
        if (msg.t !== 'create' && msg.t !== 'join') return;
        if (msg.v !== PROTOCOL_VERSION) {
          return send({ t: 'error', code: 'bad_version', text: 'Client and server versions differ. Reload the page.' });
        }
        if (msg.t === 'create') {
          if (rooms.size >= maxRooms) return send({ t: 'error', code: 'server_full', text: 'The server is full. Try again later.' });
          const code = makeRoomCode((c) => rooms.has(c));
          room = new Room(code, !!opts.debug);
          rooms.set(code, room);
          log(`room ${code} created (${rooms.size} rooms)`);
          const r = room.join(ws, msg.name, msg.team);
          if ('error' in r) return;
          conn = r;
        } else {
          const target = rooms.get(msg.room);
          if (!target) return send({ t: 'error', code: 'bad_room', text: `Room ${msg.room} does not exist (or has expired).` });
          const r = target.join(ws, msg.name, 'auto', msg.token);
          if ('error' in r) return send({ t: 'error', code: 'room_full', text: 'That room already has two players.' });
          room = target;
          conn = r;
          log(`room ${target.code}: player ${r.playerId} joined (${target.humanCount} connected)`);
        }
        return;
      }
      if (msg.t === 'create' || msg.t === 'join') return;
      room!.handle(conn, msg);
    });

    ws.on('close', () => {
      clearInterval(refill);
      clearInterval(heartbeat);
      if (room && conn) {
        room.leave(conn);
        log(`room ${room.code}: player ${conn.playerId} socket closed (${room.humanCount} connected)`);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  // Fixed-step simulation for every room.
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let steps = 0;
    while (acc >= TICK_DT && steps < 5) {
      for (const r of rooms.values()) r.tick();
      acc -= TICK_DT;
      steps++;
    }
    if (steps === 5) acc = 0;
  }, 4);

  // RTT measurement doubles as a liveness signal for lag compensation.
  const rttTimer = setInterval(() => {
    for (const r of rooms.values()) {
      for (const c of r.conns.values()) {
        const sent = performance.now();
        c.ws.once('pong', () => r.noteRtt(c, (performance.now() - sent) / 1000));
        if (c.ws.readyState === c.ws.OPEN) c.ws.ping();
      }
    }
  }, 2000);

  const reaper = setInterval(() => {
    for (const [code, r] of rooms) {
      if (r.emptySince !== null && Date.now() - r.emptySince > EMPTY_ROOM_TTL_S * 1000) {
        rooms.delete(code);
        log(`room ${code} closed (empty)`);
      }
    }
  }, 5000);

  return new Promise((resolveStart) => {
    http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`listening on :${port}${staticRoot ? ` (serving ${staticRoot})` : ''}${opts.debug ? ' [DEBUG HOOKS ON]' : ''}`);
      resolveStart({
        http,
        rooms,
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(loop);
            clearInterval(rttTimer);
            clearInterval(reaper);
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}

function serveHttp(req: IncomingMessage, res: ServerResponse, root: string | null, rooms: Map<string, Room>): void {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    let players = 0;
    for (const r of rooms.values()) players += r.humanCount;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (!root) {
    res.writeHead(404).end('Not found');
    return;
  }
  // Resolve inside the static root only (no path traversal).
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback (?room=CODE links)
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = extname(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
