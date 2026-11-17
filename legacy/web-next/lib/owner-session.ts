let authenticated = false;
let channel: BroadcastChannel | null = null;
const listeners = new Set<(active: boolean) => void>();

function setActive(active: boolean, force = false) {
  if (!force && authenticated === active) return;
  authenticated = active;
  for (const listener of listeners) listener(active);
}

function sessionChannel() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel("companion-space-owner-session");
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data === "owner-session-cleared") setActive(false, true);
    });
  }
  return channel;
}

export function hasOwnerSession() {
  return authenticated;
}

export function markOwnerSessionAuthenticated() {
  sessionChannel();
  setActive(true);
}

export function clearOwnerSessionToken({ notifyOtherTabs = false } = {}) {
  setActive(false, true);
  if (notifyOtherTabs) sessionChannel()?.postMessage("owner-session-cleared");
}

export function subscribeOwnerSession(listener: (active: boolean) => void) {
  sessionChannel();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
