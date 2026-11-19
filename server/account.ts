/**
 * Account deletion requests. A request is recorded and then handled by a person. Nothing is deleted
 * automatically yet. The record is kept so a repeat request does not create a second one.
 *
 * DEVELOPMENT STORE. Requests live in memory and reset on restart.
 */
const requests = new Map<string, string>();

export function requestAccountDeletion(userId: string, now: Date = new Date()): { requestedAt: string; alreadyRequested: boolean } {
  const existing = requests.get(userId);
  if (existing) return { requestedAt: existing, alreadyRequested: true };
  const requestedAt = now.toISOString();
  requests.set(userId, requestedAt);
  return { requestedAt, alreadyRequested: false };
}

export function accountDeletionStatus(userId: string): string | null {
  return requests.get(userId) ?? null;
}
