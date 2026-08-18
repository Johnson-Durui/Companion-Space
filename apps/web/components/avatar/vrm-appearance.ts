import { getRuntimeRecipeView } from "@/components/avatar/vrm-recipe";
import type { CharacterRecipe } from "@/lib/types";

export type AvatarAppearanceSlot = "body" | "face" | "hairstyle" | "outfit" | "accessory";

export type AvatarAppearanceCapabilities = {
  slots: Record<AvatarAppearanceSlot, { recognized: number; selected: number }>;
  colorMaterialCount: number;
  colorMaterialSemantics: string[];
};

const SLOT_TOKENS = {
  body: {
    mini: ["body_mini", "body-mini", "mini", "body_petite", "body-petite", "petite", "body_a", "body-a"],
    tall: ["body_tall", "body-tall", "tall", "body_b", "body-b"],
  },
  face: {
    soft: ["face_soft", "face-soft", "soft"],
    sharp: ["face_sharp", "face-sharp", "sharp"],
    round: ["face_round", "face-round", "round"],
    serene: ["face_serene", "face-serene", "serene", "face_mischief", "face-mischief", "mischief"],
  },
  hairstyle: {
    twin_tail: ["hair_twin_tail", "hair-twin-tail", "twin_tail", "twintail"],
    short_bob: ["hair_short_bob", "hair-short-bob", "short_bob", "hair_bob", "hair-bob", "bob"],
    wolf_cut: ["hair_wolf_cut", "hair-wolf-cut", "wolf_cut", "hair_wolfcut", "hair-wolfcut", "wolfcut"],
    long_wave: ["hair_long_wave", "hair-long-wave", "long_wave", "hair_long", "hair-long", "longhair", "long_hair"],
    hime_cut: ["hair_hime_cut", "hair-hime-cut", "hime_cut", "hair_hime", "hair-hime", "hime"],
    high_ponytail: ["hair_high_ponytail", "hair-high-ponytail", "high_ponytail", "hair_ponytail", "hair-ponytail", "ponytail"],
  },
  outfit: {
    academy: ["outfit_academy", "outfit-academy", "academy", "outfit_uniform", "outfit-uniform", "uniform"],
    street: ["outfit_street", "outfit-street", "street"],
    studio: ["outfit_studio", "outfit-studio", "studio", "outfit_idol", "outfit-idol", "idol"],
    techwear: ["outfit_techwear", "outfit-techwear", "techwear"],
  },
} as const;

const ACCESSORY_TOKENS: Record<string, string[]> = {
  headphones: ["acc_headphones", "accessory_headphones", "headphones"],
  hair_clip: ["acc_hairclip", "accessory_hairclip", "hair_clip", "hairclip", "clip"],
  ribbon: ["acc_ribbon", "accessory_ribbon", "ribbon"],
  ear_cuff: ["acc_ear_cuff", "accessory_ear_cuff", "ear_cuff", "earcuff", "choker"],
  glasses: ["acc_glasses", "accessory_glasses", "glasses"],
  badge: ["acc_badge", "accessory_badge", "badge"],
};

const MATERIAL_SEMANTIC_TOKENS: Record<string, string[]> = {
  accent: ["accent", "trim", "line", "ornament", "ribbon", "halo"],
  eye: ["eye", "iris", "pupil"],
  hair: ["hair", "bang", "fringe"],
  outfit: ["cloth", "outfit", "uniform", "jacket", "shirt", "dress", "skirt", "pants", "coat"],
  skin: ["skin", "face", "body", "arm", "hand", "leg"],
};

function normalizeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function includesAny(normalizedName: string, tokens: readonly string[]) {
  return tokens.some((token) => normalizedName.includes(normalizeName(token)));
}

function matchMaterialSemantic(joinedName: string, token: string) {
  const normalizedToken = normalizeName(token);
  if (!normalizedToken) {
    return false;
  }
  if (normalizedToken.includes("_")) {
    return (
      joinedName === normalizedToken
      || joinedName.startsWith(`${normalizedToken}_`)
      || joinedName.endsWith(`_${normalizedToken}`)
      || joinedName.includes(`_${normalizedToken}_`)
    );
  }
  return joinedName.split("_").includes(normalizedToken);
}

function shadeColor(three: Record<string, unknown>, colorValue: string, factor: number) {
  const Color = three.Color as new (value?: string) => any;
  const color = new Color(colorValue);
  color.multiplyScalar(factor);
  return color;
}

function writeColorLike(target: unknown, color: { r: number; g: number; b: number }) {
  if (!target || typeof target !== "object") {
    return;
  }

  if ("setRGB" in target && typeof (target as { setRGB?: (r: number, g: number, b: number) => void }).setRGB === "function") {
    (target as { setRGB: (r: number, g: number, b: number) => void }).setRGB(color.r, color.g, color.b);
    return;
  }

  if ("copy" in target && typeof (target as { copy?: (source: unknown) => void }).copy === "function") {
    (target as { copy: (source: unknown) => void }).copy(color);
    return;
  }

  if (Array.isArray(target) && target.length >= 3) {
    target[0] = color.r;
    target[1] = color.g;
    target[2] = color.b;
  }
}

function applySemanticColor(three: Record<string, unknown>, material: Record<string, unknown>, hexColor: string, semantic: string) {
  const Color = three.Color as new (value?: string) => any;
  const color = new Color(hexColor);
  const shade = shadeColor(three, hexColor, semantic === "skin" ? 0.84 : 0.72);

  writeColorLike(material.color, color);
  writeColorLike(material.emissive, semantic === "accent" ? color : shade);

  const uniforms = material.uniforms as Record<string, { value?: unknown }> | undefined;
  if (uniforms) {
    writeColorLike(uniforms.litFactor?.value, color);
    writeColorLike(uniforms.shadeColorFactor?.value, shade);
    writeColorLike(uniforms.parametricRimColorFactor?.value, semantic === "accent" ? color : shade);
    writeColorLike(uniforms.rimColorFactor?.value, semantic === "accent" ? color : shade);
  }

  if (typeof material.needsUpdate === "boolean") {
    material.needsUpdate = true;
  }
}

function hasFaceToken(normalizedName: string) {
  return normalizedName === "face" || normalizedName.split("_").includes("face");
}

function hasPaintedSlotToken(normalizedName: string) {
  const parts = normalizedName.split("_");
  return (
    hasFaceToken(normalizedName)
    || parts.includes("hair")
    || parts.includes("cloth")
    || parts.includes("outfit")
  );
}

function hasAlbedoMap(material: Record<string, unknown>) {
  if (material.map) {
    return true;
  }
  const uniforms = material.uniforms as Record<string, { value?: unknown }> | undefined;
  return Boolean(
    uniforms?.map?.value
    || uniforms?.litMultiplyTexture?.value
    || uniforms?.shadeMultiplyTexture?.value
    || uniforms?.mainTex?.value,
  );
}

function isPaintedFaceMaterial(material: Record<string, unknown>) {
  const ownName = normalizeName(typeof material.name === "string" ? material.name : "");
  return hasFaceToken(ownName);
}

function shouldKeepPaintedAlbedo(material: Record<string, unknown>, meshName: string) {
  const ownName = normalizeName(typeof material.name === "string" ? material.name : "");
  const mesh = normalizeName(meshName);
  if (hasFaceToken(ownName) || hasFaceToken(mesh)) {
    return true;
  }
  return (hasPaintedSlotToken(ownName) || hasPaintedSlotToken(mesh)) && hasAlbedoMap(material);
}

function applyMaterialColors(three: Record<string, unknown>, material: unknown, meshName: string, recipe: CharacterRecipe | Record<string, unknown>) {
  if (!material || typeof material !== "object") {
    return null;
  }

  const runtimeRecipe = getRuntimeRecipeView(recipe);
  const namedMaterial = material as Record<string, unknown>;
  if (shouldKeepPaintedAlbedo(namedMaterial, meshName) || isPaintedFaceMaterial(namedMaterial)) {
    return null;
  }
  const materialName = normalizeName(
    [namedMaterial.name, meshName].filter((value): value is string => typeof value === "string").join("_"),
  );

  const colorEntries: Array<[semantic: string, hexColor: string]> = [
    ["skin", runtimeRecipe.skinTone],
    ["hair", runtimeRecipe.hairColor],
    ["eye", runtimeRecipe.eyeColor],
    ["outfit", runtimeRecipe.outfitColor],
    ["accent", runtimeRecipe.accentColor],
  ];

  for (const [semantic, hexColor] of colorEntries) {
    if ((MATERIAL_SEMANTIC_TOKENS[semantic] ?? []).some((token) => matchMaterialSemantic(materialName, token))) {
      applySemanticColor(three, namedMaterial, hexColor, semantic);
      return semantic;
    }
  }

  return null;
}

function matchSlotVisibility(normalizedName: string, slotMap: Record<string, readonly string[]>, selectedValue: string) {
  let matched = false;
  let visible = true;

  for (const [slotValue, tokens] of Object.entries(slotMap)) {
    if (!includesAny(normalizedName, tokens)) {
      continue;
    }
    matched = true;
    visible = slotValue === selectedValue;
    break;
  }

  return matched ? visible : null;
}

export function applyRecipeAppearance(root: { traverse?: (visitor: (node: Record<string, unknown>) => void) => void }, recipe: CharacterRecipe | Record<string, unknown>, three: Record<string, unknown>): AvatarAppearanceCapabilities {
  const runtimeRecipe = getRuntimeRecipeView(recipe);
  const selectedAccessories = new Set(runtimeRecipe.accessories);
  const slots: AvatarAppearanceCapabilities["slots"] = {
    body: { recognized: 0, selected: 0 },
    face: { recognized: 0, selected: 0 },
    hairstyle: { recognized: 0, selected: 0 },
    outfit: { recognized: 0, selected: 0 },
    accessory: { recognized: 0, selected: 0 },
  };
  const colorMaterials = new Set<object>();
  const colorMaterialSemantics = new Set<string>();

  root.traverse?.((node) => {
    const objectNode = node as Record<string, unknown> & {
      isMesh?: boolean;
      material?: unknown;
      name?: string;
      userData?: Record<string, unknown>;
      visible?: boolean;
    };

    const normalizedName = normalizeName(typeof objectNode.name === "string" ? objectNode.name : "");
    if (!normalizedName) {
      return;
    }

    const baseVisible =
      typeof objectNode.userData?.__runtimeBaseVisible === "boolean"
        ? objectNode.userData.__runtimeBaseVisible
        : typeof objectNode.visible === "boolean"
          ? objectNode.visible
          : true;

    if (objectNode.userData) {
      objectNode.userData.__runtimeBaseVisible = baseVisible;
    }

    let nextVisible: boolean | null = null;
    let matchedSlot: AvatarAppearanceSlot | null = null;
    for (const [slot, slotMap, selectedValue] of [
      ["body", SLOT_TOKENS.body, runtimeRecipe.body],
      ["face", SLOT_TOKENS.face, runtimeRecipe.face],
      ["hairstyle", SLOT_TOKENS.hairstyle, runtimeRecipe.hairstyle],
      ["outfit", SLOT_TOKENS.outfit, runtimeRecipe.outfit],
    ] as const) {
      nextVisible = matchSlotVisibility(normalizedName, slotMap, selectedValue);
      if (nextVisible !== null) {
        matchedSlot = slot;
        break;
      }
    }

    if (nextVisible === null) {
      for (const [accessoryId, tokens] of Object.entries(ACCESSORY_TOKENS)) {
        if (!includesAny(normalizedName, tokens)) {
          continue;
        }
        nextVisible = selectedAccessories.has(accessoryId);
        matchedSlot = "accessory";
        break;
      }
    }

    if (matchedSlot) {
      slots[matchedSlot].recognized += 1;
      if (nextVisible) {
        slots[matchedSlot].selected += 1;
      }
    }

    if (nextVisible !== null && typeof objectNode.visible === "boolean") {
      objectNode.visible = baseVisible && nextVisible;
    }

    if (objectNode.isMesh) {
      const materials = Array.isArray(objectNode.material) ? objectNode.material : [objectNode.material];
      for (const material of materials) {
        const semantic = applyMaterialColors(three, material, normalizedName, recipe);
        if (semantic) {
          colorMaterials.add(material as object);
          colorMaterialSemantics.add(semantic);
        }
      }
    }
  });

  return {
    slots,
    colorMaterialCount: colorMaterials.size,
    colorMaterialSemantics: [...colorMaterialSemantics].sort(),
  };
}
