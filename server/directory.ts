import { demoMemberships, demoStudioOwnerEmail, demoStudioOwnerId, demoViewerEmail, demoViewerId } from "@/db/fixtures/cadence-demo";

/**
 * Looks up a user's email for notifications. In production this reads the users table. The fixture
 * version covers the seeded users only, so any other user receives nothing.
 */
const EMAILS: Record<string, string> = {
  [demoViewerId]: demoViewerEmail,
  [demoStudioOwnerId]: demoStudioOwnerEmail,
};

export function emailFor(userId: string): string | undefined {
  return EMAILS[userId];
}

/** Studio members who should hear about studio-facing events: owners and admins only. */
export function studioNotifiees(studioId: string): string[] {
  return demoMemberships
    .filter((m) => m.studioId === studioId && (m.role === "owner" || m.role === "admin"))
    .map((m) => m.userId);
}
