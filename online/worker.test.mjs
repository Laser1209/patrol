import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("two seats exchange otherwise private signaling, with guarded TURN", { timeout: 25_000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./dev.mjs", import.meta.url))], {
    env: { ...process.env, PORT: "0" }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  const [startup] = await once(child.stdout, "data");
  const base = String(startup).trim().match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(base, String(startup));
  const request = (path, options) => fetch(new URL(path, base), options);
  const create = { method: "POST" };
  assert.match(await (await request("/")).text(), /<title>PATROL<\/title>/i);
  assert.equal((await request("/api/rooms", { ...create, headers: { Origin: "https://other.example" } })).status, 403);
  const hosted = await request("/api/rooms", create);
  assert.equal(hosted.status, 201);
  const host = await hosted.json();
  const path = "/api/rooms/" + host.room;
  const joined = await request(path + "/join", create);
  assert.equal(joined.status, 200);
  const guest = await joined.json();
  assert.equal((await request(path + "/join", create)).status, 409);
  assert.equal((await request(path + "/turn", create)).status, 401);
  const socket = token => {
    const url = new URL(path + "/socket?token=" + token, base);
    url.protocol = "ws:";
    const ws = new WebSocket(url);
    const messages = [];
    ws.addEventListener("message", event => messages.push(JSON.parse(event.data)));
    t.after(() => ws.close());
    return { ws, messages };
  };
  const hostSocket = socket(host.token);
  await once(hostSocket.ws, "open");
  const guestSocket = socket(guest.token);
  await once(guestSocket.ws, "open");
  const next = async target => {
    while (!target.messages.length) await once(target.ws, "message");
    return target.messages.shift();
  };
  assert.deepEqual(await next(hostSocket), { type: "peer-ready" });
  assert.deepEqual(await next(guestSocket), { type: "peer-ready" });
  const offer = { type: "offer", mode: "direct", sdp: "v=0\r\n" };
  hostSocket.ws.send(JSON.stringify({ ...offer, ignored: "field" }));
  assert.deepEqual(await next(guestSocket), offer);
  const answer = { type: "answer", mode: "direct", sdp: "v=0\r\n" };
  guestSocket.ws.send(JSON.stringify(answer));
  assert.deepEqual(await next(hostSocket), answer);
  hostSocket.ws.send(JSON.stringify({ type: "fallback" }));
  assert.deepEqual(await next(guestSocket), { type: "fallback" });
  const unavailable = await request(path + "/turn", { ...create, headers: { Authorization: "Bearer " + host.token } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "relay-unavailable" });
  guestSocket.ws.close();
  assert.deepEqual(await next(hostSocket), { type: "peer-left" });
});
