/**
 * Who is signed in, and the household settings the engine needs locally.
 *
 * The web app runs the same `@headroom/core` engine as the server so edits
 * feel instant, but the server's answer is always the authoritative one
 * (HANDOFF section 9).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api.js";

export interface SessionUser {
  readonly id: string;
  readonly householdId: string;
  readonly name: string;
  readonly initial: string;
  readonly email: string;
  readonly colorFg: string;
  readonly colorBg: string;
}

export interface HouseholdMember {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly colorFg: string;
  readonly colorBg: string;
}

export interface Household {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  /** Cents, as a string: JSON has no bigint. */
  readonly cushionCents: string;
  readonly horizonRule: string;
  readonly horizonPaychequeCount: number;
  readonly weekendWithdrawalRule: "as_scheduled" | "friday_before" | "next_business_day";
  readonly version: number;
}

export interface SessionResponse {
  readonly user: SessionUser;
  readonly household: Household | null;
  readonly members: readonly HouseholdMember[];
  /**
   * How this person has asked the app to look, or null if they never have.
   *
   * Null is a real answer and not a stand-in for the defaults: it is what
   * tells a browser that already has a choice to send that up rather than be
   * reset by it. `preferences.ts` has the whole of the reasoning.
   *
   * Optional on the wire as well, so a response cached by an older build -
   * which carried no such field - reads as "nothing said" rather than as
   * "nothing chosen", and leaves the device alone.
   */
  readonly preferences?: {
    readonly theme: string;
    readonly textSize: string;
    readonly ledgerDensity: string;
  } | null;
}

export const sessionQueryKey = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: async (): Promise<SessionResponse | null> => {
      try {
        return await api.get<SessionResponse>("/api/me");
      } catch (error) {
        // Signed out is a normal state, not a failure to retry.
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.isUnauthenticated) return false;
      return failureCount < 2;
    },
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      api.post<{ user: SessionUser }>("/api/auth/login", credentials),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/api/auth/logout"),
    onSuccess: () => {
      // Drop every cached figure on sign-out: the next person at this phone
      // should not see the household's numbers.
      queryClient.clear();
      queryClient.setQueryData(sessionQueryKey, null);
    },
  });
}
