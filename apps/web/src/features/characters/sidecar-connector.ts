import type { SidecarSessionConnector, SidecarSessionHandle } from "@companion-space/avatar-engine/types";
import { api, bodyOf } from "../../app/api";

export function createSidecarConnector(): SidecarSessionConnector {
  return {
    async openSession(params): Promise<SidecarSessionHandle> {
      const response = bodyOf(
        await api.POST("/api/v2/avatar-drivers/sidecar/sessions", {
          body: {
            character_id: params.characterId,
            driver_id: params.driverId,
            aspect_ratio: params.aspectRatio,
            fps: params.fps,
            resolution: params.resolution,
            sdp_offer: params.sdpOffer ?? null,
          },
        }),
      );
      const wsUrl = new URL(response.stream_path, window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      let closed = false;
      return {
        sessionId: response.session_id,
        transport: response.transport,
        sdpAnswer: response.sdp_answer ?? null,
        streamUrl: wsUrl.toString(),
        wsProtocols: ["companion-v1", `ticket.${response.ticket}`],
        async close() {
          if (closed) return;
          closed = true;
          await api
            .DELETE("/api/v2/avatar-drivers/sidecar/sessions/{session_id}", {
              params: { path: { session_id: response.session_id } },
            })
            .catch(() => undefined);
        },
      };
    },
  };
}
