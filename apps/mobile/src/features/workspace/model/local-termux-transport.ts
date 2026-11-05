import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { type TeamHttpCodec, teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { TEAM_CAPABILITIES_HEADER, TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol/v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";
import type { RemoteFileUpload } from "@openbot/team-client/remote-peer";
import { currentText } from "@/shared/lib/text";
import type { RemoteTeamTransportRef } from "../components/remote-team-transport";
import { LOCAL_TERMUX_CAPABILITIES, type LocalTermuxServerConfig, normalizeLoopbackUrl } from "./local-termux-server";

export class LocalTermuxTransport implements RemoteTeamTransportRef {
  readonly #config: LocalTermuxServerConfig;
  #connected = false;

  constructor(config: LocalTermuxServerConfig) {
    this.#config = { ...config, url: normalizeLoopbackUrl(config.url) };
  }

  async connect(_hostId?: string, _hostPublicKey?: string): Promise<void> {
    const t = currentText().t;
    const response = await this.#fetch("/health", false);
    if (!response.ok) throw new Error(t("mobile.server.termux.unavailable"));
    if (!isHealthy(await response.json())) throw new Error(t("mobile.server.termux.unhealthy"));
    const agents = await this.#fetch("/api/agents");
    if (agents.status === 401) throw new Error(t("mobile.server.termux.authFailed"));
    if (!agents.ok) throw new Error(t("mobile.server.termux.requestFailed", { status: agents.status }));
    if (!hasAgentList(await agents.json())) throw new Error(t("mobile.server.termux.invalidResponse"));
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    this.#connected = false;
  }

  async request<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
    // The local server sends the bytes at once, so the progress of an upload is not reported.
    _onUploadProgress?: (fraction: number) => void,
  ): Promise<T> {
    const t = currentText().t;
    if (!this.#connected) throw new Error(t("mobile.server.termux.disconnected"));
    if (!isServedRoute(path)) throw new Error(t("mobile.server.termux.unsupported"));
    // The server sends a file as it is. The app reads it as `{ name, mimeType, base64 }`, as the remote
    // client builds it, and it sends a file from base64 the same way.
    if (upload) return decode(await this.#upload(method, path, upload));
    if (method === "GET" && isFileDownload(path)) return decode(await this.#download(path));
    // The Termux server answers the agent and channel routes of the Team API itself, in protocol 9 like a
    // remote server. Channel routes have their own codec, which the remote client also uses.
    const codec = teamHttpCodec(TEAM_PROTOCOL_V9);
    const sideRoute = teamSideRouteCodec(path);
    const options = { agentCreateModel: LOCAL_TERMUX_CAPABILITIES.includes(TEAM_AGENT_CREATE_MODEL_CAPABILITY) };
    const encoded =
      body === undefined
        ? undefined
        : sideRoute
          ? JSON.stringify(sideRoute.request(path, body))
          : codec.encodeRequest(method, path, body, options);
    const response = await this.#fetch(path, true, method, encoded);
    const payload = await response.json().catch(() => null);
    this.#requireOk(response);
    return decode(
      sideRoute
        ? sideRoute.response(path, response.status, payload, {
            historyExtent: true,
            channelAttention: true,
            agentTaskUiBlocks: true,
          })
        : codec.decodeResponse(method, path, response.status, payload),
    );
  }

  openBrowserView(): null {
    return null;
  }

  /** Starts Codex live voice. `sdp` is the WebRTC offer of the phone; the answer comes back with the session. */
  async startLiveVoice(agentId: string, sdp: string): Promise<{ sessionId: string; sdp: string }> {
    const response = await this.#fetch("/api/voice/live/start", true, "POST", { agentId, sdp });
    const payload = await response.json().catch(() => null);
    this.#requireOk(response);
    if (!isDynamicRecord(payload) || !isString(payload.sessionId) || !isString(payload.sdp)) {
      throw new Error(currentText().t("mobile.server.termux.invalidResponse"));
    }
    return { sessionId: payload.sessionId, sdp: payload.sdp };
  }

  async stopLiveVoice(sessionId: string): Promise<void> {
    const response = await this.#fetch("/api/voice/live/stop", true, "POST", { sessionId });
    this.#requireOk(response);
  }

  /** The Codex live voice opt-in and voice of the local server, as the server stores them. */
  async readLiveVoiceSettings(): Promise<LocalLiveVoiceSettings> {
    const response = await this.#fetch("/api/voice/live");
    const payload = await response.json().catch(() => null);
    this.#requireOk(response);
    return decodeLiveVoiceSettings(payload);
  }

  async saveLiveVoiceSettings(settings: LocalLiveVoiceSettings): Promise<LocalLiveVoiceSettings> {
    const response = await this.#fetch("/api/voice/live", true, "PUT", settings);
    const payload = await response.json().catch(() => null);
    this.#requireOk(response);
    return decodeLiveVoiceSettings(payload);
  }

  #requireOk(response: Response): void {
    if (response.ok) return;
    const t = currentText().t;
    if (response.status === 401) throw new Error(t("mobile.server.termux.authFailed"));
    if (response.status === 501) throw new Error(t("mobile.server.termux.unsupported"));
    if (response.status === 409) throw new Error(t("mobile.server.termux.liveVoiceOff"));
    throw new Error(t("mobile.server.termux.requestFailed", { status: response.status }));
  }

  async #download(path: string): Promise<{ name: string; mimeType: string; base64: string }> {
    const response = await this.#fetch(path);
    this.#requireOk(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      name: fileNameOf(response.headers.get("content-disposition")),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      base64: bytesToBase64(bytes),
    };
  }

  async #upload(
    method: string,
    path: string,
    upload: RemoteFileUpload,
  ): Promise<ReturnType<TeamHttpCodec["decodeResponse"]>> {
    const response = await this.#fetch(path, true, method, undefined, base64ToBytes(upload.base64));
    const payload = await response.json().catch(() => null);
    this.#requireOk(response);
    return teamHttpCodec(TEAM_PROTOCOL_V9).decodeResponse(method, path, response.status, payload);
  }

  async #fetch(
    path: string,
    auth = true,
    method = "GET",
    body?: string | TeamProtocolV2Json,
    bytes?: Uint8Array<ArrayBuffer>,
  ): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    if (auth) headers.set("authorization", `Bearer ${this.#config.token}`);
    if (path.startsWith("/v1/")) {
      headers.set(TEAM_PROTOCOL_VERSION_HEADER, String(TEAM_PROTOCOL_V9));
      headers.set(TEAM_CAPABILITIES_HEADER, LOCAL_TERMUX_CAPABILITIES.join(","));
    }
    if (bytes !== undefined) headers.set("content-type", "application/octet-stream");
    else if (body !== undefined) headers.set("content-type", "application/json");
    return fetch(new URL(path, `${this.#config.url}/`), {
      method,
      headers,
      ...(bytes !== undefined
        ? { body: bytes }
        : body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }
}

/** The routes that answer with a file as it is: a message attachment, a shared file and a workspace file. */
function isFileDownload(path: string): boolean {
  const base = path.split("?", 1)[0] ?? path;
  return /^\/v1\/attachments\/[^/]+$/u.test(base) || base === "/v1/shared-files" || base === "/v1/workspace-files";
}

/** The file name of a `Content-Disposition: attachment; filename*=UTF-8''...` header. */
function fileNameOf(disposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition ?? "")?.[1];
  if (!encoded) return "file";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** The server answers the Team API routes that its services can serve, and refuses the rest with a 404. */
function isServedRoute(path: string): boolean {
  return path.startsWith("/v1/");
}

export type LocalLiveVoiceSettings = {
  codexLive: boolean;
  codexLiveVoice: string | null;
};

function decodeLiveVoiceSettings(value: unknown): LocalLiveVoiceSettings {
  if (!isDynamicRecord(value) || typeof value.codexLive !== "boolean") {
    throw new Error(currentText().t("mobile.server.termux.invalidResponse"));
  }
  return { codexLive: value.codexLive, codexLiveVoice: isString(value.codexLiveVoice) ? value.codexLiveVoice : null };
}

function isHealthy(value: unknown): boolean {
  return isDynamicRecord(value) && value.status === "ok" && value.backend === "openbot-agent-service";
}

function hasAgentList(value: unknown): boolean {
  return isDynamicRecord(value) && Array.isArray(value.agents);
}
