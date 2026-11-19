import { recordEvent } from "@/server/events";
import { createHash } from "node:crypto";
import {
  demoProjects,
  demoProposals,
  type FixtureProject,
  type FixtureProposal,
} from "@/db/fixtures/cadence-demo";

/**
 * Data access for proposals and sign-off.
 *
 * Every function checks that the viewer is a contact on the project before it
 * reads or writes. Missing and forbidden both return null or not_found, so a
 * caller cannot probe for IDs.
 *
 * DEVELOPMENT STORE. Writes go to in-memory fixtures. They reset on restart
 * and are not shared between server instances. Replace with Drizzle
 * transactions (db/schema.ts) before any real use.
 */

export type Signature = {
  proposalId: string;
  signerUserId: string;
  typedName: string;
  documentSha256: string;
  signedAt: string;
};

export type ProposalView = {
  project: FixtureProject;
  proposal: FixtureProposal;
  signature: Signature | undefined;
};

const signatures = new Map<string, Signature>();

function findAuthorised(viewerUserId: string, proposalId: string) {
  const proposal = demoProposals.find((p) => p.id === proposalId);
  if (!proposal) return null;
  const project = demoProjects.find((p) => p.id === proposal.projectId);
  if (!project || !project.contactUserIds.includes(viewerUserId)) return null;
  return { project, proposal };
}

/**
 * SHA-256 over the terms being signed: reference, version, milestones and
 * revision terms. Key order is fixed, so the same terms always give the same digest.
 */
export function documentDigest(project: FixtureProject, proposal: FixtureProposal): string {
  const canonical = JSON.stringify({
    reference: project.reference,
    version: proposal.version,
    title: project.title,
    currency: project.currency,
    milestones: project.milestones.map((m) => ({
      position: m.position,
      title: m.title,
      amountMinor: m.amountMinor,
      description: m.description ?? null,
    })),
    revisionTerms: proposal.revisionTerms,
    revisionRounds: proposal.revisionRounds ?? null,
    termsLabel: proposal.termsLabel ?? null,
    startOn: proposal.startOn ?? null,
    endOn: proposal.endOn ?? null,
    deliverables: (proposal.deliverables ?? []).map((d) => ({
      code: d.code,
      title: d.title,
      description: d.description,
      hours: d.hours,
      reviewNote: d.reviewNote,
      targetDate: d.targetDate,
      items: d.items,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function getProposalView(viewerUserId: string, proposalId: string): Promise<ProposalView | null> {
  const found = findAuthorised(viewerUserId, proposalId);
  if (!found) return null;
  return {
    ...found,
    signature: signatures.get(proposalId),
  };
}

export type SignResult =
  | { ok: true; signature: Signature }
  | { ok: false; reason: "not_found" | "already_signed" | "not_sent"; message: string };

/**
 * Records a sign-off. Idempotent for the same signer: a repeat submit returns the
 * existing signature. A different contact cannot sign a proposal that is already signed.
 * On success the project moves to the Signed stage and milestone 1 becomes payment due.
 */
export async function signProposal(
  viewerUserId: string,
  proposalId: string,
  typedName: string,
): Promise<SignResult> {
  const found = findAuthorised(viewerUserId, proposalId);
  if (!found) return { ok: false, reason: "not_found", message: "Proposal not found." };
  const { project, proposal } = found;

  const existing = signatures.get(proposalId);
  if (existing) {
    if (existing.signerUserId === viewerUserId) return { ok: true, signature: existing };
    return { ok: false, reason: "already_signed", message: "This proposal has already been signed." };
  }
  if (proposal.status !== "sent") {
    return { ok: false, reason: "not_sent", message: "This proposal is not open for signing." };
  }

  const signature: Signature = {
    proposalId,
    signerUserId: viewerUserId,
    typedName,
    documentSha256: documentDigest(project, proposal),
    signedAt: new Date().toISOString(),
  };
  signatures.set(proposalId, signature);
  proposal.status = "signed";
  project.stage = "signed";
  recordEvent({ projectId: project.id, kind: "proposal_signed", actor: "client", summary: "Proposal signed" });
  const first = project.milestones.find((m) => m.position === 1);
  if (first) first.status = "payment_due";
  return { ok: true, signature };
}
