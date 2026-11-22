import t from "../../locales/zh-CN.json";

export interface PlanWhyData {
  kp_id: string;
  kp_name?: string;
  weight: number;
  mastery: number;
  highlighted?: boolean;
  is_prereq?: boolean;
}

export type WeightLevel = "high" | "mid" | "low";
export type MasteryLevel = "unseen" | "learning" | "shaky" | "mastered";

export function weightLevel(weight: number): WeightLevel {
  if (weight >= 0.2) return "high";
  if (weight >= 0.08) return "mid";
  return "low";
}

export function weightLabel(weight: number): string {
  const level = weightLevel(weight);
  if (level === "high") return t.today.weightHigh;
  if (level === "mid") return t.today.weightMid;
  return t.today.weightLow;
}

export function masteryLevel(mastery: number): MasteryLevel {
  if (mastery >= 0.8) return "mastered";
  if (mastery >= 0.5) return "shaky";
  if (mastery >= 0.15) return "learning";
  return "unseen";
}

export function masteryLabel(mastery: number): string {
  const level = masteryLevel(mastery);
  if (level === "mastered") return t.today.masteryMastered;
  if (level === "shaky") return t.today.masteryShaky;
  if (level === "learning") return t.today.masteryLearning;
  return t.today.masteryUnseen;
}

export function buildPlanWhySentence(entry: PlanWhyData): string {
  const tpl = t.planView.whyTemplates;
  if (entry.highlighted) return tpl.highlighted;
  const highWeight = entry.weight >= 0.15;
  const lowMastery = entry.mastery < 0.6;
  if (highWeight && lowMastery) return tpl.highWeightLowMastery;
  if (highWeight && !lowMastery) return tpl.highWeightHighMastery;
  if (!highWeight && lowMastery && entry.is_prereq) return tpl.prereqLowMastery;
  if (lowMastery) return tpl.lowMastery;
  return tpl.steady;
}
