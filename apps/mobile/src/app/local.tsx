import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type ConversationMessage, isConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { MobileTextKey } from "@openbot/i18n/mobile";
import * as Crypto from "expo-crypto";
import { router, Stack } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decodeConversationPage } from "@/features/workspace/model/conversation";
import {
  type LocalTermuxServerConfig,
  normalizeLoopbackUrl,
  readLocalTermuxServers,
  saveLocalTermuxServer,
} from "@/features/workspace/model/local-termux-server";
import { LocalTermuxTransport } from "@/features/workspace/model/local-termux-transport";
import { decodeAgentSummaries } from "@/features/workspace/model/workspace-records";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { useText } from "@/shared/lib/text";

interface LocalAgent {
  id: string;
  name: string;
}

const AUTHOR_KEYS = {
  user: "mobile.server.local.author.user",
  assistant: "mobile.server.local.author.assistant",
  agent: "mobile.server.local.author.agent",
  system: "mobile.server.local.author.system",
} as const satisfies Record<ConversationMessage["author"], MobileTextKey>;

export default function LocalTermuxScreen() {
  const { t } = useText();
  const insets = useSafeAreaInsets();
  const [servers, setServers] = useState<LocalTermuxServerConfig[]>([]);
  const [server, setServer] = useState<LocalTermuxServerConfig | null>(null);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([]);
  const [serverName, setServerName] = useState("Samsung Local");
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [agentName, setAgentName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const busyRef = useRef(false);

  const readAgents = useCallback(
    async (config: LocalTermuxServerConfig) => {
      const response = await fetch(`${config.url}/api/agents`, {
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      });
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (!response.ok) throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
      const value = await response.json();
      if (!isDynamicRecord(value) || !Array.isArray(value.agents))
        throw new Error(t("mobile.server.local.invalidResponse"));
      setAgents(decodeAgentSummaries(value.agents));
    },
    [t],
  );

  const readConversation = useCallback(
    async (config: LocalTermuxServerConfig, id: string) => {
      const response = await fetch(`${config.url}/api/agents/${encodeURIComponent(id)}/conversation-page?limit=100`, {
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      });
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (!response.ok) throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
      const page = decodeConversationPage(await response.json());
      setMessages(
        page.messages.filter(isConversationMessage).map(({ id: messageId, author, text }) => ({
          id: messageId,
          author: t(AUTHOR_KEYS[author]),
          text,
        })),
      );
      return page;
    },
    [t],
  );

  const connect = useCallback(
    async (config: LocalTermuxServerConfig) => {
      const transport = new LocalTermuxTransport(config);
      await transport.connect();
      await readAgents(config);
      setServer(config);
      setConnected(true);
      setError(null);
      await saveLocalTermuxServer(config);
      setServers(await readLocalTermuxServers());
      // The saved server opens the main app. The app guard reads the new server from the store.
      router.replace("/connected");
    },
    [readAgents],
  );

  useEffect(() => {
    let active = true;
    void readLocalTermuxServers()
      .then(async (saved) => {
        if (!active) return;
        setServers(saved);
        const first = saved[0];
        if (first) {
          setServerName(first.name);
          setServerUrl(first.url);
          await connect(first).catch((cause: unknown) => {
            if (active) {
              setServer(first);
              setError(cause instanceof Error ? cause.message : t("mobile.server.local.unavailable"));
            }
          });
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : t("mobile.server.local.savedSettingsInvalid"));
      });
    return () => {
      active = false;
    };
  }, [connect, t]);

  useEffect(() => {
    if (!server || !agentId) return;
    let active = true;
    const refresh = () =>
      void readConversation(server, agentId).catch((cause: unknown) => {
        if (active) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : t("mobile.server.local.unavailable"));
        }
      });
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [server, agentId, readConversation, t]);

  useEffect(() => {
    if (!server) return;
    let active = true;
    const refreshConnection = async () => {
      try {
        await new LocalTermuxTransport(server).connect();
        await readAgents(server);
        if (active) {
          setConnected(true);
          setError(null);
        }
      } catch (cause) {
        if (active) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : t("mobile.server.local.unavailable"));
        }
      }
    };
    void refreshConnection();
    const timer = setInterval(() => void refreshConnection(), 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [server, readAgents, t]);

  async function saveAndConnect(): Promise<void> {
    if (!serverName.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    Keyboard.dismiss();
    try {
      const config = {
        id: servers.find((item) => item.url === normalizeLoopbackUrl(serverUrl))?.id ?? `termux-${Crypto.randomUUID()}`,
        name: serverName.trim(),
        url: normalizeLoopbackUrl(serverUrl),
        token: token.trim() || (server?.url === normalizeLoopbackUrl(serverUrl) ? server.token : ""),
      };
      if (!config.token) throw new Error(t("mobile.server.local.savedTokenMissing"));
      await connect(config);
      setToken("");
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : t("mobile.server.local.connectFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function createAgent(): Promise<void> {
    if (!server || !agentName.trim() || !prompt.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${server.url}/api/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: agentName.trim(),
          description: "",
          avatarSeed: `mobile:${Crypto.randomUUID().replaceAll("-", "")}`,
          avatarHue: null,
          initialMessage: prompt.trim().slice(0, INPUT_LIMITS.messageText),
        }),
      });
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (!response.ok) throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
      const value = await response.json();
      if (!isDynamicRecord(value) || !isDynamicRecord(value.agent) || !isString(value.agent.id))
        throw new Error(t("mobile.server.local.invalidResponse"));
      const created = { id: value.agent.id };
      setAgentName("");
      setPrompt("");
      await readAgents(server);
      setAgentId(created.id);
      await readConversation(server, created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("mobile.server.local.requestFailed", { status: 0 }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!server || !agentId || !message.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const text = message.trim().slice(0, INPUT_LIMITS.messageText);
    setMessage("");
    try {
      const response = await fetch(`${server.url}/api/agents/${encodeURIComponent(agentId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text, clientMessageId: Crypto.randomUUID() }),
      });
      if (response.status === 401) throw new Error(t("mobile.server.local.authFailed"));
      if (!response.ok) throw new Error(t("mobile.server.local.requestFailed", { status: response.status }));
      await readConversation(server, agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("mobile.server.local.requestFailed", { status: 0 }));
      setMessage(text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("mobile.server.local.title") }} />
      <SheetScrollView
        className="bg-background"
        contentContainerClassName="gap-4 px-5 pb-safe-offset-5 pt-5"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Typography.Heading type="h2">{server?.name ?? t("mobile.server.local.title")}</Typography.Heading>
        <Typography.Paragraph color="muted">
          {connected ? t("mobile.server.local.statusConnected") : t("mobile.server.local.statusDisconnected")}
        </Typography.Paragraph>
        {error ? <Typography.Paragraph className="text-danger-text">{error}</Typography.Paragraph> : null}
        <SheetFormField label={t("mobile.server.local.name")} value={serverName} onChangeText={setServerName} />
        <SheetFormField
          label={t("mobile.server.local.url")}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SheetFormField
          label={t("mobile.server.local.token")}
          value={token}
          onChangeText={setToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button isDisabled={busy} onPress={() => void saveAndConnect()}>
          <Button.Label>{t("mobile.server.local.connect")}</Button.Label>
        </Button>
        {server ? (
          <>
            {agentId ? (
              <>
                <Button variant="secondary" onPress={() => setAgentId(null)}>
                  <Button.Label>{t("mobile.server.local.agentList")}</Button.Label>
                </Button>
                {messages.map((item) => (
                  <View key={item.id} className="rounded-2xl bg-grouped p-4">
                    <Typography.Paragraph weight="semibold">{item.author}</Typography.Paragraph>
                    <Typography.Paragraph selectable>{item.text}</Typography.Paragraph>
                  </View>
                ))}
                <SheetFormField
                  label={t("mobile.server.local.message")}
                  value={message}
                  onChangeText={setMessage}
                  multiline
                />
                <Button isDisabled={busy || !message.trim()} onPress={() => void sendMessage()}>
                  <Button.Label>{t("mobile.server.local.send")}</Button.Label>
                </Button>
              </>
            ) : (
              <>
                <Typography.Heading type="h4">{t("mobile.server.local.agentList")}</Typography.Heading>
                {agents.map((agent) => (
                  <Button key={agent.id} variant="secondary" onPress={() => setAgentId(agent.id)}>
                    <Button.Label>{agent.name}</Button.Label>
                  </Button>
                ))}
                <Typography.Heading type="h4">{t("mobile.server.local.createAgent")}</Typography.Heading>
                <SheetFormField
                  label={t("mobile.agent.form.name")}
                  value={agentName}
                  onChangeText={setAgentName}
                  maxLength={INPUT_LIMITS.agentName}
                />
                <SheetFormField
                  label={t("mobile.server.local.firstMessage")}
                  value={prompt}
                  onChangeText={setPrompt}
                  multiline
                />
                <Button isDisabled={busy || !agentName.trim() || !prompt.trim()} onPress={() => void createAgent()}>
                  <Button.Label>{t("mobile.server.local.createAndRun")}</Button.Label>
                </Button>
              </>
            )}
          </>
        ) : null}
        <Button variant="secondary" onPress={() => router.replace({ pathname: "/", params: { mode: "cloud" } })}>
          <Button.Label>{t("mobile.server.local.cloudAccount")}</Button.Label>
        </Button>
        <View style={{ height: Math.max(insets.bottom, 8) }} />
      </SheetScrollView>
    </>
  );
}
