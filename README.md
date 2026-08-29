# Minesweeper Flags Extreme

Two-player minesweeper where you **want** to hit the mines. 16×16 board, 51 mines,
first to capture 26 wins. Hit a mine and you keep playing; open a safe square and
the turn passes. Once per game, while not in the lead, you can detonate a 5×5 bomb.

A static, offline-first PWA — no backend runs any game code. Online play works by
passing encrypted state through any MQTT broker over WebSockets; the passphrase
both players agree on derives the room topic and the AES-GCM key, so the broker
only ever sees ciphertext.

## Play

- **vs AI** — single player against a probability-based AI.
- **Two players, this device** — pass-and-play.
- **Online** — both players enter the same passphrase; one taps *Create*, the other *Join*.

## Run locally

```sh
python3 -m http.server 8123     # or: npm run serve
# open http://localhost:8123
```

## Own broker

`local/` is gitignored and holds the broker config:

```sh
mosquitto -c local/mosquitto.conf
```

Then set the MQTT URI under Settings → Advanced, e.g. `ws://<host>:9001`.
Note: when the game itself is served over **HTTPS** (GitHub Pages), browsers block
plain `ws://` — the broker then needs TLS (`wss://`) or a TLS-terminating proxy.
Until then, the default is the public sandbox broker `wss://test.mosquitto.org:8081/mqtt`
(fine for encrypted traffic, zero guarantees on uptime or retention).

## Develop

```sh
npm test        # engine + AI rules tests (plain node, no deps)
npm run icons   # regenerate PNG icons (dependency-free generator)
```

`js/game.js` is the pure rules engine, `js/ai.js` the AI (public information only),
`js/net.js` MQTT + crypto, `js/app.js` the UI glue.

## Deploy (later)

Push to a **public** GitHub repo → Settings → Pages → deploy from branch. The app
is fully relative-pathed, so it works from a `/repo-name/` subpath.

## Roadmap

- Async games: durable state store (Upstash Redis) instead of broker-retained messages.
- Turn push notifications: Web Push sent via a GitHub Action (`repository_dispatch`),
  or ntfy.sh as the simple fallback.
- iOS: add to home screen from Safari to get standalone mode (and, later, push).
