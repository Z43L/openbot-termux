import type { UserErrorDetails } from "@openbot/user-errors";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { Keyboard, View } from "react-native";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

/**
 * Connects the OpenBot Termux server on this phone: its loopback URL and its bearer token. The
 * server keeps its agents and chats on the phone, so it needs no account.
 */
export function TermuxServerForm({
  disabled,
  onConnected,
}: {
  /** The parent is joining a server: the fields stay as they are until its answer arrives. */
  disabled: boolean;
  onConnected: (serverId: string) => void;
}) {
  const { t, errorDetails } = useText();
  const { addLocalTermuxServer } = useMobileWorkspace();
  const [name, setName] = useState(() => t("mobile.server.termux.localMode"));
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<UserErrorDetails | null>(null);
  const busy = disabled || connecting;

  async function connect(): Promise<void> {
    if (!name.trim() || !token.trim() || busy) return;
    setConnecting(true);
    setError(null);
    Keyboard.dismiss();
    try {
      const serverId = await addLocalTermuxServer({ name: name.trim(), url: url.trim(), token: token.trim() });
      void haptics.notification("success");
      onConnected(serverId);
    } catch (cause) {
      setError(errorDetails(cause, t("mobile.server.termux.connectFailed")));
      void haptics.notification("error");
    }
    setConnecting(false);
  }

  return (
    <View className="gap-3">
      <SheetFormField
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        label={t("mobile.server.termux.name")}
        maxLength={80}
        value={name}
        onChangeText={setName}
      />
      <SheetFormField
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        inputMode="url"
        label={t("mobile.server.termux.url")}
        value={url}
        onChangeText={setUrl}
      />
      <SheetFormField
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        label={t("mobile.server.termux.token")}
        secureTextEntry
        value={token}
        onChangeText={setToken}
      />
      {error ? (
        <Typography.Paragraph accessibilityRole="alert" className="text-danger-text">
          {error.message}
        </Typography.Paragraph>
      ) : null}
      <Button size="lg" isDisabled={busy || !name.trim() || !token.trim()} onPress={() => void connect()}>
        <Button.Label className="font-sans font-semibold">
          {connecting ? t("common.connecting") : t("mobile.server.termux.connect")}
        </Button.Label>
      </Button>
      <Typography.Paragraph type="body-xs" className="text-text-secondary">
        {t("mobile.server.termux.loopbackOnly")}
      </Typography.Paragraph>
    </View>
  );
}
