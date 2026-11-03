import * as SecureStore from "expo-secure-store";
import { currentText } from "@/shared/lib/text";

export interface LocalTermuxServerConfig {
  id: string;
  name: string;
  url: string;
  token: string;
}

const STORE_KEY = "openbot.mobile.local-termux-servers.v1";
const TOKEN_PREFIX = "openbot.mobile.local-termux-token.";

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

export async function readLocalTermuxServers(): Promise<LocalTermuxServerConfig[]> {
  const saved = await SecureStore.getItemAsync(STORE_KEY);
  if (!saved) return [];
  const value: unknown = JSON.parse(saved);
  if (!Array.isArray(value)) throw new Error(currentText().t("mobile.server.local.savedSettingsInvalid"));
  return Promise.all(value.map(async (item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.url !== "string"
    ) {
      throw new Error(currentText().t("mobile.server.local.savedSettingsInvalid"));
    }
    const token = await SecureStore.getItemAsync(`${TOKEN_PREFIX}${item.id}`);
    if (!token) throw new Error(currentText().t("mobile.server.local.savedTokenMissing"));
    return { id: item.id, name: item.name, url: normalizeLoopbackUrl(item.url), token };
  }));
}

export async function saveLocalTermuxServer(config: LocalTermuxServerConfig): Promise<void> {
  const saved = await SecureStore.getItemAsync(STORE_KEY);
  const records: Array<{ id: string; name: string; url: string }> = saved
    ? (JSON.parse(saved) as Array<{ id: string; name: string; url: string }>)
    : [];
  await SecureStore.setItemAsync(`${TOKEN_PREFIX}${config.id}`, config.token);
  await SecureStore.setItemAsync(
    STORE_KEY,
    JSON.stringify([
      ...records.filter((server) => server.id !== config.id),
      { id: config.id, name: config.name, url: normalizeLoopbackUrl(config.url) },
    ]),
  );
}

export async function deleteLocalTermuxServer(id: string): Promise<void> {
  const saved = await SecureStore.getItemAsync(STORE_KEY);
  const records: Array<{ id: string; name: string; url: string }> = saved
    ? (JSON.parse(saved) as Array<{ id: string; name: string; url: string }>)
    : [];
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(records.filter((server) => server.id !== id)));
  await SecureStore.deleteItemAsync(`${TOKEN_PREFIX}${id}`);
}
