import { recordEvent } from "@/server/events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { demoProjects } from "@/db/fixtures/cadence-demo";
import type { Currency, ProjectStage } from "@/db/schema";
import { canWrite } from "@/lib/authz";
import { getStudioMembership } from "@/server/studio";

/**
 * Client invitations. The token is random, shown once in the email, and stored only as a
 * SHA-256 hash. An invitation is single use and expires after 14 days. Accepting it
 * requires a signed-in session whose email matches the invited address.
 *
 * DEVELOPMENT STORE. Invitations live in memory and reset on restart.
 */

export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type Invitation = {
  id: string;
  projectId: string;
  email: string;
  tokenHash: string;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revoked: boolean;
};

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

const invitations: Invitation[] = [];

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function findUsable(token: string, now: Date): Invitation | undefined {
  const digest = hashToken(token);
  return invitations.find(
    (i) => i.tokenHash === digest && !i.revoked && !i.acceptedAt && new Date(i.expiresAt) > now,
  );
}

export function statusOf(invitation: Invitation, now: Date): InvitationStatus {
  if (invitation.revoked) return "revoked";
  if (invitation.acceptedAt) return "accepted";
  if (new Date(invitation.expiresAt) <= now) return "expired";
  return "pending";
}

export type InviteResult =
  | { ok: true; invitationId: string; token: string; email: string; projectTitle: string; studioName: string }
  | { ok: false; message: string };

/** Creates an invitation for a studio member with write access. The caller sends the email. */
export async function inviteClient(
  userId: string,
  projectId: string,
  rawEmail: string,
  now: Date = new Date(),
): Promise<InviteResult> {
  const membership = await getStudioMembership(userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot invite clients." };

  const project = demoProjects.find((p) => p.id === projectId && p.studioId === membership.studioId);
  if (!project) return { ok: false, message: "Project not found." };

  const token = randomBytes(32).toString("base64url");
  const invitation: Invitation = {
    id: randomUUID(),
    projectId: project.id,
    email: normaliseEmail(rawEmail),
    tokenHash: hashToken(token),
    invitedByUserId: userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
    revoked: false,
  };
  invitations.push(invitation);
  recordEvent({ projectId: project.id, kind: "invitation_sent", actor: "studio", summary: "Client invitation sent" });
  return {
    ok: true,
    invitationId: invitation.id,
    token,
    email: invitation.email,
    projectTitle: project.title,
    studioName: membership.studioName,
  };
}

/** Revokes an invitation whose email could not be sent, so the link cannot be used unseen. */
export function revokeInvitation(invitationId: string): void {
  const invitation = invitations.find((i) => i.id === invitationId);
  if (invitation) invitation.revoked = true;
}

export type InvitationPreview = {
  projectTitle: string;
  studioName: string;
  clientName: string;
  email: string;
  reference: string;
  stage: ProjectStage;
  currency: Currency;
  milestones: { position: number; title: string; amountMinor: number; dueDate?: string }[];
};

/** What the invitation page shows before sign-in. Null for an invalid, used, expired or revoked link. */
export function previewInvitation(token: string, now: Date = new Date()): InvitationPreview | null {
  const invitation = findUsable(token, now);
  if (!invitation) return null;
  const project = demoProjects.find((p) => p.id === invitation.projectId);
  if (!project) return null;
  return {
    projectTitle: project.title,
    studioName: project.studioName,
    clientName: project.clientName,
    email: invitation.email,
    reference: project.reference,
    stage: project.stage,
    currency: project.currency,
    milestones: project.milestones.map((m) => ({
      position: m.position,
      title: m.title,
      amountMinor: m.amountMinor,
      dueDate: m.dueDate,
    })),
  };
}

export type AcceptResult = { ok: true } | { ok: false; reason: "invalid" | "email_mismatch" };

/** Adds the signed-in viewer as a contact on the project. Single use. The email must match. */
export function acceptInvitation(
  token: string,
  viewer: { userId: string; email: string },
  now: Date = new Date(),
): AcceptResult {
  const invitation = findUsable(token, now);
  if (!invitation) return { ok: false, reason: "invalid" };
  if (normaliseEmail(viewer.email) !== invitation.email) return { ok: false, reason: "email_mismatch" };
  const project = demoProjects.find((p) => p.id === invitation.projectId);
  if (!project) return { ok: false, reason: "invalid" };
  if (!project.contactUserIds.includes(viewer.userId)) project.contactUserIds.push(viewer.userId);
  invitation.acceptedAt = now.toISOString();
  recordEvent({ projectId: project.id, kind: "invitation_accepted", actor: "client", summary: "Client contact accepted the invitation" });
  return { ok: true };
}

export type InvitationRow = { id: string; email: string; createdAt: string; status: InvitationStatus };

/** Invitations for one project, newest first. The caller has already checked studio access. */
export function listInvitations(projectId: string, now: Date = new Date()): InvitationRow[] {
  return invitations
    .filter((i) => i.projectId === projectId)
    .map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt, status: statusOf(i, now) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
