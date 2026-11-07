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
