import { useCallback, useEffect, useRef, useState } from "react";
import { Easing, useSharedValue, withTiming } from "react-native-reanimated";
import type { CodexLiveBridgeHandle } from "@/features/voice/components/codex-live-bridge.dom";
import { subscribeLocalVoiceLive } from "@/features/voice/model/local-live-voice";
import { type LocalTermuxServerConfig, readLocalTermuxServers } from "@/features/workspace/model/local-termux-server";
import { LocalTermuxTransport } from "@/features/workspace/model/local-termux-transport";
import type { LiveConversationPhase } from "../model/live-conversation";
import type { LiveConversation } from "./use-live-conversation";

/** How long the presence of the call takes to open or close. */
const PRESENCE_MS = 420;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** The bridge page loads after the chat: the call waits for it this many times, this long each time. */
const BRIDGE_WAIT_MS = 500;
const BRIDGE_WAIT_TRIES = 20;

export interface CodexLiveInput {
  /** The chat is in front, and the person can write here. */
  enabled: boolean;
  /** The server of the chat. A call runs only on the phone's own local server. */
  serverId: string;
  agentId: string;
  /** Codex is the agent's provider. Other providers keep the on-device voice. */
  isCodex: boolean;
  /** The fixed texts that the call shows when it fails or ends. */
  texts: { failed: string; closed: string };
}

export interface CodexLive {
  /** The call in the shape of a live conversation, so the call bar draws it as it draws the others. */
  live: LiveConversation;
  /** Whether the bridge page must be mounted: the call can start here. */
  mounted: boolean;
  /** Props of the bridge page that holds the WebRTC peer. */
  bridge: {
    ref: (handle: CodexLiveBridgeHandle | null) => void;
    onOffer: (id: string, sdp: string) => void;
    onFailed: (id: string, message: string) => void;
  };
}

/**
 * Codex live voice on this phone. The phone's WebRTC peer holds the microphone and plays the reply;
 * the local server opens the call with the Codex sign-in on this phone. The voice model runs its
 * turns in the agent's chat, as on desktop. Off until the user turns Codex live voice on in Settings.
 */
export function useCodexLive(input: CodexLiveInput): CodexLive {
  const [config, setConfig] = useState<LocalTermuxServerConfig | null>(null);
  const [optedIn, setOptedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<LiveConversationPhase>("starting");
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const presence = useSharedValue(0);
  const level = useSharedValue(0);
  const current = useRef({ input, config });
  current.current = { input, config };
  const bridgeRef = useRef<CodexLiveBridgeHandle | null>(null);
  /** The session of the local server, once it answers. */
  const sessionRef = useRef<string | null>(null);
  /** Counts the starts and ends, so that an answer to a start that ended goes nowhere. */
  const generation = useRef(0);
  const callOn = useRef(false);

  // The phone's own server and its Codex live voice opt-in. Read again when the chat opens.
  const { enabled, serverId, isCodex } = input;
  useEffect(() => {
    if (!enabled || !isCodex) return;
    let active = true;
    void readLocalTermuxServers()
      .then(async (items) => {
        const found = items.find((item) => item.id === serverId) ?? null;
        if (!active) return;
        setConfig(found);
        if (!found) return;
        const settings = await new LocalTermuxTransport(found).readLiveVoiceSettings();
        if (active) setOptedIn(settings.codexLive);
      })
      .catch(() => {
        if (active) setOptedIn(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, isCodex, serverId]);

  const reset = useCallback(() => {
    callOn.current = false;
    sessionRef.current = null;
    setOpen(false);
    setPhase("starting");
    setCaption("");
    level.value = 0;
    presence.value = withTiming(0, { duration: PRESENCE_MS, easing: EASE_OUT });
  }, [level, presence]);

  /** Ends the call on this phone and on the server, and shows why. */
  const finish = useCallback(
    (message: string | null) => {
      const session = sessionRef.current;
      const config = current.current.config;
      bridgeRef.current?.stop();
      if (session && config) void new LocalTermuxTransport(config).stopLiveVoice(session).catch(() => undefined);
      reset();
      setError(message);
    },
    [reset],
  );

  const onOffer = useCallback(
    (id: string, sdp: string) => {
      const { config, input } = current.current;
      if (!config || id !== String(generation.current)) return;
      const transport = new LocalTermuxTransport(config);
      transport
        .startLiveVoice(input.agentId, sdp)
        .then((session) => {
          if (id !== String(generation.current) || !callOn.current) {
            void transport.stopLiveVoice(session.sessionId).catch(() => undefined);
            return;
          }
          sessionRef.current = session.sessionId;
          bridgeRef.current?.answer({ id, sdp: session.sdp });
        })
        .catch((cause: unknown) => {
          if (id !== String(generation.current)) return;
          finish(cause instanceof Error ? cause.message : current.current.input.texts.failed);
        });
    },
    [finish],
  );

  const onFailed = useCallback(
    (id: string, message: string) => {
      if (id !== String(generation.current)) return;
      finish(message || current.current.input.texts.failed);
    },
    [finish],
  );

  const bridgeReference = useCallback((handle: CodexLiveBridgeHandle | null) => {
    bridgeRef.current = handle;
  }, []);

  const start = useCallback(() => {
    const { config, input } = current.current;
    if (!config || !input.isCodex || callOn.current) return;
    const attempt = ++generation.current;
    callOn.current = true;
    setError(null);
    setCaption("");
    setMuted(false);
    setPhase("starting");
    setOpen(true);
    presence.value = withTiming(1, { duration: PRESENCE_MS, easing: EASE_OUT });
    let tries = 0;
    const begin = () => {
      if (attempt !== generation.current) return;
      if (!bridgeRef.current) {
        tries += 1;
        if (tries > BRIDGE_WAIT_TRIES) {
          finish(current.current.input.texts.failed);
          return;
        }
        setTimeout(begin, BRIDGE_WAIT_MS);
        return;
      }
      bridgeRef.current.start({ id: String(attempt) });
    };
    begin();
  }, [finish, presence]);

  const end = useCallback(() => {
    generation.current += 1;
    callOn.current = false;
    finish(null);
  }, [finish]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    bridgeRef.current?.setMuted({ muted: next });
  }, [muted]);

  // The server's events of the call: what the user says, the reply that is spoken, and the end.
  useEffect(() => {
    if (!config) return;
    return subscribeLocalVoiceLive((eventServerId, event) => {
      if (eventServerId !== config.id) return;
      if (sessionRef.current !== null && event.sessionId !== sessionRef.current) return;
      if (event.type === "ended") {
        if (callOn.current) {
          generation.current += 1;
          finish(event.error ?? current.current.input.texts.closed);
        }
        return;
      }
      setCaption(event.text);
      if (event.role === "user") setPhase(event.final ? "thinking" : "listening");
      else {
        setPhase("speaking");
        level.value = 0.5;
      }
    });
  }, [config, finish, level]);

  // Leaving the chat, or turning the voice off, ends the call.
  useEffect(() => {
    if (!enabled && callOn.current) end();
  }, [enabled, end]);

  const available = enabled && isCodex && optedIn && config !== null;
  const live: LiveConversation = {
    available,
    open,
    exit: null,
    phase,
    muted,
    caption,
    error,
    speakerId: null,
    micOpen: open && !muted && phase === "listening",
    level,
    presence,
    start,
    toggleMute,
    interrupt: () => {
      // Interrupt stops the reply: the call ends and starts again on the same agent thread.
      end();
      start();
    },
    end,
  };
  return { live, mounted: available, bridge: { ref: bridgeReference, onOffer, onFailed } };
}
