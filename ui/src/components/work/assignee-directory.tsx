"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { listParticipants, type Participant } from "@/lib/api/participants";
import { useTeam } from "@/components/team-context";

// Resolves an issue `assignee_id` to a display name. MCP-claimed issues store
// the JWT subject rather than the alias, so we key the directory on both.
export type ResolvedAssignee = {
  label: string;
  kind: "human" | "agent" | null;
};

type Resolver = (assigneeId: string | null) => ResolvedAssignee;

const AssigneeDirectoryContext = createContext<Resolver | null>(null);

// Server-set routing DID for token identities; the subject is the assignee_id
// MCP-claimed issues persist.
const JWT_DID_PREFIX = "did:key:jwt-";

function subjectFromDid(did: string | null): string | null {
  if (!did) return null;
  return did.startsWith(JWT_DID_PREFIX) ? did.slice(JWT_DID_PREFIX.length) : null;
}

export function AssigneeDirectoryProvider({ children }: { children: ReactNode }) {
  const { activeTeam } = useTeam();
  const [participants, setParticipants] = useState<Participant[]>([]);

  useEffect(() => {
    if (!activeTeam) {
      setParticipants([]);
      return;
    }
    let cancelled = false;
    listParticipants(activeTeam)
      .then((p) => {
        if (!cancelled) setParticipants(p);
      })
      .catch(() => {
        if (!cancelled) setParticipants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeam]);

  const resolve = useMemo<Resolver>(() => {
    const byKey = new Map<string, ResolvedAssignee>();
    for (const p of participants) {
      const label = (p.display_name || p.alias || "").trim() || p.alias;
      const entry: ResolvedAssignee = { label, kind: p.kind };
      if (p.alias) byKey.set(p.alias, entry);
      const subject = subjectFromDid(p.did_key);
      if (subject) byKey.set(subject, entry);
    }
    return (assigneeId) => {
      if (!assigneeId) return { label: "Unassigned", kind: null };
      return byKey.get(assigneeId) ?? { label: assigneeId, kind: null };
    };
  }, [participants]);

  return (
    <AssigneeDirectoryContext.Provider value={resolve}>
      {children}
    </AssigneeDirectoryContext.Provider>
  );
}

// Falls back to the raw id outside a provider or before the directory loads.
export function useAssignee(assigneeId: string | null): ResolvedAssignee {
  const resolve = useContext(AssigneeDirectoryContext);
  if (!resolve) {
    return {
      label: assigneeId ?? "Unassigned",
      kind: null,
    };
  }
  return resolve(assigneeId);
}
