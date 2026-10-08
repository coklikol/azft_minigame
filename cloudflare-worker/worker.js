/**
 * Cloudflare Worker — сервер синхронизации для игры «Угадай Картинку».
 *
 * Нужен, потому что localStorage/BroadcastChannel работают только внутри
 * одного браузера: без сервера друг на другом устройстве не увидит комнаты.
 *
 * === УСТАНОВКА (бесплатно) ===
 * 1) npm install -g wrangler && wrangler login
 * 2) Создайте KV-неймспейс (id вставьте в wrangler.toml):
 *      wrangler kv namespace create SYNC
 * 3) Деплой:
 *      wrangler deploy
 * 4) Скопируйте URL воркера (вида https://guess-sync.<имя>.workers.dev)
 *    и вставьте его в index.html в константу SYNC_SERVER_URL.
 */

const ROOM_TTL = 6 * 60 * 60;      // комната живёт 6 часов без обновлений
const CHAT_TTL = 6 * 60 * 60;
const EVENTS_TTL = 24 * 60 * 60;   // события хранятся сутки

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleRoom(env, code, req) {
  if (req.method === 'POST') {
    const room = await req.json();
    if (!room || room.code !== code) return json({ error: 'bad room' }, 400);
    await env.SYNC.put(`room:${code}`, JSON.stringify(room), { expirationTtl: ROOM_TTL });
    await bumpEvents(env, 'room', { code, rev: room.rev || 0 });
    return json({ ok: true, rev: room.rev || 0 });
  }
  if (req.method === 'GET') {
    const raw = await env.SYNC.get(`room:${code}`);
    if (!raw) return json({ error: 'not found' }, 404);
    return json(JSON.parse(raw));
  }
  if (req.method === 'DELETE') {
    await env.SYNC.delete(`room:${code}`);
    await env.SYNC.delete(`chat:${code}`);
    await bumpEvents(env, 'deleted', { code });
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}

async function handleChat(env, code, req) {
  if (req.method === 'POST') {
    const msg = await req.json();
    const raw = await env.SYNC.get(`chat:${code}`);
    const msgs = raw ? JSON.parse(raw) : [];
    msgs.push(msg);
    const trimmed = msgs.slice(-500); // ограничиваем историю чата
    await env.SYNC.put(`chat:${code}`, JSON.stringify(trimmed), { expirationTtl: CHAT_TTL });
    await bumpEvents(env, 'chat', { code });
    return json({ ok: true });
  }
  if (req.method === 'GET') {
    const raw = await env.SYNC.get(`chat:${code}`);
    return json(raw ? JSON.parse(raw) : []);
  }
  if (req.method === 'DELETE') {
    await env.SYNC.delete(`chat:${code}`);
    await bumpEvents(env, 'chat', { code });
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}

async function bumpEvents(env, kind, payload) {
  const n = parseInt((await env.SYNC.get('events:counter')) || '0', 10) + 1;
  await env.SYNC.put('events:counter', String(n));
  await env.SYNC.put(`event:${n}`, JSON.stringify({ id: n, kind, payload }), { expirationTtl: EVENTS_TTL });
  return n;
}

// Клиент спрашивает: «что произошло после cursor?» — возвращаем свежие комнаты/чаты.
async function handleEvents(env, url) {
  const since = parseInt(String(url.searchParams.get('since') || '0').split('-')[0], 10) || 0;
  const counter = parseInt((await env.SYNC.get('events:counter')) || '0', 10);
  const cursor = `${counter}-0`;
  if (counter === since) return json({ cursor, rooms: [], chats: {} });

  const touchedRooms = new Set();
  const touchedChats = new Set();
  let deletedCode = null;
  const from = Math.max(since + 1, Math.max(1, counter - 200)); // читаем не больше 200 событий за раз
  for (let i = from; i <= counter; i++) {
    const raw = await env.SYNC.get(`event:${i}`);
    if (!raw) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.kind === 'room') touchedRooms.add(ev.payload.code);
    else if (ev.kind === 'chat') touchedChats.add(ev.payload.code);
    else if (ev.kind === 'deleted') { deletedCode = ev.payload.code; touchedRooms.delete(ev.payload.code); }
  }

  const rooms = [];
  for (const code of touchedRooms) {
    const raw = await env.SYNC.get(`room:${code}`);
    if (raw) rooms.push(JSON.parse(raw));
  }
  const chats = {};
  for (const code of touchedChats) {
    const raw = await env.SYNC.get(`chat:${code}`);
    chats[code] = raw ? JSON.parse(raw) : [];
  }
  return json({ cursor, rooms, chats, deleted: deletedCode });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/api/health') return json({ ok: true, time: Date.now() });
      let m;
      if ((m = path.match(/^\/api\/room\/([^\/]+)$/))) return await handleRoom(env, decodeURIComponent(m[1]), req);
      if ((m = path.match(/^\/api\/chat\/([^\/]+)$/))) return await handleChat(env, decodeURIComponent(m[1]), req);
      if (path === '/api/events') return await handleEvents(env, url);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
