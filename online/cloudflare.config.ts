import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "patrol-online",
    compatibilityDate: "2026-11-24",
    entrypoint: "./worker.mjs",
    domains: ["patrol.etta.top"],
    exports: ({ exports }) => ({
      PatrolRoom: exports.durableObject({ storage: "sqlite" })
    })
  }
});
