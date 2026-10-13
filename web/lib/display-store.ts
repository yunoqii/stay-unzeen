"use client";

// Display currency pick (localStorage, this browser only) and the public display rates, polled in the
// background once a minute while anything on the page shows a converted figure. The poll is the same public
// request for every visitor and never follows a user action, so it says nothing about what anyone does.

import { useMemo, useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/api/client";
import { DEFAULT_DISPLAY, makeDisplay, parseRates, ratesFromPool, type Display, type DisplayPref, type DisplayRates } from "@/lib/display";
import { getNetwork, subscribeNetwork, useNetwork, type Network } from "@/lib/network";
import { useNative } from "@/lib/chain";

// ---- display pick ----

const PREF_KEY = "unzeen.display";
let pref: DisplayPref | null = null;
const prefListeners = new Set<() => void>();

function readPref(): DisplayPref {
  if (typeof window === "undefined") return DEFAULT_DISPLAY;
  try {
    return window.localStorage.getItem(PREF_KEY) === "native" ? "native" : DEFAULT_DISPLAY;
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function getDisplayPref(): DisplayPref {
  if (pref === null) pref = readPref();
  return pref;
}

export function setDisplayPref(next: DisplayPref) {
  if (next === getDisplayPref()) return;
  pref = next;
  try {
    window.localStorage.setItem(PREF_KEY, next);
  } catch {
    /* private mode: keep in memory */
  }
  prefListeners.forEach((l) => l());
}

function subscribePref(l: () => void): () => void {
  prefListeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PREF_KEY) {
      pref = readPref();
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDisplayPref(): DisplayPref {
  return useSyncExternalStore(subscribePref, getDisplayPref, () => DEFAULT_DISPLAY);
}

// ---- display rates ----

export const RATES_POLL_MS = 60_000;

interface RatesState {
  network: Network;
  rates: DisplayRates | null;
  /** First answer not in yet. */
  loading: boolean;
}

const INITIAL: RatesState = { network: "devnet", rates: null, loading: true };
let state: RatesState = INITIAL;
const rateListeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let unNetwork: (() => void) | undefined;
let seq = 0;

function emit(next: RatesState) {
  state = next;
  rateListeners.forEach((l) => l());
}

/** GET /api/rates; a server without it (404) or without the field: PoolInfo.rates, then the pool's mid rate. */
async function fetchRates(): Promise<DisplayRates | null> {
  try {
    const r = parseRates(await api.getRates());
    if (r) return r;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
  }
  return ratesFromPool(await api.getPool());
}

async function poll() {
  const id = ++seq;
  const network = getNetwork();
  try {
    const rates = await fetchRates();
    if (id !== seq) return;
    // Keep the last good rate through a failed refresh; drop it only when the network changed.
    emit({ network, rates: rates ?? (state.network === network ? state.rates : null), loading: false });
  } catch {
    if (id !== seq) return;
    emit({ network, rates: state.network === network ? state.rates : null, loading: false });
  }
}

function start() {
  state = { network: getNetwork(), rates: null, loading: true };
  void poll();
  timer = setInterval(() => void poll(), RATES_POLL_MS);
  unNetwork = subscribeNetwork(() => {
    emit({ network: getNetwork(), rates: null, loading: true });
    void poll();
  });
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  unNetwork?.();
  unNetwork = undefined;
  seq++;
}

function subscribeRates(l: () => void): () => void {
  rateListeners.add(l);
  if (rateListeners.size === 1) start();
  return () => {
    rateListeners.delete(l);
    if (rateListeners.size === 0) stop();
  };
}

const getRatesState = () => state;
const getServerRatesState = () => INITIAL;

/** Public display rates of the selected network, refreshed every 60 s in the background. */
export function useRates(): RatesState {
  const s = useSyncExternalStore(subscribeRates, getRatesState, getServerRatesState);
  const network = useNetwork();
  return s.network === network ? s : { network, rates: null, loading: true };
}

/** The current display: unit, conversions, "≈" flags. */
export function useDisplay(): Display {
  const p = useDisplayPref();
  const { rates, loading } = useRates();
  const native = useNative().symbol;
  return useMemo(() => makeDisplay(p, rates, loading, native), [p, rates, loading, native]);
}
