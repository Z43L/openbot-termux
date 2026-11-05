import { latestTurnAnswer } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { AgentStore } from "../backend/agent-store";
import type { MailboxStore } from "../backend/mailbox-store";
import { WorkflowGitHubStore } from "../backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../backend/workflows/workflow-run-store";
import { WorkflowStore } from "../backend/workflows/workflow-store";
import { workflowScheduleDueAt } from "../backend/workflows/workflow-triggers";
import { createWorkflows } from "../backend/workflows/workflows";
import { HostEventsFailure } from "../main/host-events-api";

/**
 * The workflows of the Termux backend: the same service and stores as the desktop app. The graph
 * editor and the manual runs work. Schedule, GitHub and webhook triggers are not started here.
 */
export const createTermuxWorkflows = Effect.fn("createTermuxWorkflows")(function* (
  store: AgentStore,
  mailbox: MailboxStore,
  service: AgentService,
) {
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const delivery = (deliveryId: string) => {
    const found = mailbox.getDelivery(deliveryId)?.delivery;
    return found ? { status: found.status, turnId: found.turnId, error: found.error } : null;
  };
  const workflows = yield* createWorkflows({
    store: new WorkflowStore({ database: store.database, nextDueAt: workflowScheduleDueAt(timezone) }),
    runs: new WorkflowRunStore({ database: store.database }),
    github: new WorkflowGitHubStore({ database: store.database }),
    githubApp: () => null,
    delivery,
    turnAnswer: (agentId, turnId) => {
      const threadId = store.list().find((agent) => agent.id === agentId)?.threadId;
      if (!threadId) return null;
      return latestTurnAnswer(store.database.readTurnAssistantMessages(agentId, turnId), turnId)?.text ?? null;
    },
    sendHandoff: (input) => service.enqueueRoutineHandoff(input),
    stopDelivery: (agentId, deliveryId) => {
      const found = mailbox.getDelivery(deliveryId)?.delivery;
      if (!found) return Effect.void;
      return found.status === "running" && found.turnId
        ? service.interrupt(agentId, found.turnId)
        : service.cancelQueuedMessage(agentId, deliveryId);
    },
    generateText: (request) =>
      service.generateWorkflowText(request).pipe(
        Effect.mapError((failure) => ({
          message: failure.cause instanceof Error ? failure.cause.message : sourceText("error.workflow.modelFailed"),
        })),
      ),
    notify: () => undefined,
    connectionOn: (connectionId) => service.messaging.store.connection(connectionId)?.enabled === true,
    post: (connectionId, placeId, markdown) => service.messaging.deliver(connectionId, placeId, markdown),
    discordSend: (connectionId, send) => service.messaging.discordSend(connectionId, send),
    changed: (workflowId) => service.notifyWorkflowsChanged(workflowId),
    rearm: () => service.armRoutines(),
    timezone,
    runEnded: (end) => service.notifyWorkflowRunEnded(end),
  });
  // A webhook trigger needs the relay of the desktop host, which Termux does not have.
  return {
    ...workflows,
    rotateWorkflowSecret: () =>
      Effect.fail(new HostEventsFailure({ cause: new Error(sourceText("error.team.routeNotFound")) })),
  };
});

export type TermuxWorkflows = Effect.Success<ReturnType<typeof createTermuxWorkflows>>;
