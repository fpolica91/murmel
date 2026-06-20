"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listInbox,
  listMailConversations,
  getMailThread,
  replyInThread,
  ackMessage,
  type InboxMessage,
  type MailConversationItem,
} from "@/lib/api/mail";
import { listAgents, type Agent } from "@/lib/api/members";
import { ApiError } from "@/lib/api/http";
import { subscribeEvents } from "@/lib/events/eventStream";
import { useTeam } from "@/components/team-context";
import { MailList, type MailRow } from "./mail-list";
import { MailThread } from "./mail-thread";
import { MailComposer } from "./mail-composer";
import styles from "./mail.module.css";

const LIST_POLL_MS = 6000;
const THREAD_POLL_MS = 4000;

type Tab = "inbox" | "sent";

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.status})`;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * Two-pane Mail controller. The left rail toggles between Inbox (messages
 * addressed to you, grouped by conversation, unread from `read_at === null`)
 * and Sent (all mail threads via the conversations surface). The right pane
 * shows the selected thread oldest -> newest with an inline reply.
 *
 * Live updates: poll the list (~6s) and the open thread (~4s), PLUS a
 * subscribeEvents refresh on `actionable_mail`. An `activeRef` lets the pollers
 * read the latest selection without re-subscribing on every change. Opening a
 * thread acks each unread inbound message so the unread badge clears.
 */
export function MailView() {
  const { activeTeam } = useTeam();

  const [tab, setTab] = useState<Tab>("inbox");
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [conversations, setConversations] = useState<MailConversationItem[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [thread, setThread] = useState<InboxMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [showCompose, setShowCompose] = useState(false);

  // Tracks the open conversation so polling effects read the latest value
  // without re-subscribing each time it changes.
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeConversationId;

  // Remember which inbound messages we've already acked so opening a thread
  // doesn't re-POST acks on every poll.
  const ackedRef = useRef<Set<string>>(new Set());

  // ---- Load the list (inbox + mail conversations + agents) ----------------
  const loadList = useCallback(async () => {
    if (!activeTeam) return;
    try {
      const [inboxMsgs, convResp, agentList] = await Promise.all([
        listInbox(activeTeam, { limit: 100 }),
        listMailConversations(activeTeam).catch(() => ({
          conversations: [],
          next_cursor: null,
        })),
        listAgents(activeTeam).catch(() => [] as Agent[]),
      ]);
      setInbox(inboxMsgs);
      setConversations(convResp.conversations);
      setAgents(agentList);
      setListError(null);
    } catch (err) {
      setListError(errMessage(err, "Failed to load mail."));
    } finally {
      setListLoading(false);
    }
  }, [activeTeam]);

  // Initial + polled list load.
  useEffect(() => {
    if (!activeTeam) {
      setInbox([]);
      setConversations([]);
      setAgents([]);
      setListLoading(false);
      return;
    }
    setListLoading(true);
    void loadList();
    const id = setInterval(() => void loadList(), LIST_POLL_MS);
    return () => clearInterval(id);
  }, [activeTeam, loadList]);

  // Reset selection on team switch.
  useEffect(() => {
    setActiveConversationId(null);
    setThread([]);
    ackedRef.current = new Set();
  }, [activeTeam]);

  // ---- Build the rows for the active tab ---------------------------------
  // Inbox: group inbound messages by conversation_id (legacy single messages
  // fall back to their own message_id), newest first, with the unread count =
  // number of unread messages in that group.
  const inboxRows = useMemo<MailRow[]>(() => {
    const byGroup = new Map<string, MailRow & { _ts: number }>();
    for (const m of inbox) {
      const groupId = m.conversation_id ?? m.message_id;
      const ts = Date.parse(m.created_at) || 0;
      const unread = m.read_at === null ? 1 : 0;
      const existing = byGroup.get(groupId);
      if (!existing) {
        byGroup.set(groupId, {
          id: groupId,
          conversationId: m.conversation_id,
          subject: m.subject ?? "",
          people: `${m.from_alias} → ${m.to_alias}`,
          lastActivity: m.created_at,
          unread,
          priority: m.priority,
          _ts: ts,
        });
      } else {
        existing.unread += unread;
        if (ts > existing._ts) {
          existing._ts = ts;
          existing.lastActivity = m.created_at;
          existing.subject = m.subject ?? existing.subject;
          existing.people = `${m.from_alias} → ${m.to_alias}`;
          existing.priority = m.priority;
        }
      }
    }
    return Array.from(byGroup.values()).sort((a, b) => b._ts - a._ts);
  }, [inbox]);

  // Sent/threads: every mail conversation, newest first.
  const sentRows = useMemo<MailRow[]>(() => {
    return [...conversations]
      .map((c) => ({
        id: c.conversation_id ?? c.legacy_message_id ?? "",
        conversationId: c.conversation_id,
        subject: c.subject,
        people: c.last_message_from || c.participants.join(", "),
        lastActivity: c.last_message_at,
        unread: c.unread_count,
      }))
      .filter((r) => r.id !== "")
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }, [conversations]);

  const rows = tab === "inbox" ? inboxRows : sentRows;

  // ---- Load + ack the active thread --------------------------------------
  const loadThread = useCallback(
    async (conversationId: string, opts: { showSpinner?: boolean } = {}) => {
      if (!activeTeam) return;
      if (opts.showSpinner) setThreadLoading(true);
      try {
        const msgs = await getMailThread(activeTeam, conversationId);
        // Guard against a stale response after the user switched threads.
        if (activeRef.current !== conversationId) return;
        setThread(msgs);
        setThreadError(null);

        // Ack each unread inbound message so the badge clears. We only ack a
        // message once (tracked in ackedRef); a message is "inbound" when it is
        // unread (read_at === null) — the server only stamps read_at on mail
        // addressed to the caller, so unread here is exactly our inbound mail.
        const toAck = msgs.filter(
          (m) => m.read_at === null && !ackedRef.current.has(m.message_id),
        );
        if (toAck.length > 0) {
          for (const m of toAck) ackedRef.current.add(m.message_id);
          await Promise.allSettled(
            toAck.map((m) => ackMessage(activeTeam, m.message_id)),
          );
          // Refresh the list so the unread badge/dot updates promptly.
          void loadList();
        }
      } catch (err) {
        if (activeRef.current === conversationId) {
          setThreadError(errMessage(err, "Failed to load messages."));
        }
      } finally {
        if (opts.showSpinner) setThreadLoading(false);
      }
    },
    [activeTeam, loadList],
  );

  useEffect(() => {
    if (!activeConversationId || !activeTeam) {
      setThread([]);
      return;
    }
    setThread([]);
    void loadThread(activeConversationId, { showSpinner: true });
    const id = setInterval(
      () => void loadThread(activeConversationId),
      THREAD_POLL_MS,
    );
    return () => clearInterval(id);
  }, [activeConversationId, activeTeam, loadThread]);

  // Live updates via SSE; the polling effects above are the fallback.
  useEffect(() => {
    if (!activeTeam) return;
    return subscribeEvents(activeTeam, (e) => {
      if (e.type !== "actionable_mail") return;
      void loadList();
      const cid = activeRef.current;
      if (cid && (!e.conversation_id || e.conversation_id === cid)) {
        void loadThread(cid);
      }
    });
  }, [activeTeam, loadList, loadThread]);

  // ---- Actions -----------------------------------------------------------
  const handleSelect = useCallback((row: MailRow) => {
    // Only threads with a real conversation_id are continuation-capable; a
    // legacy single message still opens to show its body (no reply box).
    setActiveConversationId(row.conversationId ?? row.id);
  }, []);

  const handleReply = useCallback(
    async (conversationId: string, body: string) => {
      if (!activeTeam) return;
      try {
        await replyInThread(activeTeam, conversationId, body);
        await loadThread(conversationId);
        void loadList();
      } catch (err) {
        setThreadError(errMessage(err, "Failed to send reply."));
        throw err;
      }
    },
    [activeTeam, loadThread, loadList],
  );

  const handleSent = useCallback(
    (result: { conversation_id: string | null }) => {
      void loadList();
      if (result.conversation_id) {
        setTab("sent");
        setActiveConversationId(result.conversation_id);
      }
    },
    [loadList],
  );

  // ---- Render ------------------------------------------------------------
  if (!activeTeam) {
    return <div className={styles.empty}>Select a team to view mail.</div>;
  }

  const inboxUnread = inboxRows.reduce((n, r) => n + r.unread, 0);
  const activeRow = rows.find(
    (r) => (r.conversationId ?? r.id) === activeConversationId,
  );

  return (
    <div className={styles.layout}>
      <div className={styles.listPanel}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>Mail</span>
          <button
            type="button"
            className={styles.composeBtn}
            onClick={() => setShowCompose(true)}
          >
            + Compose
          </button>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === "inbox" ? styles.tabActive : ""}`}
            onClick={() => setTab("inbox")}
          >
            Inbox
            {inboxUnread > 0 && (
              <span className={styles.tabCount}>
                {inboxUnread > 99 ? "99+" : inboxUnread}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === "sent" ? styles.tabActive : ""}`}
            onClick={() => setTab("sent")}
          >
            Threads
          </button>
        </div>

        {listError && <div className={styles.error}>{listError}</div>}
        {listLoading && rows.length === 0 ? (
          <div className={styles.loadingRow}>Loading…</div>
        ) : (
          <MailList
            rows={rows}
            activeId={activeConversationId}
            onSelect={handleSelect}
            emptyLabel={
              tab === "inbox" ? "Your inbox is empty." : "No mail threads yet."
            }
          />
        )}
      </div>

      <div className={styles.threadPanel}>
        {activeConversationId ? (
          <>
            <div className={styles.threadHeader}>
              <h2 className={styles.threadTitle}>
                {activeRow?.subject || "(no subject)"}
              </h2>
              <p className={styles.threadSub}>
                {activeRow?.people ??
                  `${thread.length} message${thread.length === 1 ? "" : "s"}`}
              </p>
            </div>
            {threadError && <div className={styles.error}>{threadError}</div>}
            <MailThread
              messages={thread}
              conversationId={activeRow?.conversationId ?? null}
              loading={threadLoading}
              onReply={handleReply}
            />
          </>
        ) : (
          <div className={styles.placeholder}>
            {rows.length === 0
              ? "No mail yet. Start one with + Compose."
              : "Select a message to read and reply."}
          </div>
        )}
      </div>

      {showCompose && (
        <MailComposer
          teamId={activeTeam}
          agents={agents}
          onClose={() => setShowCompose(false)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}
