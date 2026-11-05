import type { VoiceLiveEvent } from "@openbot/contracts/ipc";

/**
 * The Codex live voice events of the local Termux server, by server. The server sends them on its
 * event stream; the Voice screen and the live conversation listen here.
 */
type LocalVoiceListener = (serverId: string, event: VoiceLiveEvent) => void;

const listeners = new Set<LocalVoiceListener>();

/** Calls `listener` for each live voice event. Returns the function that stops it. */
export function subscribeLocalVoiceLive(listener: LocalVoiceListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function emitLocalVoiceLive(serverId: string, event: VoiceLiveEvent): void {
  for (const listener of listeners) listener(serverId, event);
}
