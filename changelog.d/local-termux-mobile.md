### Added

- Port the OpenBot Termux server to upstream v0.62. It runs the same AgentService, stores and Team API routes as the desktop app, and keeps its loopback-only, token-protected API.
- Add Codex live voice to the Termux server: `GET`/`PUT /api/voice/live`, `POST /api/voice/live/start` and `POST /api/voice/live/stop`. The server sends call events on its WebSocket.
- Add an OpenBot Local mode to the Android app. It keeps cloud servers on the existing invitation and WebRTC transport.
- Add authenticated local agent and conversation routes for the existing Termux AgentService.
- Limit Android cleartext HTTP to loopback destinations.
