import type { IncomingMessage, ServerResponse } from "node:http";
import type { DuplicateAgentResult, TeamMemberSummary } from "@openbot/contracts/ipc";
import { isChannelRoute } from "@openbot/contracts/team-protocol/channels-v1";
import { supportsTeamSemanticTags } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { isFixedSourceText, sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { Effect } from "effect";
import { AgentDuplicationFailed } from "../backend/agent/duplication-gate";
import type { AgentService } from "../backend/agent-service";
import { StoredStateFailure } from "../backend/stored-state-effects";
import type { TeamApiSidebarLayout, TeamApiWorkflows } from "../main/team-api/dependencies";
import { HttpError } from "../main/team-api/http-error";
import type { TeamApiRequestContext } from "../main/team-api/request-context";
import { requestCapabilities, requestProtocol } from "../main/team-api/request-helpers";
import { routeAgentTasks } from "../main/team-api/route-agent-tasks";
import {
  routeAgentThreadBranches,
  routeAgentThreadFiles,
  routeAgentThreadReads,
  routeAgentThreads,
} from "../main/team-api/route-agent-threads";
import { routeAgents } from "../main/team-api/route-agents";
import { routeChannels } from "../main/team-api/route-channels";
import { routeWorkflows } from "../main/team-api/route-workflows";

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

/** Answers one authenticated `/v1/agents...` or `/v1/channels...` request with the host's own routes. */
export async function handleTeamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  agents: AgentService,
  workflows: TeamApiWorkflows,
): Promise<void> {
  const method = request.method ?? "GET";
  // The phone names its protocol and capabilities in headers, as a remote server's client does.
  const protocol = requestProtocol(request);
  const capabilities = requestCapabilities(request);
  const json = (status: number, value: object | null): "handled" => {
    // The body is encoded before the head is written, so a value the protocol cannot represent is a 500.
    const options = { preserveSemanticTags: supportsTeamSemanticTags(capabilities) };
    const sideRoute = teamSideRouteCodec(url.pathname);
    writeBody(
      response,
      status,
      sideRoute
        ? JSON.stringify(sideRoute.response(url.pathname, status, value))
        : teamHttpCodec(protocol).encodeResponse(method, url.pathname, status, value, options),
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
    const outcome = await route(context, agents, workflows);
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

const NO_HIDDEN_AGENTS: ReadonlySet<string> = new Set();

/** The route modules of the desktop router that the Termux services can answer, in its order. */
async function route(
  context: TeamApiRequestContext,
  agents: AgentService,
  workflows: TeamApiWorkflows,
): Promise<"handled" | "unmatched"> {
  if (isChannelRoute(context.url.pathname)) return routeChannels(context, agents.channels, agents);
  for (const module of [
    () => routeAgentTasks(context, agents, NO_HIDDEN_AGENTS),
    () => routeAgentThreads(context, agents, NO_HIDDEN_AGENTS),
    () => routeAgentThreadReads(context, agents, NO_HIDDEN_AGENTS),
    () => routeAgentThreadFiles(context, agents, NO_HIDDEN_AGENTS),
    () => routeAgentThreadBranches(context, agents, NO_HIDDEN_AGENTS),
    () => routeWorkflows(context, workflows, agents, NO_HIDDEN_AGENTS),
  ]) {
    if ((await module()) === "handled") return "handled";
  }
  return routeAgents(context, { agents: agents, sidebarLayout, duplicateAgent });
}
