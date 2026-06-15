"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listChatConversations,
  listChatSessions,
  listSessionMessages,
  markSessionRead,
  sendSessionMessage,
  startChatSession,
  type ChatMessage,
  type ConversationItem,
  type SessionListItem,
} from "@/lib/api/chat";
import { ApiError } from "@/lib/api/http";
import { listAgents, type Agent } from "@/lib/api/members";
import { useTeam } from "@/components/team-context";
import {
  ConversationList,
  sessionPeers,
  type ConversationRow,
} from "./conversation-list";
import { MessageComposer } from "./message-composer";
import { MessageThread } from "./message-thread";
import { NewConversation } from "./new-conversation";
import styles from "./chat.module.css";

const LIST_POLL_MS = 6000;
const THREAD_POLL_MS = 4000;

/** Errors that aren't fatal for the whole screen. */
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.status})`;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function ChatView() {
  const { activeTeam } = useTeam();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);

  // Track the active session in a ref so polling effects read the latest value
  // without re-subscribing each time it changes.
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeSessionId;

  // Aliases known to belong to agents — anything NOT an agent and not you we
  // tag as a human sender in the thread.
  const agentAliases = useMemo(
    () => new Set(agents.map((a) => a.alias)),
    [agents],
  );

  // ---- Load the conversation list (sessions + enrichment) ----------------
  const loadList = useCallback(async () => {
    if (!activeTeam) return;
    try {
      const [sessionList, convResp] = await Promise.all([
        listChatSessions(activeTeam),
        listChatConversations(activeTeam).catch(() => ({
          conversations: [],
          next_cursor: null,
        })),
      ]);
      setSessions(sessionList);
      setConversations(convResp.conversations);
      setListError(null);
    } catch (err) {
      setListError(errMessage(err, "Failed to load conversations."));
    } finally {
      setListLoading(false);
    }
  }, [activeTeam]);

  // Load agents once per team (for the new-chat picker + human/agent tagging).
  useEffect(() => {
    if (!activeTeam) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    listAgents(activeTeam)
      .then((a) => {
        if (!cancelled) setAgents(a);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeam]);

  // Initial + polled list load.
  useEffect(() => {
    if (!activeTeam) {
      setSessions([]);
      setConversations([]);
      setListLoading(false);
      return;
    }
    setListLoading(true);
    void loadList();
    const id = setInterval(() => void loadList(), LIST_POLL_MS);
    return () => clearInterval(id);
  }, [activeTeam, loadList]);

  // ---- Build the normalized rows the list renders ------------------------
  const rows = useMemo<ConversationRow[]>(() => {
    const byId = new Map<string, ConversationItem>();
    for (const c of conversations) {
      if (c.conversation_id) byId.set(c.conversation_id, c);
    }
    return sessions
      .map<ConversationRow>((s) => {
        const enrich = byId.get(s.session_id);
        return {
          // The server returns `participants` already excluding the caller, so
          // they ARE the peers. (Passing null keeps every participant.)
          sessionId: s.session_id,
          peers: sessionPeers(s, null),
          lastActivity: enrich?.last_message_at ?? s.last_activity,
          preview: enrich?.last_message_preview ?? "",
          lastFrom: enrich?.last_message_from ?? "",
          unread: enrich?.unread_count ?? 0,
          senderWaiting: s.sender_waiting,
        };
      })
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }, [sessions, conversations]);

  // ---- Load messages for the active session (initial + poll) -------------
  const loadMessages = useCallback(
    async (sessionId: string, opts: { showSpinner?: boolean } = {}) => {
      if (!activeTeam) return;
      if (opts.showSpinner) setThreadLoading(true);
      try {
        const msgs = await listSessionMessages(activeTeam, sessionId);
        // Guard against a stale response after the user switched sessions.
        if (activeRef.current !== sessionId) return;
        setMessages(msgs);
        setThreadError(null);
        const last = msgs[msgs.length - 1];
        if (last) {
          void markSessionRead(activeTeam, sessionId, last.message_id).catch(
            () => {},
          );
        }
      } catch (err) {
        if (activeRef.current === sessionId) {
          setThreadError(errMessage(err, "Failed to load messages."));
        }
      } finally {
        if (opts.showSpinner) setThreadLoading(false);
      }
    },
    [activeTeam],
  );

  useEffect(() => {
    if (!activeSessionId || !activeTeam) {
      setMessages([]);
      return;
    }
    setMessages([]);
    void loadMessages(activeSessionId, { showSpinner: true });
    const id = setInterval(
      () => void loadMessages(activeSessionId),
      THREAD_POLL_MS,
    );
    return () => clearInterval(id);
  }, [activeSessionId, activeTeam, loadMessages]);

  // ---- Actions -----------------------------------------------------------
  const handleSend = useCallback(
    async (body: string) => {
      if (!activeTeam || !activeSessionId) return;
      try {
        await sendSessionMessage(activeTeam, activeSessionId, body);
        await loadMessages(activeSessionId);
      } catch (err) {
        setThreadError(errMessage(err, "Failed to send message."));
        throw err;
      }
    },
    [activeTeam, activeSessionId, loadMessages],
  );

  const handleStart = useCallback(
    async (toAlias: string, message: string) => {
      if (!activeTeam) return;
      const res = await startChatSession(activeTeam, toAlias, message);
      setShowNew(false);
      await loadList();
      setActiveSessionId(res.session_id);
    },
    [activeTeam, loadList],
  );

  // ---- Render ------------------------------------------------------------
  if (!activeTeam) {
    return (
      <div className={styles.empty}>
        Select a team to view conversations.
      </div>
    );
  }

  const activeRow = rows.find((r) => r.sessionId === activeSessionId);
  // The server excludes the caller from a session's participant list, so the
  // active session's peers are exactly "everyone who isn't me". A message is
  // therefore "mine" iff its sender is NOT one of those peers — this is robust
  // even for a single 1:1 session (where a self-alias can't be inferred from
  // the participant set alone).
  const peerAliases = useMemo(
    () => new Set(activeRow?.peers ?? []),
    [activeRow],
  );
  // Humans = peer senders in the thread who aren't agents.
  const humanAliases = new Set(
    messages
      .map((m) => m.from_agent)
      .filter((a) => a && peerAliases.has(a) && !agentAliases.has(a)),
  );

  return (
    <div className={styles.layout}>
      <div className={styles.listPanel}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>Conversations</span>
          <button
            type="button"
            className={styles.newBtn}
            onClick={() => setShowNew((v) => !v)}
          >
            {showNew ? "Close" : "+ New"}
          </button>
        </div>

        {showNew && (
          <NewConversation
            agents={agents}
            onStart={handleStart}
            onCancel={() => setShowNew(false)}
          />
        )}

        {listError && <div className={styles.error}>{listError}</div>}
        {listLoading && rows.length === 0 ? (
          <div className={styles.loadingRow}>Loading…</div>
        ) : (
          <ConversationList
            rows={rows}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
          />
        )}
      </div>

      <div className={styles.threadPanel}>
        {activeSessionId ? (
          <>
            <div className={styles.threadHeader}>
              <h2 className={styles.threadTitle}>
                {activeRow && activeRow.peers.length > 0
                  ? activeRow.peers.join(", ")
                  : "Conversation"}
              </h2>
              <p className={styles.threadSub}>
                {messages.length} message{messages.length === 1 ? "" : "s"}
              </p>
            </div>
            {threadError && <div className={styles.error}>{threadError}</div>}
            <MessageThread
              messages={messages}
              peerAliases={peerAliases}
              humanAliases={humanAliases}
              loading={threadLoading}
            />
            <MessageComposer onSend={handleSend} />
          </>
        ) : (
          <div className={styles.placeholder}>
            {rows.length === 0
              ? "No conversations yet. Start one with + New."
              : "Select a conversation to read and reply."}
          </div>
        )}
      </div>
    </div>
  );
}
