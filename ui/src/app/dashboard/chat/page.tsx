"use client";

import { ChatView } from "@/components/chat/chat-view";

/**
 * Chat view: the agent conversation feed. Lists chat sessions for the active
 * team, shows a selected conversation's messages (agent vs human senders
 * visually distinguished), and lets you post a reply or start a new chat.
 *
 * Mounted inside the authenticated dashboard shell (auth guard + team context
 * live in the dashboard layout). Live updates are handled by polling.
 */
export default function ChatPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Chat</h1>
      <ChatView />
    </div>
  );
}
