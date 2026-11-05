"use dom";

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from "expo/dom";
import { type Ref, useRef } from "react";

type BridgeJson = Parameters<DOMImperativeFactory[string]>[0];

/**
 * The native side's handle on the WebRTC peer of Codex live voice. The peer lives in this page, which
 * has the microphone and plays the reply. The native side sends the answer of the local server.
 */
export type CodexLiveBridgeHandle = {
  /** Opens the microphone and makes the offer. The offer comes back through `onOffer`. */
  start: (request: BridgeJson) => void;
  /** Sets the remote answer of the local server to the offer of `start`. */
  answer: (request: BridgeJson) => void;
  setMuted: (request: BridgeJson) => void;
  /** Closes the peer and frees the microphone. */
  stop: () => void;
};

interface Props {
  ref: Ref<CodexLiveBridgeHandle>;
  dom?: DOMProps;
  /** The WebRTC offer of the phone for the session `id`. */
  onOffer: (id: string, sdp: string) => void;
  /** The call failed; the message is a fixed sentence the phone can show. */
  onFailed: (id: string, message: string) => void;
}

const FAILURE = "The voice call could not start on this phone.";

/** The name of the error, such as NotAllowedError for a denied microphone, so the cause shows on screen. */
function failureWith(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return name ? `${FAILURE} (${name})` : FAILURE;
}

/** One audio track and the data channel that Codex App Server expects, as on the desktop. */
export default function CodexLiveBridge({ ref, onOffer, onFailed }: Props) {
  const peer = useRef<RTCPeerConnection | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  /** The reply plays from this element, which the page does not show. */
  const reply = useRef<HTMLAudioElement | null>(null);
  const muted = useRef(false);

  function release(): void {
    for (const track of microphone.current?.getTracks() ?? []) track.stop();
    microphone.current = null;
    peer.current?.close();
    peer.current = null;
  }

  useDOMImperativeHandle(
    ref,
    () => ({
      start: async (request) => {
        const id = isDynamicRecord(request) && request.id !== undefined ? String(request.id) : "";
        release();
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            // The reply plays while the microphone listens: the echo canceller removes it.
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
          microphone.current = stream;
          for (const track of stream.getAudioTracks()) track.enabled = !muted.current;
          const connection = new RTCPeerConnection();
          peer.current = connection;
          for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
          const player = reply.current ?? new Audio();
          reply.current = player;
          player.autoplay = true;
          connection.addEventListener("track", (event) => {
            const [remote] = event.streams;
            if (!remote) return;
            player.srcObject = remote;
            void player.play().catch(() => undefined);
          });
          connection.createDataChannel("oai-events");
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          if (!offer.sdp) throw new Error(FAILURE);
          onOffer(id, offer.sdp);
        } catch (error) {
          release();
          onFailed(id, failureWith(error));
        }
      },
      answer: async (request) => {
        const id = isDynamicRecord(request) && request.id !== undefined ? String(request.id) : "";
        const sdp = isDynamicRecord(request) && request.sdp !== undefined ? String(request.sdp) : "";
        try {
          if (!peer.current) throw new Error(FAILURE);
          await peer.current.setRemoteDescription({ type: "answer", sdp });
        } catch {
          release();
          onFailed(id, FAILURE);
        }
      },
      setMuted: (request) => {
        muted.current = isDynamicRecord(request) && request.muted === true;
        for (const track of microphone.current?.getAudioTracks() ?? []) track.enabled = !muted.current;
      },
      stop: () => release(),
    }),
    [onOffer, onFailed],
  );

  // The page shows nothing: the bridge only holds the peer and the microphone.
  return null;
}
