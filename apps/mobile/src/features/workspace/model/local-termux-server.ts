import {
  CHANNEL_CHATS_CAPABILITY,
  CHANNEL_DELETE_CAPABILITY,
  CHANNEL_TASK_CANCEL_CAPABILITY,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { AGENT_TASKS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { AGENT_THREAD_BRANCHES_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-branches-v1";
import { AGENT_THREAD_FILES_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-files-v1";
import { AGENT_THREAD_READS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-reads-v1";
import { AGENT_THREADS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-threads-v1";
import { TEAM_AGENT_CREATE_MODEL_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { WORKFLOWS_CAPABILITY } from "@openbot/contracts/team-protocol/workflows-v1";
import * as SecureStore from "expo-secure-store";
import { currentText } from "@/shared/lib/text";

export interface LocalTermuxServerConfig {
  id: string;
  name: string;
  url: string;
  token: string;
}

/** What the phone asks the Termux server to use, in the headers of each agent request. */
export const LOCAL_TERMUX_CAPABILITIES: readonly string[] = [
  TEAM_AGENT_CREATE_MODEL_CAPABILITY,
  CHANNEL_CHATS_CAPABILITY,
  CHANNEL_DELETE_CAPABILITY,
  CHANNEL_TASK_CANCEL_CAPABILITY,
  AGENT_TASKS_CAPABILITY,
  AGENT_THREADS_CAPABILITY,
  AGENT_THREAD_READS_CAPABILITY,
  AGENT_THREAD_FILES_CAPABILITY,
  AGENT_THREAD_BRANCHES_CAPABILITY,
  WORKFLOWS_CAPABILITY,
];

const STORE_KEY = "openbot.mobile.local-termux-servers.v1";
const TOKEN_PREFIX = "openbot.mobile.local-termux-token.";

const listeners = new Set<(hasServers: boolean) => void>();

/** Calls `listener` after a local server is saved or deleted. Returns the function that stops it. */
export function subscribeLocalTermuxServers(listener: (hasServers: boolean) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function notifyLocalTermuxServers(hasServers: boolean): void {
  for (const listener of listeners) listener(hasServers);
}

export function normalizeLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(currentText().t("mobile.server.local.invalidUrl"));
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(currentText().t("mobile.server.local.invalidUrl"));
  }
  return parsed.origin;
}

interface SavedLocalServer {
  id: string;
  name: string;
  url: string;
}

function decodeSavedServers(value: unknown): SavedLocalServer[] {
  if (!Array.isArray(value)) throw new Error(currentText().t("mobile.server.local.savedSettingsInvalid"));
  return value.map((item) => {
    if (!isDynamicRecord(item) || !isString(item.id) || !isString(item.name) || !isString(item.url)) {
      throw new Error(currentText().t("mobile.server.local.savedSettingsInvalid"));
    }
    return { id: item.id, name: item.name, url: item.url };
  });
}

async function readSavedServers(): Promise<SavedLocalServer[]> {
  const saved = await SecureStore.getItemAsync(STORE_KEY);
  return saved ? decodeSavedServers(JSON.parse(saved)) : [];
}

/** The name that earlier builds filled in for a new local server. It shows as the generic name instead. */
const LEGACY_DEFAULT_NAME = "Samsung Local";

export async function readLocalTermuxServers(): Promise<LocalTermuxServerConfig[]> {
  return Promise.all(
    (await readSavedServers()).map(async (item) => {
      const token = await SecureStore.getItemAsync(`${TOKEN_PREFIX}${item.id}`);
      if (!token) throw new Error(currentText().t("mobile.server.local.savedTokenMissing"));
      const name = item.name === LEGACY_DEFAULT_NAME ? currentText().t("mobile.server.local.localMode") : item.name;
      return { id: item.id, name, url: normalizeLoopbackUrl(item.url), token };
    }),
  );
}

export async function saveLocalTermuxServer(config: LocalTermuxServerConfig): Promise<void> {
  const records = await readSavedServers();
  await SecureStore.setItemAsync(`${TOKEN_PREFIX}${config.id}`, config.token);
  await SecureStore.setItemAsync(
    STORE_KEY,
    JSON.stringify([
      ...records.filter((server) => server.id !== config.id),
      { id: config.id, name: config.name, url: normalizeLoopbackUrl(config.url) },
    ]),
  );
  notifyLocalTermuxServers(true);
}

export async function deleteLocalTermuxServer(id: string): Promise<void> {
  const remaining = (await readSavedServers()).filter((server) => server.id !== id);
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(remaining));
  await SecureStore.deleteItemAsync(`${TOKEN_PREFIX}${id}`);
  notifyLocalTermuxServers(remaining.length > 0);
}
