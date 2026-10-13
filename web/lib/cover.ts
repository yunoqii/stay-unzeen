// R8 cover traffic (docs/analysis/chat.md §5.4, R8): while a tab is open and visible, an empty signed
// `op:"noop"` POST /api/actions every 1-3 minutes, exactly 1024 bytes like every buy / sell / chat. A
// network observer then sees a steady trickle of identical POSTs from everyone and cannot pick out the
// ones that were a trade or a chat message (intersection attack).
//
// How to switch it off:
//   - server: drop PoolInfo.features.noop (the client sends nothing without it);
//   - build: NEXT_PUBLIC_COVER_TRAFFIC=0;
//   - one browser (debugging): localStorage.setItem("unzeen.cover", "off").

export const COVER_MIN_MS = 60_000;
export const COVER_SPREAD_MS = 120_000;
export const COVER_BUILD_ON = process.env.NEXT_PUBLIC_COVER_TRAFFIC !== "0";
export const COVER_STORAGE_KEY = "unzeen.cover";

/** 60-180 s, uniform: no rhythm to lock on to. */
export const nextCoverDelay = (random: () => number = Math.random): number => COVER_MIN_MS + Math.floor(random() * COVER_SPREAD_MS);

export function coverOffHere(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(COVER_STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

/** Whether this tab should send cover traffic at all. */
export function coverEnabled(serverOn: boolean | undefined): boolean {
  return COVER_BUILD_ON && serverOn === true && !coverOffHere();
}
