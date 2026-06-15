"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface TeamContextValue {
  teams: string[];
  activeTeam: string | null;
  setActiveTeam: (teamId: string) => void;
}

const TeamContext = createContext<TeamContextValue | null>(null);

const STORAGE_KEY = "aweb.activeTeam";

/**
 * Holds the list of teams the signed-in subject belongs to (hint from the
 * server) and the currently selected one. Selection persists in localStorage so
 * a reload keeps the user's context.
 */
export function TeamProvider({
  teams,
  children,
}: {
  teams: string[];
  children: ReactNode;
}) {
  const [activeTeam, setActiveTeamState] = useState<string | null>(
    teams[0] ?? null,
  );

  // Restore persisted selection, but only if it is still a valid membership.
  useEffect(() => {
    const stored =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    if (stored && teams.includes(stored)) {
      setActiveTeamState(stored);
    } else if (!teams.includes(activeTeam ?? "")) {
      setActiveTeamState(teams[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams]);

  const value = useMemo<TeamContextValue>(
    () => ({
      teams,
      activeTeam,
      setActiveTeam: (teamId: string) => {
        setActiveTeamState(teamId);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, teamId);
        }
      },
    }),
    [teams, activeTeam],
  );

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext);
  if (!ctx) {
    throw new Error("useTeam must be used within a <TeamProvider>");
  }
  return ctx;
}
