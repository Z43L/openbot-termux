# Termux and the official OpenBot mobile app

## Finding

The current Termux backend cannot appear as an official OpenBot server in the mobile app. No
official host registration, Team API, Signal session, or WebRTC connection is implemented by
`src/termux/main.ts`. Its `/api/agents` routes are a separate local API.

The mobile app does not accept a server URL and bearer token as a server connection. Its Add Server
screen accepts a signed OpenBot invitation URL. The app previews and accepts that invitation through
`RemoteTeamDirectoryClient`, then reads the account's host directory. See
`apps/mobile/src/features/servers/screens/add-server-screen.tsx` and
`apps/mobile/src/features/workspace/context/mobile-workspace-context.tsx`.

## Official connection flow

1. `TeamStore` keeps the persistent host identity and signing keys.
2. `CentralAuthManager` signs in to the OpenBot account service. It registers the host at
   `/v2/remote/hosts/register` and stores the returned machine credential in its protected session
   storage. It uses that credential to request host Signal tickets.
3. `HostService` starts `TeamApiServer` and `TeamWebRtcHostGateway`. It publishes online status only
   after the host reaches Signal. Team API requests travel over authenticated WebRTC data channels.
4. The account service creates and accepts invitations. It checks host identity, membership, and
   ticket signatures. Routes also check the member's role and permissions.
5. The mobile app loads hosts from the account directory. Its `RemoteTeamTransport` runs the official
   `createRemoteTeamPeer` client in an Expo DOM page. Signal provides connection setup; WebRTC carries
   RPC and events.

These are protocol operations. A local HTTP response, invented invitation, or copied ticket cannot
replace them.

## Android blocker

The official host transport is not independent of Electron. `src/main/team-webrtc-bridge.ts` imports
`BrowserWindow`, `MessageChannelMain`, and `MessagePortMain` from Electron. It hosts the peer runtime
inside an Electron window. `HostService` uses this bridge through `TeamWebRtcHostGateway`.

I tested importing this module with Bun on Termux. It failed with:

```text
Electron builds are not available on platform: android
```

The repository has no Android-capable Node WebRTC implementation to replace that bridge. Reusing the
host service without a WebRTC bridge would not publish a usable server. The account manager and host
service also require the original protected credential storage, persistent TeamStore identity,
account registration, Signal tickets, and Team API dependencies. Termux currently initializes none
of these services.

The current Termux server does not have `login` or `mobile-connect` commands. It cannot create a real
host invite, Mobile Connect ticket, or Signal session. Do not give its custom API token to the
official mobile app as though it were a Team API credential.

## Mobile Connect without a second screen

The official Mobile Connect link uses the `openbot://mobile-connect` scheme. The production app
routes a valid link to an incoming-link screen and redeems it after the user taps Connect. This path
uses the same account service and signed one-time ticket as the QR flow. Therefore a second screen is
not required once a real link exists: Termux could open or copy the link for the app on the same
phone. The current Termux backend cannot create that link because it has no registered host or
authenticated CentralAuthManager session.

This pairing flow signs the phone into the account. Host discovery and remote access still require a
published host and the official Signal/WebRTC transport.

## Local Termux mode

The mobile Add Server sheet now has **OpenBot Cloud** and **OpenBot Local** modes. Local mode accepts
the loopback URL, bearer token, and server name. The app checks `/health` and the authenticated agent
list before it saves the server. It stores the token in Expo SecureStore. The saved URL is limited to
`http://127.0.0.1` or `http://localhost`. It does not accept a LAN or public address.

`LocalTermuxTransport` maps the app's existing agent list, create, conversation page, read-state, and
message requests to Termux API routes. It uses the authenticated WebSocket upgrade at
`/api/events` for original AgentService events. The bearer token is sent in a WebSocket subprotocol,
not in the URL. The backend keeps its authenticated SSE endpoint for existing clients. It retains
`/api/agents/:id/conversation` for its earlier snapshot contract and adds `/conversation-page` for the
mobile conversation contract. An initial message uses the original `AgentService.createAgent`
operation. Attachments, browser views, and other Team API features that Termux does not implement
return an unsupported-operation error. The local server does not join the account directory, use
invitations, or use Signal/WebRTC.

Android cleartext traffic is denied by default. The generated manifest points to a network security
configuration that permits HTTP only for loopback destinations. The mobile transport rejects other
URLs before it sends a request.

The sign-in screen now offers OpenBot Local. This route does not create or change a Cloud session. It
stores the local bearer token in Expo SecureStore, checks the authenticated backend, lists agents,
creates an agent with a first message, reads saved conversation pages, and sends messages. It polls
the real API to show replies and reconnect after a server restart. The local route can return to the
Cloud sign-in flow. Existing saved local settings open this route on a cold start when no Cloud
session exists. A Cloud session that signs out is not redirected to local mode.

The route and API calls compile in Metro. They have not run in the Android application. No agent
creation or message from this screen has been observed. Expo Go did not launch in this environment,
so SecureStore and the Android HTTP policy remain untested in the app.

### Codex live voice on the phone

Codex live voice needs the Codex CLI on the Termux server, signed in with ChatGPT. A Codex agent of
the local server can talk in real time:

- Settings > Voice > Listening > **Codex live voice** turns it on. The setting is stored by the
  server in `voice-live.json` in the data directory. It is off until the user turns it on. While it
  is off, the server refuses a live voice start with HTTP 409.
- The chat mic of a Codex agent on OpenBot Local starts the call. The phone's WebRTC peer, in a hidden
  page (`codex-live-bridge.dom.tsx`), holds the microphone and plays the reply. It sends its offer to
  `POST /api/voice/live/start`. The server asks Codex App Server for a realtime call with
  `AgentService.startLiveVoice`, and returns the answer. Turns of the voice model run in the agent's
  chat.
- The server sends the call's transcript and end on the WebSocket as `{ "type": "voice-live" }`
  messages. `POST /api/voice/live/stop` ends a call.
- Other agents, other servers and the account servers keep the on-device voice of the app.

Not verified: a real call with a ChatGPT sign-in, the WebRTC peer in the Android WebView (microphone
permission, audio playback and echo cancellation), and interrupt, which here ends the call and starts
it again on the same thread.

## Verification

- The authenticated `/api/agents`, `/api/agents/:id/conversation-page`, `/api/reads`,
  `/api/agents/:id/messages`, SSE, and WebSocket event routes were exercised by the Termux E2E script.
- The E2E run completed one real Codex CLI turn and recovered its conversation after a process restart.
- The persistent service returned HTTP 200 for an authenticated agent-list request; it currently has
  no saved agents.
- Expo prebuild generated the loopback-only network security XML and manifest settings.
- Expo Go was installed, but Android denied Termux access to inspect app activities. The app did not
  start, so UI, SecureStore, and Android HTTP policy were not device-tested.
- `OPENBOT_LOCAL_TERMUX_BUILD=1 bunx expo config --type public --json` returns package
  `run.openbot.mobile.termux`. The local build has no Cloud update URL and uses a separate Expo
  project. The EAS profile `localTermux` creates an APK and excludes tracked encrypted account
  settings, the Firebase file and local state from its upload archive.
- EAS created a separate project under the signed-in personal account and created a remote Android
  signing key. Both upload attempts failed before EAS created a build: the first timed out; the retry
  ended when the socket closed. `eas build:list` returned no build. No APK is available. No GitHub
  repository was created or changed.
- Expo bundled the Android app (5,517 modules), but the full export failed later while resolving a
  web DOM asset. Hermes bytecode generation also fails on the Android host because the Hermes
  compiler has no Android host build. These are not APK builds.

### No-cost local APK build

Use a Linux computer with Java 21 and the free Android SDK command-line tools. From the repository
root, run:

```sh
bun install --frozen-lockfile
cd apps/mobile
OPENBOT_LOCAL_TERMUX_BUILD=1 bunx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleDebug
```

The debug APK is `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. The build flag gives
it the separate package `run.openbot.mobile.termux` and the link scheme `openbot-local-termux`, so it
can sit beside the official app. This variant is for local Termux mode. The normal build keeps the
official package and scheme. It also omits the official Firebase configuration. Push notifications
are not configured for this local build.

For a remote EAS APK build, use the configured `localTermux` profile from `apps/mobile`:

```sh
OPENBOT_LOCAL_TERMUX_BUILD=1 bunx eas-cli@latest build --platform android --profile localTermux
```

EAS must upload the inspected source archive to its private build storage. The profile uses the
separate project ID in `app.config.js`; it does not use the official OpenBot EAS project. The upload
failed from this Termux environment, so this command has not produced an APK here.
- Bun import of `src/main/team-webrtc-bridge.ts` fails on Android because Electron has no Android
  build.
- No official host registration, invite redemption, Mobile Connect redemption, Signal session,
  WebRTC peer, or mobile app connection was run against the Termux service.
