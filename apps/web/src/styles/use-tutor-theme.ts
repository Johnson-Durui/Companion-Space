import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { charactersKey, fetchCharacters, fetchSettings, settingsKey } from "../app/api";
import { applyTutorTheme, resolveTutorThemeId } from "./tutor-themes";

export function useTutorThemeSync(enabled: boolean): void {
  const roster = useQuery({
    queryKey: charactersKey,
    queryFn: fetchCharacters,
    enabled,
  });
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: fetchSettings,
    enabled,
  });

  const activeId = settings.data?.default_character_id ?? undefined;
  const activeChar = roster.data?.find((item) => item.id === activeId) ?? roster.data?.[0];
  const themeId = resolveTutorThemeId(activeChar?.theme);

  useEffect(() => {
    if (!enabled) return;
    applyTutorTheme(themeId, activeChar?.id ?? "default");
  }, [enabled, themeId, activeChar?.id]);
}
