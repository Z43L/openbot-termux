# OpenBot on native Termux

## Current result

`src/termux/main.ts` starts a server without importing Electron. It initializes the original
`AgentStore`, `MailboxStore`, and `AgentService`. It serves an authenticated local HTTP API and an
authenticated server-sent event stream and WebSocket event stream. It binds only to `127.0.0.1`, uses the original SQLite
database, and stores data under `~/.local/share/openbot-termux` by default.

The Termux backend supports agent create/list, conversation read, and message submission through
the original services. The browser host is an explicit disabled adapter. Browser and desktop
computer-use operations fail as unsupported; they do not run through X11, Xvfb, or an arbitrary
shell. The mobile app has an OpenBot Local connection mode for the authenticated local API. It does
not use the official account directory, invitations, Signal, or WebRTC. See
[`TERMUX-MOBILE.md`](./TERMUX-MOBILE.md) for current support and limits.

## Runtime evidence

This environment is Android/aarch64. Bare `node --version` fails because Node cannot resolve
`_ZNSt6__ndk113__hash_memoryEPKvm`. The interactive user's `.bashrc` sets `LD_LIBRARY_PATH` to
`$PREFIX/lib`; the non-interactive tool shell does not read it. With that path, Node v24.22.1 starts.
Node `node:sqlite` and Bun v1.4.0 both created a SQLite file, wrote a row, read it after reopening,
and closed the database. No package was reinstalled.

The focused backend E2E report is `.openbot-build/termux-backend-e2e.json`. It records 17 passing
checks: backend health, auth failures, Origin and Host rejection, agent creation and listing, local
message submission, a completed real Codex CLI turn, response content, authenticated SSE and
WebSocket events, and recovery after a process restart. The test used temporary data and removed it
after the run. The Codex CLI was
already installed and authenticated in this Termux profile. Other installed provider CLIs were
missing credentials or required sign-in during inspection; those providers are not claimed as
working here.

Run the focused integration check with:

```sh
bun scripts/termux-backend-e2e.ts
```

The installer check runs with:

```sh
sh scripts/termux-e2e.sh
```

## Local API

The server uses `http://127.0.0.1:8787`; if that port is busy, it binds an available loopback port
and prints its URL in the service log. `/health` runs SQLite `PRAGMA quick_check` and reports the
AgentService and provider states. API routes and the event stream require a bearer token. The server
creates a random token in `~/.local/share/openbot-termux/server-token` with mode `0600` and checks
that an existing token is private and owned by the current user. Read it with `openbot-termux token`.
Do not paste it into logs or share it with another device. CORS and Host checks reject non-local
origins and hosts.

Available routes:

- `GET /health`
- `GET /api/agents`
- `POST /api/agents`
- `GET /api/agents/:id/conversation`
- `GET /api/agents/:id/conversation-page?limit=50` (mobile conversation page)
- `GET /api/reads` (local mobile read state)
- `POST /api/agents/:id/messages`
- `GET /api/events` (authenticated SSE endpoint and WebSocket upgrade for AgentService events)

The API reuses OpenBot service methods and schemas for agent operations. It is not the released Team
API and does not claim Team API wire compatibility. The local mobile transport uses its authenticated
WebSocket event stream. OpenBot Local is separate from official cloud hosts. See
[`TERMUX-MOBILE.md`](./TERMUX-MOBILE.md) for protocol details and limits.

## Runit setup

Install `termux-services` using Termux's package manager, then restart Termux to start its runit
supervisor. Then install this service from the repository:

```sh
sh scripts/termux/install
sv-enable openbot
sv up openbot
sv status openbot
```

Manage it with `openbot-termux start`, `stop`, `restart`, `status`, and `logs`. The runit logger
keeps 10 files of up to 1 MB each under `~/.openbot-termux/log`. Failed service exits wait 60 seconds
before a retry. The service runs under the Termux user; no root, systemd, PRoot, or Docker is used.

For optional boot after Android restarts, run `sh scripts/termux/install --boot`. Install and open
the separate Termux:Boot app once. Its hook loads the official `termux-services` startup script.
Android can still stop background processes. Battery optimization changes and wake locks are not
applied automatically. A wake lock uses more battery while active.

The installed `openbot` service was restarted with runit and returned to `run`. Authenticated
agent-list and read-state requests returned HTTP 200. Termux:Boot after a physical Android restart and
supervised recovery after an unexpected process crash remain unverified.

## Compatibility record

| Area | State | Evidence |
| --- | --- | --- |
| Electron-free backend startup | Implemented and tested | Backend E2E started `src/termux/main.ts`; imports original backend services |
| SQLite persistence | Implemented and tested | Reopen after process restart recovered the created agent and completed reply |
| Agent creation and listing | Implemented and tested | Calls original `AgentStore` / `AgentService` |
| Real agent turn | Tested for local Codex CLI | Codex returned a completed response through original `AgentService` |
| HTTP authentication and local binding | Implemented and tested | Unauthenticated request returned 401; bind is loopback |
| Event delivery | Implemented and tested | Authenticated WebSocket delivered the original completed-turn event; SSE still responds |
| Browser/computer-use agents | Disabled | Termux `AgentBrowserHost` rejects browser operations |
| Official Team API, Signal and WebRTC | Not implemented | The Electron host bridge is unavailable on Android; local mode is separate |
| Android app connection | Partly implemented | Local sign-in-free route and API screen compile in Metro; the screen was not run on Android |
| runit | Running | `sv status openbot` reported `run`; service restarted and API routes returned 200 |
| Termux:Boot | Prepared, not tested on device | Physical Android restart and boot-script run were not tested |
| Browser access from Android Chrome | Not tested | No local web UI is served |

## Checks not completed

`bun run typecheck:node` cannot start its TypeScript compiler in this Android installation because
the platform package `@typescript/typescript-android-arm64` is missing. Biome also has no Android
prebuilt executable in the installed dependency tree. Bun's bundler parsed the changed TS and TSX
files, and Metro generated a 40 MB Android bundle. These do not replace type checking. Expo prebuild
generated the loopback-only network config. Expo Go could not start because Android denied Termux
permission to inspect or launch its activity. An offline APK build failed because a Gradle plugin was
not cached; the device also has no Android SDK and no `ANDROID_HOME` or `ANDROID_SDK_ROOT`. The app
was not installed or opened. No broad repository checks were run.
