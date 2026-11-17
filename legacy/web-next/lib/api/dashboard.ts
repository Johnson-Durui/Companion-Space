import type { DashboardSnapshot } from "@/lib/types";
import { getVaultStatus } from "./vault";
import { listSpaces } from "./spaces";
import { listProviders } from "./providers";
import { listCharacters } from "./characters";
import { listSessions } from "./sessions";

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [vault, spaces, providers, characters, sessions] = await Promise.all([
    getVaultStatus(),
    listSpaces(),
    listProviders(),
    listCharacters(),
    listSessions(),
  ]);

  return {
    vault,
    spaces,
    providers,
    characters,
    sessions,
  };
}
