import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  charactersKey,
  fetchCharacters,
  fetchSettings,
  settingsKey,
  type Character,
} from "../../app/api";

export function useActiveTutor(enabled = true) {
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings, enabled });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters, enabled });

  const tutor = useMemo(() => {
    const list = characters.data ?? [];
    if (!list.length) return null;
    const preferredId = settings.data?.default_character_id;
    return list.find((entry) => entry.id === preferredId) ?? list[0] ?? null;
  }, [characters.data, settings.data?.default_character_id]);

  return {
    tutor,
    characters: characters.data ?? [],
    defaultCharacterId: settings.data?.default_character_id ?? null,
    isPending: settings.isPending || characters.isPending,
  };
}

export function tutorLine(
  tutor: Character | null | undefined,
  key: "morning" | "afternoon" | "evening" | "analysis_done" | "lobby" | "correct" | "comfort" | "goodbye" | "empty",
  fallback: string,
): string {
  const fromLines = tutor?.lines?.[key]?.trim();
  if (fromLines) return fromLines;
  return fallback;
}

export function tutorGreeting(tutor: Character | null | undefined): string {
  return tutor?.greeting?.trim() || tutor?.persona?.catchphrases?.[0]?.trim() || "";
}
