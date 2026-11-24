import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const server = new Miniflare({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 8792),
  compatibilityDate: "2026-07-30",
  modules: true,
  scriptPath: fileURLToPath(new URL("./worker.mjs", import.meta.url)),
  durableObjects: { PatrolRoom: { className: "PatrolRoom", useSQLite: true } }
});
console.log("PATROL preview at " + await server.ready);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.dispose(); process.exit(0); });
