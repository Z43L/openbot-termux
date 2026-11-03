import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { isChannelRoute } from "@openbot/contracts/team-protocol/channels-v1";
import { TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
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

  async connect(): Promise<void> {
    const t = currentText().t;
    const response = await this.#fetch("/health", false);
    if (!response.ok) throw new Error(t("mobile.server.local.unavailable"));
    if (!isHealthy(await response.json())) throw new Error(t("mobile.server.local.unhealthy"));
    const agents = await this.#fetch("/api/agents");
    if (agents.status === 401) throw new Error(t("mobile.server.local.authFailed"));
    if (!agents.ok) throw new Error(t("mobile.server.local.requestFailed", { status: agents.status }));
    if (!hasAgentList(await agents.json())) throw new Error(t("mobile.server.local.invalidResponse"));
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
    if (!isServedRoute(path)) throw new Error(t("mobile.server.local.unsupported"));
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
    if (!response.ok) {
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (response.status === 501) throw new Error(t("mobile.server.local.unsupported"));
      throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
    }
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

  async #fetch(path: string, auth = true, method = "GET", body?: string | TeamProtocolV2Json): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    if (auth) headers.set("authorization", `Bearer ${this.#config.token}`);
    if (path.startsWith("/v1/")) {
      headers.set(TEAM_PROTOCOL_VERSION_HEADER, String(TEAM_PROTOCOL_V9));
      headers.set(TEAM_CAPABILITIES_HEADER, LOCAL_TERMUX_CAPABILITIES.join(","));
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    return fetch(new URL(path, `${this.#config.url}/`), {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }
}

function isServedRoute(path: string): boolean {
  const base = path.split("?", 1)[0] ?? path;
  return (
    base === TEAM_API_ROUTES.agents.all || base.startsWith(`${TEAM_API_ROUTES.agents.all}/`) || isChannelRoute(path)
  );
}

function isHealthy(value: unknown): boolean {
  return isDynamicRecord(value) && value.status === "ok" && value.backend === "openbot-agent-service";
}

function hasAgentList(value: unknown): boolean {
  return isDynamicRecord(value) && Array.isArray(value.agents);
}
