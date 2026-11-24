# PATROL online service

Run `npm ci`, then `npm run dev` from this directory. The local preview uses the real Workers runtime at `http://127.0.0.1:8792`. `npm test` runs the HTTP and WebSocket integration test with an isolated in-memory namespace. The pinned local Miniflare runtime uses the compatibility date it supports. Production configuration has its own compatibility date.

The service delivers the root game's `index.html` as a generated Worker module. Run `npm run prepare:assets` before packaging. The deployed Worker uses the `PatrolRoom` SQLite Durable Object export and production domain `patrol.etta.top`. Only the HTTPS game origin can call the browser pairing API. WebRTC handles gameplay traffic outside the Worker.

Automatic relay uses the Worker secrets `TURN_KEY_ID` and `TURN_API_TOKEN`. Configure them in the provider or the Worker deployment system. The Worker mints a 30-minute credential for each authenticated room seat on demand. It limits creation to eight rooms per source per UTC day, 80 rooms across the service, and 12 TURN credentials across the service. These limits control issuance. They are separate from the provider's metered egress and account billing limits.

When no TURN credentials are configured, invitation signaling and WebRTC direct connections stay available. Offline manual connections continue to use the root HTML on its own.
