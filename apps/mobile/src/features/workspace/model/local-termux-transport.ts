import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { RemoteFileUpload } from "@openbot/team-client/remote-peer";
import type { LocalTermuxServerConfig } from "./local-termux-server";
import { currentText } from "@/shared/lib/text";
import { normalizeLoopbackUrl } from "./local-termux-server";
import type { RemoteTeamTransportRef } from "../components/remote-team-transport";

export class LocalTermuxTransport implements RemoteTeamTransportRef {
  readonly #config: LocalTermuxServerConfig;
  #connected = false;

  constructor(config: LocalTermuxServerConfig) {
    this.#config = { ...config, url: normalizeLoopbackUrl(config.url) };
  }

  async connect(): Promise<void> {
    const t = currentText().t;
    const response = await this.#fetch("/health", false);
    if (!response.ok) throw new Error(t("mobile.server.local.unavailable"));
    const health: unknown = await response.json();
    if (!isRecord(health) || health.status !== "ok" || health.backend !== "openbot-agent-service") {
      throw new Error(t("mobile.server.local.unhealthy"));
    }
    const agents = await this.#fetch("/api/agents");
    if (agents.status === 401) throw new Error(t("mobile.server.local.authFailed"));
    if (!agents.ok) throw new Error(t("mobile.server.local.requestFailed", { status: agents.status }));
    const payload: unknown = await agents.json();
    if (!isRecord(payload) || !Array.isArray(payload.agents)) throw new Error(t("mobile.server.local.invalidResponse"));
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
  ): Promise<T> {
    const t = currentText().t;
    if (!this.#connected) throw new Error(t("mobile.server.local.disconnected"));
    if (upload) throw new Error(t("mobile.server.local.attachmentsUnsupported"));
    const url = this.#mapRoute(method, path, body);
    const response = await this.#fetch(url.path, true, method, url.body);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (response.status === 501) throw new Error(t("mobile.server.local.unsupported"));
      throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
    }
    return decode(url.unwrap === "agents" ? getField(payload, "agents") : url.unwrap === "agent" ? getField(payload, "agent") : url.unwrap === "receipt" ? getField(payload, "receipt") : payload);
  }

  openBrowserView(): null {
    return null;
  }

  async #fetch(path: string, auth = true, method = "GET", body?: TeamProtocolV2Json): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    if (auth) headers.set("authorization", `Bearer ${this.#config.token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    return fetch(new URL(path, `${this.#config.url}/`), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  #mapRoute(
    method: string,
    path: string,
    body?: TeamProtocolV2Json,
  ): { path: string; body?: TeamProtocolV2Json; unwrap?: "agents" | "agent" | "receipt" } {
    if (method === "GET" && path === TEAM_API_ROUTES.agents.all) return { path: "/api/agents", unwrap: "agents" };
    if (method === "POST" && path === TEAM_API_ROUTES.agents.all) return { path: "/api/agents", body, unwrap: "agent" };
    const [route, query] = path.split("?", 2);
    const conversation = /^\/v1\/agents\/([^/]+)\/conversation-page$/u.exec(route ?? "");
    if (method === "GET" && conversation)
      return { path: `/api/agents/${encodeURIComponent(conversation[1] ?? "")}/conversation-page${query ? `?${query}` : ""}` };
    const messages = /^\/v1\/agents\/([^/]+)\/messages$/u.exec(path);
    if (method === "POST" && messages) return { path: `/api/agents/${encodeURIComponent(messages[1] ?? "")}/messages`, body, unwrap: "receipt" };
    if (method === "GET" && route === TEAM_API_ROUTES.agents.conversationReads) return { path: "/api/reads" };
    throw new Error(currentText().t("mobile.server.local.unsupported"));
  }
}

function getField(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) throw new Error(currentText().t("mobile.server.local.invalidResponse"));
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
