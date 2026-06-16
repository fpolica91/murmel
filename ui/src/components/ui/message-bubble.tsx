"use client";

import type { ReactNode } from "react";

import { Avatar } from "./avatar";
import { KindBadge, type ParticipantKind } from "./badge";
import styles from "./ui.module.css";

/**
 * Strip a leading "Author:" / "Author (role):" prefix from a message body when
 * it matches the rendered sender, so the author isn't repeated inside the
 * bubble (fixes M6). Only the FIRST line's leading prefix is removed, and only
 * when it clearly names the sender (case-insensitive, parenthetical role
 * tolerated). Real content that merely contains a colon is untouched.
 */
export function stripAuthorPrefix(body: string, author: string): string {
  if (!body || !author) return body;
  const colon = body.indexOf(":");
  if (colon <= 0) return body;
  const prefix = body.slice(0, colon).trim();
  // Normalize both sides by dropping parenthetical role tokens + non-alphanum.
  const norm = (s: string) =>
    s
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/gi, "")
      .toLowerCase();
  const np = norm(prefix);
  const na = norm(author);
  if (np && na && np === na) {
    return body.slice(colon + 1).trimStart();
  }
  return body;
}

/**
 * Unified chat / conversation message bubble. BOTH self ("mine", right-aligned,
 * accent tint) and other (left-aligned, neutral) messages use this one
 * component and layout — avatar + author + kind badge + time in a consistent
 * position, same bubble radius, content-hugging width with a sensible max-width
 * (fixes B1). Self messages hide the avatar/badge (you know it's you) and align
 * right; other messages lead with the avatar.
 */
export function MessageBubble({
  body,
  author,
  kind,
  time,
  mine,
}: {
  body: string;
  /** Display name of the sender (shown for incoming; "You" for self). */
  author: string;
  /** Authoritative human/agent kind; controls the avatar colour + badge. */
  kind: ParticipantKind;
  time?: ReactNode;
  mine: boolean;
}) {
  const text = stripAuthorPrefix(body, author) || "(no content)";

  return (
    <div className={`${styles.msgRow} ${mine ? styles.msgMine : ""}`}>
      {!mine && (
        <Avatar label={author} kind={kind} size="sm" className={styles.msgAvatar} />
      )}
      <div className={styles.msgColumn}>
        <div className={styles.msgMeta}>
          <span className={styles.msgAuthor}>{mine ? "You" : author}</span>
          {!mine && <KindBadge kind={kind} />}
          {time != null && <span className={styles.msgTime}>{time}</span>}
        </div>
        <div className={styles.msgBubble}>{text}</div>
      </div>
    </div>
  );
}
