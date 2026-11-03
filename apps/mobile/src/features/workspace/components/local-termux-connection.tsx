import { useEffect } from "react";
import { isAgentEvent, type AgentEvent } from "@openbot/contracts/ipc";
import type { RemoteTeamTransportRef } from "./remote-team-transport";
import type { LocalTermuxServerConfig } from "../model/local-termux-server";
import { LocalTermuxTransport } from "../model/local-termux-transport";
import type { ServerConnectionHandle, ServerLoadContext } from "./server-connection";
import { currentText } from "@/shared/lib/text";

export function LocalTermuxConnection({
  config,
  active,
  register,
  load,
  onStatus,
  onTeamEvent,
}: {
  config: LocalTermuxServerConfig;
  active: boolean;
  register(id: string, handle: ServerConnectionHandle | null): void;
  load(id: string, publicKey: string, client: RemoteTeamTransportRef, context: ServerLoadContext): Promise<void>;
  onStatus(id: string, state: "connecting" | "online" | "offline" | "error", message: string | null): void;
  onTeamEvent(id: string, event: AgentEvent): void;
}) {
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let generation = 0;
    const client = new LocalTermuxTransport(config);
    let eventSocket: WebSocket | null = null;
    let eventRetryMs = 1_000;
    let connectPending = false;
    const connect = async () => {
      if (disposed || connectPending) return;
      connectPending = true;
      const attempt = ++generation;
      const context = { stage: "connection" as const, isCurrent: () => !disposed && attempt === generation };
      onStatus(config.id, "connecting", null);
      try {
        await client.connect(config.id, "");
        if (context.isCurrent()) await load(config.id, "", client, context);
        if (context.isCurrent()) {
          onStatus(config.id, "online", null);
        }
      } catch (error) {
        if (context.isCurrent()) {
          const message = error instanceof Error ? error.message : currentText().t("mobile.server.local.unavailable");
          onStatus(config.id, /authentication failed/iu.test(message) ? "error" : "offline", message);
        }
      } finally {
        connectPending = false;
      }
    };
    register(config.id, { client, refresh: () => void connect(), quietStart: () => undefined });
    void connect();
    void (async () => {
      while (!disposed) {
        const url = new URL("/api/events", `${config.url}/`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(url.toString(), ["openbot-local", `bearer.${config.token}`]);
          eventSocket = socket;
          let closed = false;
          const finish = () => {
            if (closed) return;
            closed = true;
            if (eventSocket === socket) eventSocket = null;
            resolve();
          };
          socket.onopen = () => void connect();
          socket.onmessage = (message) => {
            try {
              const event: unknown = JSON.parse(String(message.data));
              if (isAgentEvent(event)) {
                eventRetryMs = 1_000;
                onTeamEvent(config.id, event);
              }
            } catch {
              // Ignore an invalid event. The next valid backend event can still be used.
            }
          };
          socket.onerror = () => socket.close();
          socket.onclose = finish;
        });
        if (!disposed) {
          await new Promise((resolve) => setTimeout(resolve, eventRetryMs));
          eventRetryMs = Math.min(eventRetryMs * 2, 30_000);
        }
      }
    })();
    return () => {
      disposed = true;
      generation += 1;
      eventSocket?.close();
      eventSocket = null;
      void client.disconnect();
      register(config.id, null);
      onStatus(config.id, "offline", null);
    };
  }, [config, active, register, load, onStatus, onTeamEvent]);
  return null;
}
