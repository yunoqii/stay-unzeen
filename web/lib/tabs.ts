import type { KeyboardEvent } from "react";

/**
 * Keyboard for a role="tablist" (WAI-ARIA tabs, automatic activation): ←/→ (and ↑/↓) move to the
 * neighbouring tab and select it, Home/End jump to the ends. Pair with a roving tabIndex on the tabs
 * (selected = 0, others = -1) so Tab enters the list once and leaves it.
 * Tabs with aria-disabled="true" are skipped unless `includeDisabled` (a tab that explains itself on click).
 */
export function onTabListKeyDown(e: KeyboardEvent<HTMLElement>, includeDisabled = false) {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (t) => includeDisabled || t.getAttribute("aria-disabled") !== "true",
  );
  if (tabs.length === 0) return;
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  const last = tabs.length - 1;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowRight" || e.key === "ArrowDown" ? (i < 0 || i === last ? 0 : i + 1) : i <= 0 ? last : i - 1;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
