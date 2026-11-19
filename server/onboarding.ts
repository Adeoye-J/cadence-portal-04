import { randomUUID } from "node:crypto";
import { demoMemberships, demoStudios } from "@/db/fixtures/cadence-demo";

/**
 * Sign-up details wait here between the sign-up form and the first sign-in, then become a studio.
 * Entries expire after 30 minutes and are removed when used.
 *
 * DEVELOPMENT STORE. Pending sign-ups and new studios live in memory and reset on restart.
 */

const TTL_MS = 30 * 60 * 1000;

export type PendingSignup = {
  email: string;
  fullName: string;
  studioName: string;
  country: string;
  currency: "USD" | "NGN";
  createdAt: string;
};

const pending = new Map<string, PendingSignup>();

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function recordPendingSignup(input: Omit<PendingSignup, "email" | "createdAt">, email: string, now: Date = new Date()): void {
  const key = normaliseEmail(email);
  pending.set(key, { ...input, email: key, createdAt: now.toISOString() });
}

function fresh(entry: PendingSignup, now: Date): boolean {
  return now.getTime() - new Date(entry.createdAt).getTime() < TTL_MS;
}

/** True when a fresh sign-up is waiting for this email. Does not consume it. */
export function hasPendingSignup(email: string, now: Date = new Date()): PendingSignup | null {
  const entry = pending.get(normaliseEmail(email));
  return entry && fresh(entry, now) ? entry : null;
}

/** Takes the pending sign-up for an email, removing it. Null when none is waiting or it has expired. */
export function takePendingSignup(email: string, now: Date = new Date()): PendingSignup | null {
  const key = normaliseEmail(email);
  const entry = pending.get(key);
  pending.delete(key);
  return entry && fresh(entry, now) ? entry : null;
}

/** Creates the studio and makes the signed-in user its owner. Returns the new studio's id. */
export function createStudioFor(userId: string, studioName: string): { studioId: string; name: string } {
  const studioId = `stu_${randomUUID().slice(0, 12)}`;
  demoStudios.push({ id: studioId, name: studioName });
  demoMemberships.push({ studioId, userId, role: "owner" });
  return { studioId, name: studioName };
}
