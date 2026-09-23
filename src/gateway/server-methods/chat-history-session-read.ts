import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import { prepareProjectedSessionPresentation } from "../session-row-presentation.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { hiddenSessionNotFound } from "../session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsNotFoundError,
} from "../session-sharing-preparation.js";
import { isGatewayAdmin, resolveSessionVisibility } from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { respondChatHistoryUnavailable, type ChatHistoryMethod } from "./chat-history-recovery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Select and revalidate history metadata through its prepared row and sharing owners. */
export async function prepareChatHistorySessionRead({
  context,
  client,
  respond,
  signal,
  method,
  sessionKey,
  agentIdOverride,
  requestedSessionId,
  retainedSessionId,
}: Pick<GatewayRequestHandlerOptions, "context" | "client" | "respond" | "signal"> & {
  method: ChatHistoryMethod;
  sessionKey: string;
  agentIdOverride?: string;
  requestedSessionId?: string;
  retainedSessionId?: string;
}) {
  const rowProjection = getSessionRowProjection(context);
  if (!rowProjection) {
    respondChatHistoryUnavailable(
      method,
      respond,
      "session rows are initializing; reload the conversation",
    );
    return undefined;
  }
  const queries = (cfg: OpenClawConfig) => {
    const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentIdOverride);
    return requested.ok ? [{ key: sessionKey, agentId: requested.agentId }] : [];
  };
  const selectSession = (read: SessionRowReadView) => {
    const cfg = read.state.cfg;
    const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentIdOverride);
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return undefined;
    }
    const record = read.describe({ key: sessionKey, agentId: requested.agentId });
    const identity = record
      ? { agentId: record.agentId, canonicalKey: record.key }
      : resolveSessionStoreIdentity({ cfg, sessionKey, agentId: requested.agentId });
    return {
      cfg,
      ...identity,
      record,
      entry: record?.storedEntry ?? record?.entry,
      storePath:
        record?.storeTarget.storePath ??
        resolveSessionStorePathCore(cfg.session?.store, { agentId: identity.agentId }),
      storeKeys: [identity.canonicalKey],
      store: {},
    };
  };
  const authorizeSharing = (
    current: NonNullable<ReturnType<typeof selectSession>>,
    read: SessionRowReadView,
  ) => {
    const sharing = prepareProjectedSessionPresentation(read, client).sharing;
    if (
      current.entry
        ? sharing.entryFilter?.(current.canonicalKey, current.entry) === false
        : requestedSessionId && !retainedSessionId && !isGatewayAdmin(client)
    ) {
      respond(false, undefined, hiddenSessionNotFound(current.canonicalKey));
      return undefined;
    }
    return sharing;
  };
  const selectedSession = await measureDiagnosticsTimelineSpan(
    `gateway.${method}.session_entry`,
    () =>
      withReadySessionRows(rowProjection, queries, (read) => {
        const selected = selectSession(read);
        return selected && authorizeSharing(selected, read) ? selected : undefined;
      }),
    { config: context.getRuntimeConfig(), phase: method },
  );
  signal?.throwIfAborted();
  if (selectedSession && !selectedSession.entry) {
    const selected = selectedSession;
    const excluded = await readExcludedChatHistoryEntry(rowProjection, {
      sessionKey,
      agentId: selected.agentId,
    });
    signal?.throwIfAborted();
    const checked = await withReadySessionRows(rowProjection, queries, (read) => {
      if (rowProjection.state.revision !== excluded.revision) {
        respondChatHistoryUnavailable(
          method,
          respond,
          "session changed while reading history; reload the conversation",
        );
        return "refused";
      }
      if (!excluded.entry) {
        return "missing";
      }
      if (authorizeSharing({ ...selected, entry: excluded.entry }, read)) {
        respondChatHistoryUnavailable(
          method,
          respond,
          "session changed while reading history; reload the conversation",
        );
      }
      return "refused";
    });
    if (checked === "refused") {
      return undefined;
    }
  }
  if (!selectedSession) {
    return undefined;
  }
  const { agentId: sessionAgentId, storePath, canonicalKey } = selectedSession;
  // The response owns nested values; resident metadata must survive caller mutation.
  const entry = selectedSession.entry ? structuredClone(selectedSession.entry) : undefined;
  const readCurrentSharing = (read: SessionRowReadView) => {
    const current = selectSession(read);
    if (!current) {
      return undefined;
    }
    const currentEntry = current.entry;
    // Task history separately validates its retained transcript; its live run may advance.
    if (
      entry &&
      (!currentEntry ||
        current.agentId !== sessionAgentId ||
        current.canonicalKey !== canonicalKey ||
        current.storePath !== storePath ||
        (!retainedSessionId &&
          (!read.describe(
            { key: canonicalKey, agentId: sessionAgentId, storePath },
            selectedSession.record,
          ) ||
            currentEntry.sessionId !== entry.sessionId ||
            currentEntry.lifecycleRevision !== entry.lifecycleRevision ||
            (entry.sessionStartedAt !== undefined &&
              currentEntry.sessionStartedAt !== entry.sessionStartedAt))))
    ) {
      respondChatHistoryUnavailable(
        method,
        respond,
        "session changed while reading history; reload the conversation",
      );
      return undefined;
    }
    const sharing = authorizeSharing(current, read);
    if (!sharing) {
      return undefined;
    }
    return currentEntry
      ? {
          visibility: resolveSessionVisibility(currentEntry),
          sharingRole: sharing.roleForTarget({
            ...current,
            entry: currentEntry,
            storeKey: current.canonicalKey,
          }),
        }
      : {};
  };
  return { selectedSession, entry, queries, readCurrentSharing, rowProjection };
}

/** Excluded durable privacy metadata can refuse a read, never authorize transcript delivery. */
async function readExcludedChatHistoryEntry(
  projection: SessionRowProjection,
  request: { sessionKey: string; agentId: string },
) {
  const state = projection.state;
  // The prepared row reader already acquired process-local incognito keys exactly.
  if (isIncognitoSessionKey(request.sessionKey)) {
    return { revision: state.revision, entry: undefined };
  }
  try {
    const prepared = await prepareSessionMutationFacts({ cfg: state.cfg, ...request });
    try {
      const { target } = prepared.readCurrent(projection.state.cfg);
      return { revision: state.revision, entry: target.entry.incognito ? target.entry : undefined };
    } finally {
      prepared.release();
    }
  } catch (error) {
    if (error instanceof SessionMutationFactsNotFoundError) {
      return { revision: state.revision, entry: undefined };
    }
    throw error;
  }
}
