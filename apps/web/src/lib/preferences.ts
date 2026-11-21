/**
 * The round trip that keeps how the app looks from being lost.
 *
 * Asked for on 2026-11-21, and the reason is worth keeping: one of the two
 * clears their browser every day. The theme, the text size and the ledger's
 * density were in `localStorage` and nowhere else, so every morning the app
 * greeted them in a theme and a size they had not chosen - "I'd like to store
 * the user preferences in the server and load on login. Then we don't lose the
 * theme, font size or view settings."
 *
 * ## Who wins
 *
 * The server on arrival, the device on every change after that.
 *
 * On sign-in the stored answer is adopted, because that is the whole point:
 * the browser may have just been wiped and have nothing to say. The one
 * exception is a person who has never chosen anything, which the server
 * reports as `preferences: null` rather than as a set of defaults. That
 * difference is load-bearing. Without it, the first load after this shipped
 * would reset a phone that already had Night at the smallest size back to
 * Daylight at the largest - so `null` means "nothing stored yet", and whatever
 * that browser already had goes up to become the stored answer.
 *
 * After that, a tap on this device is the newest fact there is and goes
 * straight up. Two devices disagreeing resolves to last-one-wins, which is
 * the only honest answer: each of them did choose, and both were right.
 *
 * ## What is not done here
 *
 * Applying the choice belongs to `appearance.ts`, which puts it on `<html>`
 * and into `localStorage`. `localStorage` is still read before the first paint
 * by the inline script in `index.html`, and is still the only thing that can
 * be - so a browser that was cleared shows one frame of the default theme
 * before the session lands and this corrects it. That frame is the cost of
 * keeping no figures on the device, and it is one frame.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  DENSITIES,
  THEMES,
  getAppearance,
  scaleForTextSize,
  setAppearance,
  textSizeKeyFor,
  useAppearanceValue,
  type Appearance,
  type Density,
  type ThemeChoice,
} from "./appearance.js";
import { api } from "./api.js";
import { sessionQueryKey, useSession, type SessionResponse } from "./session.js";

/** What the server stores: three short names, and never a multiplier. */
export interface PreferencesWire {
  readonly theme: string;
  readonly textSize: string;
  readonly ledgerDensity: string;
}

const THEME_KEYS = new Set<string>(THEMES.map((theme) => theme.key));
const DENSITY_KEYS = new Set<string>(DENSITIES.map((density) => density.key));

/**
 * The stored answer, read against this build's own tables.
 *
 * Anything this build does not recognise falls back to what the device
 * already has rather than to the global default. A value stored by a NEWER
 * build - the other phone updated first and chose a theme this one has never
 * heard of - should leave this phone looking the way it already did, not
 * reset it to Daylight.
 */
export function appearanceFromWire(wire: PreferencesWire, fallback: Appearance): Appearance {
  return {
    theme: THEME_KEYS.has(wire.theme) ? (wire.theme as ThemeChoice) : fallback.theme,
    scale: scaleForTextSize(wire.textSize),
    density: DENSITY_KEYS.has(wire.ledgerDensity)
      ? (wire.ledgerDensity as Density)
      : fallback.density,
  };
}

/** The same thing the other way, for sending. */
export function wireFromAppearance(appearance: Appearance): PreferencesWire {
  return {
    theme: appearance.theme,
    textSize: textSizeKeyFor(appearance.scale),
    ledgerDensity: appearance.density,
  };
}

/**
 * Store the choice against the person.
 *
 * The route takes neither a version nor an idempotency key, which is the one
 * place in this app that is true; `apps/api/src/routes/auth.ts` has the
 * reasoning beside it. The client sends a key anyway, because every write from
 * `api.ts` does and uniformity there is worth more than the four bytes.
 */
export function useSavePreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (changes: Partial<PreferencesWire>) =>
      api.patch<{ preferences: PreferencesWire }>("/api/me/preferences", changes),
    onSuccess: (result) => {
      /*
       * Written into the session rather than invalidated. An invalidation
       * would refetch `/api/me` - the household, every member, the lot - to
       * learn something this response has already said.
       */
      queryClient.setQueryData<SessionResponse | null>(sessionQueryKey, (previous) =>
        previous ? { ...previous, preferences: result.preferences } : previous,
      );
    },
  });
}

/**
 * Keep the stored choice and this device in step. Mounted once, in `App`.
 *
 * `enabled` is false until somebody is signed in: there is nobody to store
 * anything against, and the sign-in screen should look however this browser
 * last looked.
 */
export function useAppearanceSync(enabled: boolean): void {
  const session = useSession();
  const appearance = useAppearanceValue();
  const save = useSavePreferences();

  /** The last payload this device sent or accepted, so neither is echoed. */
  const settledRef = useRef<string | null>(null);
  /**
   * Whose settings have been adopted, rather than whether any have.
   *
   * It was a boolean, which was wrong for the case that actually happens on a
   * shared phone: one of them signs out and the other signs in, in the same
   * tab, so `App` never unmounts and this hook never remounts. A boolean had
   * already been set by the first person, so the second person's stored
   * theme was ignored and they got whatever the phone was left looking like.
   */
  const adoptedForRef = useRef<string | null>(null);
  const userId = session.data?.user.id ?? null;

  /* ---- 1. Adopt what is stored, once per person, when the session arrives ---- */
  useEffect(() => {
    if (!enabled || userId === null) return;
    if (adoptedForRef.current === userId) return;

    const stored = session.data?.preferences;
    // Still loading, or a response from a build that did not send them yet:
    // nothing has been said either way, so nothing is done.
    if (stored === undefined) return;

    adoptedForRef.current = userId;
    settledRef.current = null;

    /*
     * Never chosen. `settledRef` stays null, so the effect below sends
     * whatever this browser already had - which is how a device that is
     * already set up seeds the server instead of being reset by it.
     */
    if (stored === null) return;

    const next = appearanceFromWire(stored, getAppearance());
    settledRef.current = JSON.stringify(wireFromAppearance(next));
    setAppearance(next);
  }, [enabled, userId, session.data]);

  /* ---- 2. Send anything that changes after that ---- */
  const send = save.mutate;
  useEffect(() => {
    if (!enabled || adoptedForRef.current === null) return;

    const payload = wireFromAppearance(appearance);
    const asText = JSON.stringify(payload);
    if (settledRef.current === asText) return;

    settledRef.current = asText;
    send(payload, {
      onError: () => {
        /*
         * Nothing to tell anybody. The choice applies on this device either
         * way, and it is a theme - an error banner over the ledger would be
         * worse than the thing it is reporting. Forgetting that it was sent
         * is what lets the next change try again.
         */
        settledRef.current = null;
      },
    });
  }, [enabled, appearance, send]);
}
