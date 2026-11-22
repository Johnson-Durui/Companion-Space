import { useQuery } from "@tanstack/react-query";
import { api, bodyOf, fetchRoles, rolesKey } from "../../app/api";
import { deriveReadiness, type ReadinessState } from "./readiness-logic";

export const voiceStatusKey = ["voice", "status"] as const;

export async function fetchVoiceStatus() {
  return bodyOf(await api.GET("/api/v2/voice/status"));
}

export interface UseReadinessResult extends ReadinessState {
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useReadiness(enabled = true): UseReadinessResult {
  const roles = useQuery({
    queryKey: rolesKey,
    queryFn: fetchRoles,
    enabled,
  });
  const voice = useQuery({
    queryKey: voiceStatusKey,
    queryFn: fetchVoiceStatus,
    enabled,
  });

  const derived = deriveReadiness(
    roles.data as Record<string, unknown> | undefined,
    voice.data?.stt_configured,
  );

  return {
    ...derived,
    isPending: roles.isPending || voice.isPending,
    isError: roles.isError || voice.isError,
    refetch: () => {
      void roles.refetch();
      void voice.refetch();
    },
  };
}
