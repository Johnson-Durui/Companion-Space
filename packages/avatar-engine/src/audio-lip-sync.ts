import type { VisemeWeights } from "./viseme";

export interface AudioLipSync {
  readonly input: AudioNode;
  read: () => { volume: number; weights: VisemeWeights };
  dispose: () => void;
}

export async function createAudioLipSync(context: AudioContext): Promise<AudioLipSync> {
  if (!context.audioWorklet) {
    throw new Error("AudioWorklet is unavailable.");
  }

  const { WLipSyncEngine } = await import("three-vrm-lip-sync");
  const engine = await WLipSyncEngine.create(context);
  return {
    input: engine.input,
    read: () => ({
      volume: engine.volume,
      weights: {
        aa: engine.weights.aa,
        ih: engine.weights.ih,
        ou: engine.weights.ou,
        ee: engine.weights.ee,
        oh: engine.weights.oh,
      },
    }),
    dispose: () => engine.dispose(),
  };
}
