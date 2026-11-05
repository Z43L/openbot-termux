import type { DOMProps } from "expo/dom";
import { expoGoDomOptions } from "@/shared/lib/expo-go-dom";

/** The bridge page of Codex live voice has no layout: it is a hidden 1 point page beside the chat. */
export const CODEX_BRIDGE_DOM: DOMProps = {
  ...expoGoDomOptions,
  containerStyle: {
    flex: 0,
    height: 1,
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 1,
  },
  pointerEvents: "none",
  scrollEnabled: false,
  style: { flex: 0, height: 1, width: 1 },
};
