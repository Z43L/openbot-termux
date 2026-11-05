import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const reportPath = join(root, ".openbot-build", "termux-backend-e2e.json");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "openbot-termux-e2e-"));
const dataDirectory = join(temporaryDirectory, "data");
const workspaceDirectory = join(temporaryDirectory, "OpenBot-Termux");
const entry = join(root, "src", "termux", "main.ts");
const results: Array<{ name: string; status: "passed" | "failed"; detail: string }> = [];
let child: ChildProcess | null = null;
let backendOutput = "";

/** The JSON body of a response as a record. A body that is not a record reads as empty. */
async function readRecord(response: Response): Promise<DynamicRecord> {
  const value = await response.json().catch(() => null);
  return isDynamicRecord(value) ? value : {};
}

function stringField(record: DynamicRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function recordField(record: DynamicRecord, key: string): DynamicRecord {
  const value = record[key];
  return isDynamicRecord(value) ? value : {};
}

function arrayField(record: DynamicRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function assert(condition: unknown, name: string, detail: string): asserts condition {
  if (!condition) throw new Error(`${name}: ${detail}`);
  results.push({ name, status: "passed", detail });
}

async function start(): Promise<{ port: number; token: string }> {
  child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      LD_LIBRARY_PATH: `${process.env.PREFIX ?? "/data/data/com.termux/files/usr"}/lib${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ""}`,
      OPENBOT_TERMUX_DATA_DIR: dataDirectory,
      OPENBOT_TERMUX_HOME: workspaceDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    backendOutput += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    backendOutput += chunk.toString("utf8");
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const onData = (chunk: Buffer) => {
      const match = /OpenBot Termux API: http:\/\/127\.0\.0\.1:(\d+)/u.exec(chunk.toString("utf8"));
      if (match?.[1]) {
        child?.stdout?.removeListener("data", onData);
        resolvePort(Number(match[1]));
      }
    };
    child?.stdout?.on("data", onData);
    child?.once("error", reject);
    child?.once("exit", (code) => reject(new Error(`Backend exited with ${code}: ${output}`)));
  });
  return { port, token: (await readFile(join(dataDirectory, "server-token"), "utf8")).trim() };
}

async function stop(): Promise<void> {
  const processToStop = child;
  if (!processToStop || processToStop.exitCode !== null) return;
  processToStop.kill("SIGTERM");
  await new Promise<void>((resolveExit, reject) => {
    processToStop.once("exit", (code, signal) => {
      if (signal === "SIGTERM" || code === 0) resolveExit();
      else reject(new Error(`Backend stopped with code ${code} and signal ${signal}.`));
    });
  });
  child = null;
}

async function waitForTurn(port: number, token: string, agentId: string): Promise<DynamicRecord> {
  return new Promise<DynamicRecord>((resolveTurn, rejectTurn) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, ["openbot-local", `bearer.${token}`]);
    const timeout = setTimeout(() => {
      socket.close();
      rejectTurn(new Error(`WebSocket closed before the agent turn completed. Backend output: ${backendOutput}`));
    }, 120_000);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectTurn(error);
    });
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (!isDynamicRecord(event)) return;
      if (event.type === "turn-completed" && event.agentId === agentId) {
        clearTimeout(timeout);
        socket.close();
        resolveTurn(event);
      }
    });
  });
}

try {
  const first = await start();
  const baseUrl = `http://127.0.0.1:${first.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await readRecord(healthResponse);
  assert(
    healthResponse.status === 200 && health.status === "ok" && recordField(health, "dependencies").sqlite === "ok",
    "health",
    "SQLite quick_check passed.",
  );

  const unauthorized = await fetch(`${baseUrl}/api/agents`);
  assert(unauthorized.status === 401, "authorization", "Agent data requires a bearer token.");
  const wrongToken = await fetch(`${baseUrl}/api/agents`, { headers: { authorization: "Bearer invalid" } });
  assert(wrongToken.status === 401, "wrong_token", "An invalid bearer token is rejected.");
  const remoteOrigin = await fetch(`${baseUrl}/api/agents`, {
    headers: { authorization: `Bearer ${first.token}`, origin: "http://192.0.2.44" },
  });
  assert(remoteOrigin.status === 403, "origin_policy", "A non-loopback web origin is rejected.");
  const remoteHost = await fetch(`${baseUrl}/health`, { headers: { host: `192.0.2.44:${first.port}` } });
  assert(remoteHost.status === 421, "host_policy", "A request with a public host header is rejected.");
  const unauthenticatedEvents = await fetch(`${baseUrl}/api/events`);
  assert(unauthenticatedEvents.status === 401, "event_authorization", "The event stream requires a bearer token.");
  const sseResponse = await fetch(`${baseUrl}/api/events`, { headers: { authorization: `Bearer ${first.token}` } });
  const sseReader = sseResponse.body?.getReader();
  const sseFirstChunk = sseReader ? await sseReader.read() : null;
  await sseReader?.cancel();
  assert(
    sseResponse.status === 200 && new TextDecoder().decode(sseFirstChunk?.value).includes("event: ready"),
    "sse_compatibility",
    "The authenticated SSE endpoint remains available.",
  );
  const rejectedSocket = await new Promise<number>((resolveStatus, rejectStatus) => {
    const socket = new WebSocket(`ws://127.0.0.1:${first.port}/api/events`, ["openbot-local", "bearer.invalid"]);
    socket.once("unexpected-response", (_request, response) => {
      resolveStatus(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("error", rejectStatus);
  });
  assert(rejectedSocket === 401, "websocket_authorization", "An invalid WebSocket bearer token is rejected.");

  const createdResponse = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Termux E2E", description: "", avatarSeed: "termux-e2e", avatarHue: null }),
  });
  const created = await readRecord(createdResponse);
  const createdAgent = recordField(created, "agent");
  const createdAgentId = stringField(createdAgent, "id");
  assert(
    createdResponse.status === 201 && stringField(createdAgent, "name") === "Termux E2E",
    "create_agent",
    "Original AgentStore created an agent.",
  );

  const completedTurn = waitForTurn(first.port, first.token, createdAgentId);
  const messageResponse = await fetch(`${baseUrl}/api/agents/${createdAgentId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "Reply with the single word TERMUX_OK." }),
  });
  assert(messageResponse.status === 202, "send_message", "AgentService accepted a message for the local Codex CLI.");
  const turn = await completedTurn;
  assert(
    turn.status === "completed",
    "provider_turn",
    `The real provider finished the turn with status ${turn.status}.`,
  );

  const conversationResponse = await fetch(`${baseUrl}/api/agents/${createdAgentId}/conversation`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  const conversationBody = await readRecord(conversationResponse);
  const assistantMessage = arrayField(recordField(conversationBody, "conversation"), "messages")
    .filter(isDynamicRecord)
    .find((message) => message.author === "assistant" && message.status === "completed");
  assert(
    stringField(assistantMessage ?? {}, "text").includes("TERMUX_OK"),
    "provider_response",
    "Conversation contains the real Codex response.",
  );

  const pageResponse = await fetch(`${baseUrl}/api/agents/${createdAgentId}/conversation-page?limit=50`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  const page = await readRecord(pageResponse);
  assert(
    pageResponse.status === 200 &&
      stringField(page, "agentId") === createdAgentId &&
      arrayField(page, "messages").length > 0,
    "mobile_conversation_page",
    "The Team API conversation page route returns saved messages.",
  );
  const readsResponse = await fetch(`${baseUrl}/api/reads`, { headers: { authorization: `Bearer ${first.token}` } });
  assert(
    readsResponse.status === 200,
    "mobile_conversation_reads",
    "The authenticated local read-state route responds.",
  );

  const listedResponse = await fetch(`${baseUrl}/api/agents`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  const listed = await readRecord(listedResponse);
  assert(
    arrayField(listed, "agents").some((agent) => isDynamicRecord(agent) && agent.id === createdAgentId),
    "list_agent",
    "Original AgentStore returned the created agent.",
  );
  const voiceSettingsResponse = await fetch(`${baseUrl}/api/voice/live`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  const voiceSettings = await readRecord(voiceSettingsResponse);
  assert(
    voiceSettingsResponse.status === 200 && voiceSettings.codexLive === false,
    "live_voice_default",
    "Codex live voice is off until the user turns it on.",
  );
  const voiceStartResponse = await fetch(`${baseUrl}/api/voice/live/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId: createdAgentId, sdp: "v=0" }),
  });
  assert(
    voiceStartResponse.status === 409,
    "live_voice_opt_in",
    "A live voice session does not start while the opt-in is off.",
  );

  await stop();

  const second = await start();
  const recoveredResponse = await fetch(`http://127.0.0.1:${second.port}/api/agents`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  const recovered = await readRecord(recoveredResponse);
  assert(
    arrayField(recovered, "agents").some((agent) => isDynamicRecord(agent) && agent.id === createdAgentId),
    "restart_persistence",
    "Agent survived a backend restart.",
  );
  const recoveredConversationResponse = await fetch(
    `http://127.0.0.1:${second.port}/api/agents/${createdAgentId}/conversation`,
    {
      headers: { authorization: `Bearer ${second.token}` },
    },
  );
  const recoveredConversation = await readRecord(recoveredConversationResponse);
  assert(
    arrayField(recordField(recoveredConversation, "conversation"), "messages")
      .filter(isDynamicRecord)
      .some(
        (message) =>
          message.author === "assistant" &&
          message.status === "completed" &&
          stringField(message, "text").includes("TERMUX_OK"),
      ),
    "conversation_persistence",
    "The real provider response survived a backend restart.",
  );
  await stop();

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ results, createdAgentId: createdAgentId }, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`PASS: ${results.length} Termux backend checks. Report: ${reportPath}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : "unknown_failure";
  results.push({ name: "backend_e2e", status: "failed", detail });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ results }, null, 2)}\n`, { mode: 0o600 });
  throw error;
} finally {
  await stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
