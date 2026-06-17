// SSE consumer for GET /v1/events/stream. Uses fetch streaming (not EventSource)
// to carry the bearer JWT, and reconnects with backoff until aborted.
import { getAccessToken } from "@/lib/api/http";

const API_BASE = (
  process.env.NEXT_PUBLIC_AWEB_API_URL ?? "http://localhost:8088"
).replace(/\/+$/, "");

export interface AwebEvent {
  type: string;
  agent_id?: string;
  team_id?: string;
  message_id?: string;
  session_id?: string;
  conversation_id?: string;
  from_alias?: string;
  subject?: string;
  task_id?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function parseFrame(frame: string): AwebEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // keepalive / comment
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    const type = typeof data.type === "string" ? data.type : eventType;
    return { ...data, type } as AwebEvent;
  } catch {
    return null;
  }
}

async function pumpStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (e: AwebEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
    once: true,
  });
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) onEvent(ev);
    }
  }
}

// Subscribe to the team's live event stream; returns an unsubscribe function.
export function subscribeEvents(
  teamId: string,
  onEvent: (e: AwebEvent) => void,
): () => void {
  const ctrl = new AbortController();
  void (async () => {
    // Exponential backoff so a stream that keeps closing fast (e.g. a transient
    // server-side poll error) can't turn into a reconnect flood. A stream that
    // stays open a while is treated as healthy and resets the backoff.
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;
    while (!ctrl.signal.aborted) {
      const startedAt = Date.now();
      try {
        const token = await getAccessToken();
        if (!token) {
          await sleep(5000, ctrl.signal);
          continue;
        }
        // Server caps the stream lifetime; ask for a 5-min window then reconnect.
        const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const resp = await fetch(
          `${API_BASE}/v1/events/stream?deadline=${encodeURIComponent(deadline)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-AWEB-Team-Id": teamId,
              Accept: "text/event-stream",
            },
            signal: ctrl.signal,
            // Hint to keep the connection warm.
            cache: "no-store",
          },
        );
        if (!resp.ok || !resp.body) {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          await sleep(backoffMs, ctrl.signal);
          continue;
        }
        await pumpStream(resp.body, ctrl.signal, onEvent);
      } catch {
        if (ctrl.signal.aborted) return;
      }
      // Held open a while (healthy 5-min window) -> reset; ended almost
      // immediately (failing) -> back off so we don't hammer the endpoint.
      backoffMs =
        Date.now() - startedAt > 10_000
          ? 1000
          : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      await sleep(backoffMs, ctrl.signal);
    }
  })();
  return () => ctrl.abort();
}
