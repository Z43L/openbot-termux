import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentEvent,
  type AgentSummary,
  type CodexLiveVoice,
  isAgentModel,
  isAgentProvider,
  isAvatarHue,
  isAvatarSeed,
  isCodexLiveVoice,
  isReasoningEffort,
  type VoiceLiveEvent,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import WebSocket, { WebSocketServer } from "ws";
import { AgentService } from "../backend/agent-service";
import { AgentStore } from "../backend/agent-store";
import { MailboxStore } from "../backend/mailbox-store";
import { DisabledBrowserHost } from "./disabled-browser-host";
import { handleTeamRequest } from "./team-api";
import { createTermuxWorkflows, type TermuxWorkflows } from "./workflows";

const logger = createOpenBotLogger("termux-server");
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 8_192;
/** A WebRTC offer of a live voice session is a few kilobytes of SDP. */
const MAX_VOICE_BODY_BYTES = 64_000;
const DEFAULT_DATA_DIRECTORY = join(homedir(), ".local", "share", "openbot-termux");
const TOKEN_FILE = "server-token";
const VOICE_SETTINGS_FILE = "voice-live.json";

/** The user's opt-in to Codex live voice. The audio goes to OpenAI only while it is on. */
interface LiveVoiceSettings {
  codexLive: boolean;
  codexLiveVoice: CodexLiveVoice | null;
}

interface ServerState {
  agents: AgentStore;
  service: AgentService;
  workflows: TermuxWorkflows;
  mailbox: MailboxStore;
  server: Server;
  token: Buffer;
  port: number;
  stopping: boolean;
  eventClients: Set<ServerResponse>;
  webSocketServer: WebSocketServer;
  webSocketClients: Set<WebSocket>;
  voiceSettingsPath: string;
  voiceSettings: LiveVoiceSettings;
  /** The live voice sessions that this server started, so that a stop can check its owner. */
  liveSessions: Set<string>;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    process.stdout.write("Termux backend entry is available. It uses Bun and the original AgentStore.\n");
    return;
  }

  const dataDirectory = process.env.OPENBOT_TERMUX_DATA_DIR ?? DEFAULT_DATA_DIRECTORY;
  const openBotDirectory = process.env.OPENBOT_TERMUX_HOME ?? join(homedir(), "OpenBot-Termux");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);

  const agents = new AgentStore(dataDirectory, homedir(), undefined, undefined, openBotDirectory);
  const mailbox = new MailboxStore(dataDirectory, agents.sharedRoot, agents.database);
  const service = new AgentService({ store: agents, mailbox, browser: new DisabledBrowserHost() });
  await Effect.runPromise(service.initialize());
  const workflows = await Effect.runPromise(createTermuxWorkflows(agents, mailbox, service));
  const token = await loadToken(join(dataDirectory, TOKEN_FILE));
  const voiceSettingsPath = join(dataDirectory, VOICE_SETTINGS_FILE);
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch((error: unknown) => {
      logger.error("A Termux API request failed.", toLogValue(error));
      if (response.headersSent) response.destroy();
      else writeJson(response, 503, { error: "backend_unavailable" });
    });
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("openbot-local") ? "openbot-local" : false),
  });
  const state: ServerState = {
    agents,
    service,
    workflows,
    mailbox,
    server,
    token,
    port: DEFAULT_PORT,
    stopping: false,
    eventClients: new Set(),
    webSocketServer,
    webSocketClients: new Set(),
    voiceSettingsPath,
    voiceSettings: await loadVoiceSettings(voiceSettingsPath),
    liveSessions: new Set(),
  };
  server.on("upgrade", (request, socket, head) => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    const path = new URL(request.url ?? "/", `http://${HOST}:${state.port}`).pathname;
    const failure =
      host !== `127.0.0.1:${state.port}` && host !== `localhost:${state.port}`
        ? "421 Misdirected Request"
        : origin && origin !== `http://127.0.0.1:${state.port}` && origin !== `http://localhost:${state.port}`
          ? "403 Forbidden"
          : path !== "/api/events"
            ? "404 Not Found"
            : !authorizedWebSocket(request, state.token)
              ? "401 Unauthorized"
              : null;
    if (failure) {
      socket.write(`HTTP/1.1 ${failure}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      state.webSocketClients.add(client);
      client.once("close", () => state.webSocketClients.delete(client));
    });
  });
  service.on("event", (event) => broadcastEvent(state, event));
  service.on("liveVoice", (event) => broadcastVoiceLive(state, event));
  state.port = await listen(server);
  logger.info(`Termux API listening on ${HOST}:${state.port}.`);
  process.stdout.write(`OpenBot Termux API: http://${HOST}:${state.port}\n`);

  process.once("SIGINT", () => void shutdown(state, "SIGINT"));
  process.once("SIGTERM", () => void shutdown(state, "SIGTERM"));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: ServerState): Promise<void> {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${state.port}` && host !== `localhost:${state.port}`) {
    writeJson(response, 421, { error: "invalid_host" });
    return;
  }
  const origin = request.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${state.port}` && origin !== `http://localhost:${state.port}`) {
    writeJson(response, 403, { error: "invalid_origin" });
    return;
  }

  const path = new URL(request.url ?? "/", `http://${HOST}:${state.port}`).pathname;
  if (request.method === "GET" && path === "/health") {
    const result = state.agents.database.connection.prepare("PRAGMA quick_check").get();
    const sqlite = result ? Object.values(result)[0] : null;
    const providerStatus = state.service.getStatus().providers?.map(({ id, state: providerState }) => ({
      id,
      state: providerState,
    }));
    const healthy = sqlite === "ok";
    writeJson(response, healthy ? 200 : 503, {
      status: healthy ? "ok" : "failed",
      backend: "openbot-agent-service",
      dependencies: { agentService: "ready", agentStore: "ready", sqlite, providers: providerStatus ?? [] },
    });
    return;
  }

  if (!authorized(request, state.token)) {
    writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }

  if (path.startsWith("/v1/")) {
    await handleTeamRequest(
      request,
      response,
      new URL(request.url ?? "/", `http://${HOST}:${state.port}`),
      state.service,
      state.workflows,
      state.mailbox,
    );
    return;
  }

  if (request.method === "GET" && path === "/api/agents") {
    writeJson(response, 200, { agents: state.service.listAgents() });
    return;
  }
  if (request.method === "GET" && path === "/api/reads") {
    writeJson(response, 200, state.service.listConversationReads("termux-local-owner"));
    return;
  }
  if (request.method === "POST" && path === "/api/agents") {
    const input = await readCreateInput(request);
    if (!input) {
      writeJson(response, 400, { error: "invalid_agent_input" });
      return;
    }
    try {
      const agent = input.initialMessage
        ? await Effect.runPromise(state.service.createAgent({ ...input, initialMessage: input.initialMessage }))
        : await Effect.runPromise(state.agents.createAgent(input));
      state.service.emit("event", { type: "agents-changed", agents: state.service.listAgents() });
      writeJson(response, 201, { agent });
    } catch (error) {
      logger.warn("An agent could not be created through the Termux API.", toLogValue(error));
      writeJson(response, 500, { error: "agent_creation_failed" });
    }
    return;
  }

  if (request.method === "GET" && path === "/api/events") {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.write("event: ready\ndata: {}\n\n");
    state.eventClients.add(response);
    response.once("close", () => state.eventClients.delete(response));
    return;
  }

  if (path === "/api/voice/live" && request.method === "GET") {
    writeJson(response, 200, state.voiceSettings);
    return;
  }
  if (path === "/api/voice/live" && request.method === "PUT") {
    const body = await readJsonRecord(request);
    if (
      !body ||
      typeof body.codexLive !== "boolean" ||
      !(body.codexLiveVoice === null || isCodexLiveVoice(body.codexLiveVoice))
    ) {
      writeJson(response, 400, { error: "invalid_voice_settings" });
      return;
    }
    state.voiceSettings = { codexLive: body.codexLive, codexLiveVoice: body.codexLiveVoice };
    await saveVoiceSettings(state.voiceSettingsPath, state.voiceSettings);
    writeJson(response, 200, state.voiceSettings);
    return;
  }
  if (path === "/api/voice/live/start" && request.method === "POST") {
    // The opt-in is checked here, as the desktop host checks it: the voice goes to OpenAI only while it is on.
    if (!state.voiceSettings.codexLive) {
      writeJson(response, 409, { error: "live_voice_off" });
      return;
    }
    const body = await readJsonRecord(request, MAX_VOICE_BODY_BYTES);
    if (!body || typeof body.agentId !== "string" || typeof body.sdp !== "string" || body.sdp.length === 0) {
      writeJson(response, 400, { error: "invalid_live_voice_start" });
      return;
    }
    if (!state.service.listAgents().some((agent) => agent.id === body.agentId)) {
      writeJson(response, 404, { error: "agent_not_found" });
      return;
    }
    try {
      const session = await Effect.runPromise(
        state.service.startLiveVoice({ agentId: body.agentId, sdp: body.sdp }, state.voiceSettings.codexLiveVoice),
      );
      state.liveSessions.add(session.sessionId);
      writeJson(response, 201, session);
    } catch (error) {
      logger.warn("A Codex live voice session could not start.", toLogValue(error));
      writeJson(response, 503, { error: "live_voice_failed" });
    }
    return;
  }
  if (path === "/api/voice/live/stop" && request.method === "POST") {
    const body = await readJsonRecord(request);
    if (!body || typeof body.sessionId !== "string" || !state.liveSessions.has(body.sessionId)) {
      writeJson(response, 404, { error: "live_voice_not_found" });
      return;
    }
    state.liveSessions.delete(body.sessionId);
    await Effect.runPromise(state.service.stopLiveVoice(body.sessionId));
    writeJson(response, 200, { stopped: true });
    return;
  }

  const agentRoute = /^\/api\/agents\/([A-Za-z0-9-]+)(?:\/(conversation|conversation-page|messages))?$/u.exec(path);
  const agentId = agentRoute?.[1];
  if (agentId && !state.service.listAgents().some((agent) => agent.id === agentId)) {
    writeJson(response, 404, { error: "agent_not_found" });
    return;
  }
  if (agentId && request.method === "GET" && agentRoute?.[2] === "conversation") {
    const conversation = await Effect.runPromise(state.service.readConversation(agentId));
    writeJson(response, 200, { conversation });
    return;
  }
  if (agentId && request.method === "GET" && agentRoute?.[2] === "conversation-page") {
    const limitText = new URL(request.url ?? "/", `http://${HOST}:${state.port}`).searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      writeJson(response, 400, { error: "invalid_limit" });
      return;
    }
    const page = await Effect.runPromise(
      state.service.readConversationPageFor(agentId, "termux-local-owner", undefined, limit),
    );
    writeJson(response, 200, page);
    return;
  }
  if (agentId && request.method === "POST" && agentRoute?.[2] === "messages") {
    const body = await readJsonRecord(request);
    const message = body?.text;
    if (
      (body?.attachmentDraftIds !== undefined &&
        (!Array.isArray(body.attachmentDraftIds) || body.attachmentDraftIds.length > 0)) ||
      (body?.replyToMessageId !== undefined && body.replyToMessageId !== null) ||
      (body?.clientMessageId !== undefined && typeof body.clientMessageId !== "string")
    ) {
      writeJson(response, 501, { error: "unsupported_message_options" });
      return;
    }
    if (
      !body ||
      typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > INPUT_LIMITS.messageText
    ) {
      writeJson(response, 400, { error: "invalid_message" });
      return;
    }
    try {
      const receipt = await Effect.runPromise(
        state.service.sendMessage({
          agentId,
          text: message,
          attachmentDraftIds: [],
          clientMessageId: typeof body.clientMessageId === "string" ? body.clientMessageId : randomUUID(),
        }),
      );
      writeJson(response, 202, { receipt });
    } catch (error) {
      logger.warn("An agent message could not be sent through the Termux API.", toLogValue(error));
      writeJson(response, 503, { error: "agent_message_failed" });
    }
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

async function readJsonRecord(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<DynamicRecord | null> {
  try {
    const value = JSON.parse(await readBody(request, limit));
    return isDynamicRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function readCreateInput(request: IncomingMessage): Promise<{
  name: string;
  description: string;
  avatarSeed: string;
  avatarHue: AgentSummary["avatarHue"];
  initialMessage?: string;
  provider?: AgentSummary["provider"];
  model?: AgentSummary["model"];
  reasoningEffort?: AgentSummary["reasoningEffort"];
} | null> {
  const record = await readJsonRecord(request);
  if (!record) return null;
  if (
    typeof record.name !== "string" ||
    record.name.trim().length === 0 ||
    record.name.length > INPUT_LIMITS.agentName ||
    typeof record.description !== "string" ||
    record.description.length > INPUT_LIMITS.agentDescription ||
    !isAvatarSeed(record.avatarSeed) ||
    !(record.avatarHue === null || isAvatarHue(record.avatarHue))
  ) {
    return null;
  }
  if (
    (record.initialMessage !== undefined &&
      (typeof record.initialMessage !== "string" ||
        record.initialMessage.trim().length === 0 ||
        record.initialMessage.length > INPUT_LIMITS.messageText)) ||
    (record.provider !== undefined && !isAgentProvider(record.provider)) ||
    (record.model !== undefined && !isAgentModel(record.model)) ||
    (record.reasoningEffort !== undefined && !isReasoningEffort(record.reasoningEffort))
  )
    return null;
  return {
    name: record.name,
    description: record.description,
    avatarSeed: record.avatarSeed,
    avatarHue: record.avatarHue,
    ...(typeof record.initialMessage === "string" ? { initialMessage: record.initialMessage } : {}),
    ...(isAgentProvider(record.provider) ? { provider: record.provider } : {}),
    ...(isAgentModel(record.model) ? { model: record.model } : {}),
    ...(isReasoningEffort(record.reasoningEffort) ? { reasoningEffort: record.reasoningEffort } : {}),
  };
}

async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request: IncomingMessage, token: Buffer): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}

function authorizedWebSocket(request: IncomingMessage, token: Buffer): boolean {
  const protocols = request.headers["sec-websocket-protocol"];
  if (typeof protocols !== "string") return false;
  const credential = protocols
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("bearer."));
  if (!credential) return false;
  const supplied = Buffer.from(credential.slice("bearer.".length));
  return supplied.length === token.length && timingSafeEqual(supplied, token);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function broadcastEvent(state: ServerState, event: AgentEvent): void {
  const message = `event: openbot\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of state.eventClients) {
    if (!response.write(message)) state.eventClients.delete(response);
  }
  const webSocketMessage = JSON.stringify(event);
  for (const client of state.webSocketClients) {
    if (client.readyState === WebSocket.OPEN) client.send(webSocketMessage);
  }
}

/** A live voice event goes to the phone as `voice-live`, beside the agent events, which keep their shape. */
function broadcastVoiceLive(state: ServerState, event: VoiceLiveEvent): void {
  if (event.type === "ended") state.liveSessions.delete(event.sessionId);
  const payload = JSON.stringify({ type: "voice-live", event });
  for (const response of state.eventClients) {
    if (!response.write(`event: openbot\ndata: ${payload}\n\n`)) state.eventClients.delete(response);
  }
  for (const client of state.webSocketClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/** A missing or damaged file gives the default: the voice stays off until the user turns it on. */
async function loadVoiceSettings(path: string): Promise<LiveVoiceSettings> {
  const off: LiveVoiceSettings = { codexLive: false, codexLiveVoice: null };
  const value = await readFile(path, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (!isDynamicRecord(value) || typeof value.codexLive !== "boolean") return off;
  return {
    codexLive: value.codexLive,
    codexLiveVoice: isCodexLiveVoice(value.codexLiveVoice) ? value.codexLiveVoice : null,
  };
}

async function saveVoiceSettings(path: string, settings: LiveVoiceSettings): Promise<void> {
  await writeFile(path, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function loadToken(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0) {
      throw new Error("The Termux API token file must be a private file owned by this user.");
    }
    return readValidToken(path);
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return readValidToken(path);
  }
  await chmod(path, 0o600);
  return Buffer.from(token);
}

async function readValidToken(path: string): Promise<Buffer> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("The Termux API token file has an invalid format.");
  return Buffer.from(value);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }
      server.removeListener("error", onError);
      server.listen(0, HOST, onListening);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("The Termux API did not bind a TCP port."));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.listen(DEFAULT_PORT, HOST, onListening);
  });
}

async function shutdown(state: ServerState, signal: NodeJS.Signals): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  logger.info(`Stopping the Termux API after ${signal}.`);
  for (const response of state.eventClients) response.end();
  state.eventClients.clear();
  for (const client of state.webSocketClients) client.close(1001, "Server shutting down.");
  state.webSocketClients.clear();
  state.webSocketServer.close();
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
  await Effect.runPromise(state.workflows.close());
  await Effect.runPromise(state.service.stop());
  state.agents.database.close();
}

void main().catch((error: unknown) => {
  logger.error("The Termux backend failed to start.", toLogValue(error));
  process.exitCode = 1;
});
