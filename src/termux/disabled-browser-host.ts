import type { BrowserControlState, BrowserTab } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { BrowserOperationError } from "../backend/browser-effects";
import { browserFailure } from "../backend/browser-effects";
import type { BrowserDynamicToolHooks } from "../backend/browser-tool-actions";
import type { AgentBrowserHost } from "../backend/agent/turn-lifecycle";
import type { DynamicToolCallParams, DynamicToolResult } from "../backend/protocol";

const unsupported = () => Effect.fail(browserFailure(new Error("Browser and Computer Use are disabled on Termux.")));

/** An explicit adapter. It keeps non-browser agent work available without exposing desktop APIs. */
export class DisabledBrowserHost implements AgentBrowserHost {
  onChanged(_listener: (tabs: BrowserTab[], activeTabId: string | null) => void): () => void {
    return () => undefined;
  }

  onControlChanged(_listener: (state: BrowserControlState) => void): () => void {
    return () => undefined;
  }

  onDocumentChanged(_listener: (tabId: string, documentIds: ReadonlySet<string>) => void): () => void {
    return () => undefined;
  }

  clearControls(): void {}

  endControl(_threadId: string, _turnId: string): void {}

  listTabs(): BrowserTab[] {
    return [];
  }

  beginTakeover(_tabId: string): Effect.Effect<void, BrowserOperationError> {
    return unsupported();
  }

  endTakeover(_tabId: string): void {}

  close(_tabId: string): Effect.Effect<void, BrowserOperationError> {
    return unsupported();
  }

  clearAgentSession(_agentId: string): Effect.Effect<void, BrowserOperationError> {
    return unsupported();
  }

  handleDynamicTool(
    _params: DynamicToolCallParams,
    _hooks?: BrowserDynamicToolHooks,
  ): Effect.Effect<DynamicToolResult, BrowserOperationError> {
    return unsupported();
  }

  userControlTabFor(_params: DynamicToolCallParams): string | null {
    return null;
  }

  awaitUserControlRelease(_tabId: string): Effect.Effect<void> {
    return Effect.void;
  }

  resolveUploadTarget(
    _params: DynamicToolCallParams,
  ): Effect.Effect<{ inputId: string; documentId: string }, BrowserOperationError> {
    return unsupported();
  }
}
