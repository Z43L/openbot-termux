import type { IncomingMessage, ServerResponse } from "node:http";
import type { DuplicateAgentResult, TeamMemberSummary } from "@openbot/contracts/ipc";
import { supportsTeamSemanticTags } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { isFixedSourceText, sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { AgentDuplicationFailed } from "../backend/agent/duplication-gate";
import type { AgentService } from "../backend/agent-service";
import { StoredStateFailure } from "../backend/stored-state-effects";
import type { TeamApiSidebarLayout } from "../main/team-api/dependencies";
import { HttpError } from "../main/team-api/http-error";
import type { TeamApiRequestContext } from "../main/team-api/request-context";
import { requestCapabilities, requestProtocol } from "../main/team-api/request-helpers";
import { routeAgents } from "../main/team-api/route-agents";

const logger = createOpenBotLogger("termux-team-api");

const OWNER: TeamMemberSummary = {
  id: "termux-local-owner",
  username: "owner",
  email: null,
  name: null,
  role: "owner",
  createdAt: new Date(0).toISOString(),
  disabled: false,
};

const SIDEBAR_UNAVAILABLE = "error.team.sidebarLayoutUnavailable";

/** The Termux backend has no sections: the layout stays empty and every change is refused. */
const sidebarLayout: Pick<TeamApiSidebarLayout, "getSnapshot" | "mutate" | "removeAgent" | "withProfileAssignment"> = {
  getSnapshot: () => ({
    revision: 0,
    sections: [],
    order: ["people", "unassigned"],
    agentAssignments: {},
    agentOrder: [],
  }),
  mutate: () => Effect.fail(new StoredStateFailure({ cause: new HttpError(503, sourceText(SIDEBAR_UNAVAILABLE)) })),
  withProfileAssignment: () =>
    Effect.fail(new StoredStateFailure({ cause: new Error(sourceText(SIDEBAR_UNAVAILABLE)) })),
  removeAgent: () =>
    Effect.succeed({
      revision: 0,
      sections: [],
      order: ["people", "unassigned"],
      agentAssignments: {},
      agentOrder: [],
    }),
};

function duplicateAgent(): Effect.Effect<DuplicateAgentResult, AgentDuplicationFailed> {
  return Effect.fail(new AgentDuplicationFailed({ cause: new Error("The Termux backend cannot duplicate an agent.") }));
}

function writeBody(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${body}\n`);
}

/** Answers one authenticated `/v1/agents...` request with the host's own agent routes. */
export async function handleTeamAgentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  agents: AgentService,
): Promise<void> {
  const method = request.method ?? "GET";
  // The phone names its protocol and capabilities in headers, as a remote server's client does.
  const protocol = requestProtocol(request);
  const capabilities = requestCapabilities(request);
  const json = (status: number, value: object | null): "handled" => {
    // The body is encoded before the head is written, so a value the protocol cannot represent is a 500.
    writeBody(
      response,
      status,
      teamHttpCodec(protocol).encodeResponse(method, url.pathname, status, value, {
        preserveSemanticTags: supportsTeamSemanticTags(capabilities),
      }),
    );
    return "handled";
  };
  const context: TeamApiRequestContext = {
    request,
    response,
    method,
    url,
    protocol,
    capabilities,
    member: OWNER,
    token: "",
    sessionId: "termux-local",
    sessionExpiresAt: new Date(8_640_000_000_000_000).toISOString(),
    agentLevel: () => "manage",
    json,
    empty: (status) => {
      response.writeHead(status);
      response.end();
      return "handled";
    },
  };
  try {
    const outcome = await routeAgents(context, { agents, sidebarLayout, duplicateAgent });
    if (outcome === "unmatched")
      writeBody(response, 404, JSON.stringify({ error: sourceText("error.team.routeNotFound") }));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof HttpError || (error instanceof Error && isFixedSourceText(error.message))
        ? error.message
        : sourceText("error.team.requestFailed");
    if (!(error instanceof HttpError)) logger.error("A Termux Team API request failed.", toLogValue(error));
    if (response.headersSent) response.destroy();
    else writeBody(response, status, JSON.stringify({ error: message }));
  }
}
