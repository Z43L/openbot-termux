import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { type MediaStream, mediaDevices, RTCPeerConnection, RTCSessionDescription } from "react-native-webrtc";

/**
 * The phone's WebRTC peer of Codex live voice. The native WebRTC library holds the microphone and plays
 * the reply; the component draws nothing. The call sends its offer and takes the answer of the server.
 */
export interface CodexLiveBridgeHandle {
  /** Opens the microphone and makes the offer. The offer comes back through `onOffer`. */
  start(id: string): void;
  /** Sets the remote answer of the local server to the offer of `start`. */
  answer(id: string, sdp: string): void;
  setMuted(muted: boolean): void;
  /** Closes the peer and frees the microphone. */
  stop(): void;
}

interface Props {
  /** The WebRTC offer of the phone for the session `id`. */
  onOffer(id: string, sdp: string): void;
  /** The call failed; the message is a fixed sentence that names the cause. */
  onFailed(id: string, message: string): void;
}

/** A fixed sentence; the name of the error follows it, so that the cause shows in the call. */
const FAILURE = "The voice call could not start on this phone.";

function failureText(error: unknown): string {
  const name = error instanceof Error && error.name !== "Error" ? error.name : "";
  return name ? `${FAILURE} (${name})` : FAILURE;
}

export const CodexLiveBridge = forwardRef<CodexLiveBridgeHandle, Props>(function CodexLiveBridge(
  { onOffer, onFailed },
  ref,
) {
  const peer = useRef<RTCPeerConnection | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const muted = useRef(false);
  /** Counts the starts, so that a late answer of an ended call does not reach a new one. */
  const generation = useRef(0);

  const release = useCallback((): void => {
    for (const track of microphone.current?.getTracks() ?? []) track.stop();
    microphone.current = null;
    peer.current?.close();
    peer.current = null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      start: (id) => {
        const attempt = ++generation.current;
        release();
        mediaDevices
          .getUserMedia({ audio: true, video: false })
          .then(async (stream) => {
            if (attempt !== generation.current) {
              for (const track of stream.getTracks()) track.stop();
              return;
            }
            microphone.current = stream;
            for (const track of stream.getAudioTracks()) track.enabled = !muted.current;
            const connection = new RTCPeerConnection();
            peer.current = connection;
            for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
            connection.createDataChannel("oai-events");
            const offer = await connection.createOffer({});
            await connection.setLocalDescription(offer);
            if (!offer.sdp) throw new Error(FAILURE);
            onOffer(id, offer.sdp);
          })
          .catch((error: unknown) => {
            if (attempt !== generation.current) return;
            release();
            onFailed(id, failureText(error));
          });
      },
      answer: (id, sdp) => {
        const connection = peer.current;
        if (!connection) {
          onFailed(id, FAILURE);
          return;
        }
        connection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp })).catch((error: unknown) => {
          release();
          onFailed(id, failureText(error));
        });
      },
      setMuted: (value) => {
        muted.current = value;
        for (const track of microphone.current?.getAudioTracks() ?? []) track.enabled = !value;
      },
      stop: () => {
        generation.current += 1;
        release();
      },
    }),
    [onOffer, onFailed, release],
  );

  return null;
});
