// Human Check 통화 서버: 정적 파일 + 방 API + SSE 시그널링 중계.
// Node 표준 라이브러리만 사용한다. 계약: CONTRACT-CALL.md "서버" 절.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '0.0.0.0';
const PING_MS = 15000;
const MAX_BODY = 256 * 1024;
const MAX_NAME = 40;
const ROOM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** IPv4, 내부 주소 제외. */
export function detectLanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

function sendJson(res, status, body) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  headers['content-length'] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { finish({ ok: false }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish({ ok: true, value });
      } catch {
        finish({ ok: false });
      }
    });
    req.on('error', () => finish({ ok: false }));
  });
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const n = v.trim().slice(0, MAX_NAME);
  return n ? n : null;
}

/**
 * @param {{root?: string, maxPeers?: number, lanIps?: string[], port?: number, scheme?: 'https'|'http'}} opts
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function createCallHandler({ root = REPO_ROOT, maxPeers = 3, lanIps, port = 8443, scheme = 'https' } = {}) {
  const rootDir = path.resolve(root);
  const getLanIps = () => (Array.isArray(lanIps) ? lanIps : detectLanIps());

  /** room code → { code, hostId, peers: Map<peerId, Peer> } */
  const rooms = new Map();

  function newRoomCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function newPeer(name, role) {
    return { peerId: crypto.randomBytes(8).toString('hex'), name, role, queue: [], res: null, ping: null };
  }

  function send(peer, event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    if (peer.res && !peer.res.writableEnded) peer.res.write(line);
    else peer.queue.push(line);
  }

  function detachStream(peer) {
    if (peer.ping) clearInterval(peer.ping);
    peer.ping = null;
    const r = peer.res;
    peer.res = null;
    return r;
  }

  /** 퇴장 처리. 이미 나간 peer면 아무것도 하지 않는다(정확히 한 번). */
  function removePeer(room, peerId) {
    if (rooms.get(room.code) !== room) return;
    const peer = room.peers.get(peerId);
    if (!peer) return;
    room.peers.delete(peerId);
    const own = detachStream(peer);
    if (own && !own.writableEnded) own.end();

    if (peerId === room.hostId) {
      rooms.delete(room.code);
      for (const other of room.peers.values()) {
        send(other, { type: 'room-closed' });
        const r = detachStream(other);
        if (r && !r.writableEnded) r.end();
      }
      room.peers.clear();
      return;
    }
    for (const other of room.peers.values()) send(other, { type: 'peer-left', peerId });
  }

  function openEvents(req, res, room, peer) {
    // 같은 peer가 다시 연결하면 이전 스트림만 닫는다(퇴장으로 보지 않음).
    const prev = detachStream(peer);
    if (prev && !prev.writableEnded) prev.end();

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    req.socket.setKeepAlive(true);
    req.socket.setNoDelay(true);
    peer.res = res;
    const pending = peer.queue.splice(0);
    for (const line of pending) res.write(line);
    peer.ping = setInterval(() => {
      if (peer.res === res && !res.writableEnded) res.write(': ping\n\n');
    }, PING_MS);

    const onGone = () => {
      if (peer.res !== res) return; // 이미 교체됐거나 퇴장 처리됨
      detachStream(peer);
      removePeer(room, peer.peerId);
    };
    res.on('close', onGone);
    res.on('error', onGone);
  }

  async function handleApi(req, res, parts, query) {
    const method = req.method;

    if (parts.length === 1 && parts[0] === 'info') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      const urls = getLanIps().map((ip) => `${scheme}://${ip}:${port}/call.html`);
      return sendJson(res, 200, { urls });
    }

    if (parts[0] !== 'rooms') return sendJson(res, 404, { error: 'not_found' });

    // POST /api/rooms
    if (parts.length === 1) {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      const body = await readJson(req);
      if (!body.ok || !isObject(body.value)) return sendJson(res, 400, { error: 'bad_request' });
      const name = cleanName(body.value.name);
      if (!name) return sendJson(res, 400, { error: 'bad_request' });
      const host = newPeer(name, 'host');
      const room = { code: newRoomCode(), hostId: host.peerId, peers: new Map([[host.peerId, host]]) };
      rooms.set(room.code, room);
      return sendJson(res, 201, { room: room.code, peerId: host.peerId, role: 'host', hostId: host.peerId, peers: [] });
    }

    if (parts.length !== 3) return sendJson(res, 404, { error: 'not_found' });
    const code = parts[1].toLowerCase();
    const action = parts[2];

    if (action === 'events') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { error: 'room_not_found' });
      const peer = room.peers.get(query.get('peer') || '');
      if (!peer) return sendJson(res, 404, { error: 'peer_not_found' });
      return openEvents(req, res, room, peer);
    }

    if (method !== 'POST' || !['join', 'signal', 'leave'].includes(action)) {
      return sendJson(res, 404, { error: 'not_found' });
    }

    const body = await readJson(req);
    if (!body.ok || !isObject(body.value)) return sendJson(res, 400, { error: 'bad_request' });
    const data = body.value;

    if (action === 'join') {
      const name = cleanName(data.name);
      if (!name) return sendJson(res, 400, { error: 'bad_request' });
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { error: 'room_not_found' });
      if (room.peers.size >= maxPeers) return sendJson(res, 409, { error: 'room_full' });
      const guest = newPeer(name, 'guest');
      const existing = [...room.peers.values()].map((p) => ({ peerId: p.peerId, name: p.name, role: p.role }));
      for (const p of room.peers.values()) send(p, { type: 'peer-joined', peerId: guest.peerId, name: guest.name, role: guest.role });
      room.peers.set(guest.peerId, guest);
      return sendJson(res, 200, { room: room.code, peerId: guest.peerId, role: 'guest', hostId: room.hostId, peers: existing });
    }

    const room = rooms.get(code);
    if (!room) return sendJson(res, 404, { error: 'room_not_found' });

    if (action === 'signal') {
      const from = room.peers.get(typeof data.from === 'string' ? data.from : '');
      const to = room.peers.get(typeof data.to === 'string' ? data.to : '');
      if (!from || !to) return sendJson(res, 403, { error: 'forbidden' });
      send(to, { type: 'signal', from: from.peerId, payload: data.payload });
      return sendJson(res, 204);
    }

    // leave: 모르는 peerId여도 204(이미 나간 경우 포함, 멱등).
    if (typeof data.peerId === 'string') removePeer(room, data.peerId);
    return sendJson(res, 204);
  }

  function serveStatic(req, res, rawPath) {
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Not found');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return notFound();
    }
    if (decoded === '/' || decoded === '') decoded = '/call.html';
    if (decoded.includes('\0') || decoded.includes('\\')) return notFound();
    const segs = decoded.split('/').filter(Boolean);
    // 경로 탈출 금지. 숨김 파일(.git 등)과 certs/(개인키)도 내보내지 않는다.
    if (segs.some((s) => s === '..' || s.startsWith('.')) || segs[0] === 'certs') return notFound();
    const file = path.resolve(rootDir, ...segs);
    if (!file.startsWith(rootDir + path.sep)) return notFound();

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  }

  return function handler(req, res) {
    const rawUrl = req.url || '/';
    const q = rawUrl.indexOf('?');
    const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const query = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1));

    if (rawPath === '/api' || rawPath.startsWith('/api/')) {
      const parts = rawPath.slice(5).split('/').filter(Boolean).map((p) => {
        try { return decodeURIComponent(p); } catch { return ''; }
      });
      handleApi(req, res, parts, query).catch((e) => {
        console.error('[call-server] api error', e);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        else res.destroy();
      });
      return;
    }
    serveStatic(req, res, rawPath);
  };
}

/**
 * @param {{port?: number, http?: boolean, root?: string}} opts
 * @returns {http.Server | https.Server}
 */
export function startCallServer({ port = 8443, http: useHttp = false, root = REPO_ROOT } = {}) {
  const scheme = useHttp ? 'http' : 'https';
  let server;
  if (useHttp) {
    server = http.createServer();
  } else {
    const certFile = path.join(REPO_ROOT, 'certs', 'cert.pem');
    const keyFile = path.join(REPO_ROOT, 'certs', 'key.pem');
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      const err = new Error(
        `인증서가 없습니다 (${path.relative(process.cwd(), certFile) || certFile}, key.pem).\n` +
        '먼저 `tools/make-cert.sh`를 실행해 인증서를 만들어 주세요. (HTTPS 없이 띄우려면 --http)'
      );
      err.code = 'CERT_MISSING';
      throw err;
    }
    server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) });
  }

  server.listen(port, HOST, () => {
    const actualPort = server.address().port;
    server.on('request', createCallHandler({ root, port: actualPort, scheme }));
    const ips = detectLanIps();
    console.log(`Human Check 통화 서버 실행 중 (${scheme}, ${HOST}:${actualPort})`);
    console.log('접속 주소:');
    for (const ip of ips) console.log(`  ${scheme}://${ip}:${actualPort}/call.html`);
    console.log(`  ${scheme}://localhost:${actualPort}/call.html`);
    if (!ips.length) console.log('  (LAN IPv4 주소를 찾지 못했습니다. Wi-Fi 연결을 확인해 주세요.)');
  });
  return server;
}

function parseArgs(argv) {
  const opts = { port: 8443, http: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') opts.http = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else {
      console.error(`알 수 없는 옵션: ${a}\n사용법: node server/call-server.mjs [--port 8443] [--http]`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('--port 값이 올바르지 않습니다.');
    process.exit(1);
  }
  return opts;
}

const isMain = import.meta.main ?? (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const server = startCallServer({ ...opts, root: REPO_ROOT });
    server.on('error', (e) => {
      console.error(e.code === 'EADDRINUSE' ? `포트 ${opts.port}을(를) 이미 쓰고 있습니다. --port로 다른 포트를 지정해 주세요.` : e);
      process.exit(1);
    });
  } catch (e) {
    console.error(e.code === 'CERT_MISSING' ? e.message : e);
    process.exit(1);
  }
}
