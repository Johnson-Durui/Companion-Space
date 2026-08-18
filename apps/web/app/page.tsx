import { DashboardShell } from "@/components/dashboard-shell";

export default function HomePage() {
  const displayName = process.env.APP_DISPLAY_NAME?.trim() || "Companion Space";
  return <DashboardShell displayName={displayName} />;
}
