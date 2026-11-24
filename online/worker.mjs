import { DurableObject } from "cloudflare:workers";
import gameHtml from "./.generated-game.mjs";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const roomPattern = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const roomLifetime = 45 * 60_000;
const guestReservation = 90_000;
const turnSeconds = 1800;
const dailyTurnLimit = 12;
const dailyRoomLimit = 80;
const dailyIpLimit = 8;
const messageLimit = 32;

const randomBytes = count => crypto.getRandomValues(new Uint8Array(count));
const roomCode = () => Array.from(randomBytes(10), value => alphabet[value & 31]).join("");
const token = () => Array.from(randomBytes(32), value => value.toString(16).padStart(2, "0")).join("");
const utcDay = () => Math.floor(Date.now() / 86_400_000);
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const error = (code, status) => json({ error: code }, status);

export function signalFrom(role, value) {
  const mayOffer = role === "host" && value?.type === "offer";
  const mayAnswer = role === "guest" && value?.type === "answer";
  if (role === "host" && value?.type === "fallback") return { type: "fallback" };
  if ((!mayOffer && !mayAnswer) || !["direct", "relay"].includes(value.mode) ||
      typeof value.sdp !== "string" || !value.sdp.startsWith("v=0") || value.sdp.length > 28000) return null;
  return { type: value.type, mode: value.mode, sdp: value.sdp };
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    if (["GET", "HEAD"].includes(request.method) && ["/", "/index.html"].includes(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : gameHtml, { headers: { "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=120", "Referrer-Policy": "no-referrer" } });
    }
    if (!/^\/api\/rooms(?:\/[^/]+\/(?:join|socket|turn))?$/.test(url.pathname)) return error("not-found", 404);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return error("origin-denied", 403);
    return ctx.exports.PatrolRoom.getByName("patrol-service-v1").fetch(request);
  }
};

export class PatrolRoom extends DurableObject {
  get state() { return this.ctx.storage; }

  async fetch(request) {
    const url = new URL(request.url);
    const [, , , code, action] = url.pathname.split("/");
    if (!code) {
      if (request.method !== "POST") return error("method", 405);
      return this.create(request.headers.get("CF-Connecting-IP") || "local");
    }
    if (!roomPattern.test(code)) return error("bad-room", 400);
    const room = await this.state.get("room:" + code);
    if (!room || room.expires <= Date.now()) return error("not-found", 404);
    if (action === "join" && request.method === "POST") return this.join(code);
    if (action === "socket" && request.method === "GET") {
      const role = this.roleFor(room, url.searchParams.get("token"));
      if (!role) return error("invalid-token", 401);
      return this.connect(request, code, room, role);
    }
    if (action === "turn" && request.method === "POST") {
      const role = this.roleFor(room, request.headers.get("Authorization")?.match(/^Bearer (.+)$/i)?.[1]);
      if (!role) return error("invalid-token", 401);
      return this.turn(code, role);
    }
    return error("method", 405);
  }

  async create(ip) {
    const accepted = await this.state.transaction(async storage => {
      const day = utcDay();
      const previous = await storage.get("roomBudget");
      const budget = previous?.day === day ? previous : { day, total: 0, addresses: {} };
      const addressCount = budget.addresses[ip] || 0;
      if (budget.total >= dailyRoomLimit || addressCount >= dailyIpLimit) return null;
      let code;
      do { code = roomCode(); } while (await storage.get("room:" + code));
      const room = { expires: Date.now() + roomLifetime, host: token(), guest: null, guestUntil: 0 };
      budget.total++;
      budget.addresses[ip] = addressCount + 1;
      await storage.put({ roomBudget: budget, ["room:" + code]: room });
      if (!(await storage.getAlarm())) await storage.setAlarm(room.expires);
      return { room: code, token: room.host };
    });
    return accepted ? json(accepted, 201) : error("room-limit", 429);
  }

  roleFor(room, value) {
    if (typeof value !== "string" || !tokenPattern.test(value)) return null;
    if (value === room.host) return "host";
    if (value === room.guest && room.guestUntil > Date.now()) return "guest";
    return null;
  }

  async join(code) {
    const guest = await this.state.transaction(async storage => {
      const key = "room:" + code;
      const room = await storage.get(key);
      if (!room || room.expires <= Date.now()) return false;
      if (room.guestUntil > Date.now()) return null;
      room.guest = token();
      room.guestUntil = Date.now() + guestReservation;
      await storage.put(key, room);
      return room.guest;
    });
    if (guest === false) return error("not-found", 404);
    return guest ? json({ room: code, token: guest }) : error("room-full", 409);
  }

  async connect(request, code, room, role) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("upgrade-required", 400);
    const tag = code + ":" + role;
    if (this.ctx.getWebSockets(tag).some(socket => socket.readyState === 1)) return error("seat-connected", 409);
    if (role === "guest" && room.guestUntil !== room.expires) {
      const reserved = await this.state.transaction(async storage => {
        const key = "room:" + code;
        const current = await storage.get(key);
        if (!current || this.roleFor(current, room.guest) !== "guest") return false;
        current.guestUntil = current.expires;
        await storage.put(key, current);
        return true;
      });
      if (!reserved) return error("invalid-token", 401);
      if (this.ctx.getWebSockets(tag).some(socket => socket.readyState === 1)) return error("seat-connected", 409);
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [code, tag]);
    server.serializeAttachment({ code, role, expires: room.expires, sent: 0 });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const sockets = this.ctx.getWebSockets(code);
    if (sockets.filter(socket => socket.readyState === 1).length === 2) {
      for (const socket of sockets) this.send(socket, { type: "peer-ready" });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, payload) {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  webSocketMessage(socket, message) {
    const seat = socket.deserializeAttachment();
    if (!seat || seat.expires <= Date.now()) { socket.close(4001, "expired"); return; }
    if (typeof message !== "string" || message.length > 32000 || seat.sent >= messageLimit) {
      socket.close(1008, "limit");
      return;
    }
    let value;
    try { value = JSON.parse(message); } catch { socket.close(1008, "invalid"); return; }
    const signal = signalFrom(seat.role, value);
    if (!signal) { socket.close(1008, "invalid"); return; }
    seat.sent++;
    socket.serializeAttachment(seat);
    for (const other of this.ctx.getWebSockets(seat.code)) {
      if (other !== socket) this.send(other, signal);
    }
  }

  webSocketClose(socket, code, reason) {
    const seat = socket.deserializeAttachment();
    if (seat && seat.expires > Date.now()) {
      for (const other of this.ctx.getWebSockets(seat.code)) {
        if (other !== socket) this.send(other, { type: "peer-left" });
      }
    }
    socket.close(code === 1006 ? 1000 : code, code === 1006 ? "" : reason);
  }

  webSocketError(socket) { socket.close(1011, "error"); }

  async turn(code, role) {
    const { TURN_KEY_ID, TURN_API_TOKEN } = this.env;
    if (!TURN_KEY_ID || !TURN_API_TOKEN) return error("relay-unavailable", 503);
    const peersPresent = ["host", "guest"].every(seat =>
      this.ctx.getWebSockets(code + ":" + seat).some(socket => socket.readyState === 1));
    if (!peersPresent) return error("peer-not-ready", 409);
    const key = "room:" + code;
    const reserved = await this.state.transaction(async storage => {
      const room = await storage.get(key);
      if (!room || room.expires <= Date.now()) return { error: "not-found", status: 404 };
      const existing = room[role + "Turn"];
      if (existing?.iceServers) return { cached: existing.iceServers };
      if (existing) return { error: "relay-requested", status: 409 };
      const day = utcDay();
      const current = await storage.get("turnBudget");
      const budget = current?.day === day ? current : { day, used: 0 };
      if (budget.used >= dailyTurnLimit) return { error: "relay-limit", status: 429 };
      room[role + "Turn"] = { pending: true };
      budget.used++;
      await storage.put({ [key]: room, turnBudget: budget });
      return { reserved: true };
    });
    if (reserved.error) return error(reserved.error, reserved.status);
    if (reserved.cached) return json({ iceServers: reserved.cached });
    let iceServers;
    try {
      const response = await fetch(
        "https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(TURN_KEY_ID) + "/credentials/generate-ice-servers",
        { method: "POST", headers: { Authorization: "Bearer " + TURN_API_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: turnSeconds }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("TURN API");
      const data = await response.json();
      iceServers = data.iceServers.filter(server => server.username && server.credential).map(server => ({
        ...server, urls: [].concat(server.urls).filter(url => /^turns?:/.test(url) && !/:53(?:\?|$)/.test(url))
      })).filter(server => server.urls.length);
      if (!iceServers.length) throw new Error("No TURN URLs");
    } catch {
      await this.state.transaction(async storage => {
        const room = await storage.get(key);
        if (!room) return;
        delete room[role + "Turn"];
        await storage.put(key, room);
      });
      return error("relay-unavailable", 503);
    }
    await this.state.transaction(async storage => {
      const room = await storage.get(key);
      if (!room) return;
      room[role + "Turn"] = { iceServers };
      await storage.put(key, room);
    });
    return json({ iceServers });
  }

  async alarm() {
    let earliest = Infinity;
    for (const [key, room] of await this.state.list({ prefix: "room:" })) {
      if (room.expires > Date.now()) { earliest = Math.min(earliest, room.expires); continue; }
      await this.state.delete(key);
      for (const socket of this.ctx.getWebSockets(key.slice(5))) socket.close(4001, "expired");
    }
    if (Number.isFinite(earliest)) await this.state.setAlarm(earliest);
  }
}
