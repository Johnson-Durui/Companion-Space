import rawCatalog from "../../../libs/schemas/tutor_media_catalog.json";

export type ClipGroup =
  | "idle"
  | "listen"
  | "wait"
  | "think"
  | "prepare"
  | "review"
  | "speak"
  | "board"
  | "greet"
  | "farewell"
  | "praise"
  | "comfort"
  | "celebrate"
  | "hint"
  | "ack"
  | "intro";

export type ClipKind = "loop" | "loop_insert" | "one_shot";

export type ClipMissingBehavior =
  | "skip"
  | "keep"
  | "board_point_then_speak"
  | "enter_think_group";

export type ClipSlot = (typeof rawCatalog.clips)[number]["id"];
export type StillSlot = (typeof rawCatalog.stills)[number];
export type StillLocation = keyof typeof rawCatalog.still_locations;

export interface ClipCatalogEntry {
  readonly id: ClipSlot;
  readonly group: ClipGroup;
  readonly kind: ClipKind;
  readonly fallback: readonly ClipSlot[];
  readonly allow_audio?: boolean;
  readonly missing_behavior?: ClipMissingBehavior;
  readonly reserved?: boolean;
  readonly batch?: "P0" | "P1" | "P2";
}

export const MEDIA_CATALOG = rawCatalog;

export const CLIP_CATALOG: readonly ClipCatalogEntry[] = rawCatalog.clips as unknown as readonly ClipCatalogEntry[];

export const CLIP_SLOTS: readonly ClipSlot[] = CLIP_CATALOG.map((entry) => entry.id);

export const ACTIVE_CLIP_SLOTS: readonly ClipSlot[] = CLIP_CATALOG.filter((entry) => !entry.reserved).map(
  (entry) => entry.id,
);

export const LEGACY_CLIP_SLOTS: readonly ClipSlot[] = rawCatalog.legacy_slots as unknown as readonly ClipSlot[];

export const STILL_SLOTS: readonly StillSlot[] = rawCatalog.stills as unknown as readonly StillSlot[];

export const STILL_LOCATIONS: Readonly<Record<StillLocation, readonly StillSlot[]>> =
  rawCatalog.still_locations as unknown as Readonly<Record<StillLocation, readonly StillSlot[]>>;

export const PREFETCH_TIER1_GROUPS: ReadonlySet<ClipGroup> = new Set(
  rawCatalog.prefetch_tier1_groups as unknown as ClipGroup[],
);

export const CLIP_ENTRY_BY_ID: ReadonlyMap<ClipSlot, ClipCatalogEntry> = new Map(
  CLIP_CATALOG.map((entry) => [entry.id, entry]),
);

export const ONE_SHOT_CLIPS: ReadonlySet<ClipSlot> = new Set(
  CLIP_CATALOG.filter((entry) => entry.kind === "one_shot").map((entry) => entry.id),
);

export const CLIPS_BY_GROUP: ReadonlyMap<ClipGroup, readonly ClipSlot[]> = (() => {
  const map = new Map<ClipGroup, ClipSlot[]>();
  for (const entry of CLIP_CATALOG) {
    if (entry.reserved) continue;
    const list = map.get(entry.group) ?? [];
    list.push(entry.id);
    map.set(entry.group, list);
  }
  return map;
})();

const CLIP_SLOT_SET: ReadonlySet<string> = new Set(CLIP_SLOTS);
const STILL_SLOT_SET: ReadonlySet<string> = new Set(STILL_SLOTS);

export function isCatalogClipSlot(value: string): value is ClipSlot {
  return CLIP_SLOT_SET.has(value);
}

export function isStillSlot(value: string): value is StillSlot {
  return STILL_SLOT_SET.has(value);
}

export function resolveStillForLocation(
  location: StillLocation,
  stills: Partial<Record<StillSlot, string>> | undefined,
  anchorImage: string,
): { still: StillSlot | "anchor"; url: string } {
  const candidates = STILL_LOCATIONS[location] ?? [];
  if (stills) {
    for (const candidate of candidates) {
      const url = stills[candidate];
      if (url) return { still: candidate, url };
    }
  }
  return { still: "anchor", url: anchorImage };
}
