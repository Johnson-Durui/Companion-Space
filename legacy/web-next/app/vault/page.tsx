import { VaultPanel } from "@/components/vault-panel";

export default async function VaultPage({ searchParams }: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  let returnHref: string | undefined;
  if (typeof returnTo === "string" && /^\/spaces\/[\w-]+\/call(?:\?|$)/.test(returnTo)) {
    const target = new URL(returnTo, "https://companion.invalid");
    if (target.origin === "https://companion.invalid" && /^\/spaces\/[\w-]+\/call$/.test(target.pathname)) {
      const query = new URLSearchParams();
      const session = target.searchParams.get("session");
      if (session && /^[\w-]{1,128}$/.test(session)) query.set("session", session);
      if (target.searchParams.get("view") === "immersive") query.set("view", "immersive");
      returnHref = `${target.pathname}${query.size ? `?${query}` : ""}`;
    }
  }
  return <VaultPanel returnHref={returnHref} />;
}
