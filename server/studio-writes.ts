import { recordEvent } from "@/server/events";
import { randomUUID } from "node:crypto";
import {
  demoProjects,
  demoProposals,
  type FixtureMilestone,
  type FixtureProject,
} from "@/db/fixtures/cadence-demo";
import { canWrite } from "@/lib/authz";
import { toMinor, type CreateProposalInput } from "@/lib/validation/proposal";
import { getStudioMembership } from "@/server/studio";

/**
 * Studio write operations. Each one checks membership, then role, then ownership of the
 * project. A failed check returns a message that is safe to show. It never says whether
 * another studio's project exists.
 *
 * DEVELOPMENT STORE. Writes go to the in-memory fixtures and reset on restart.
 */

export type WriteResult = { ok: true } | { ok: false; message: string };

function nextReference(): string {
  const highest = demoProjects.reduce((max, p) => {
    const n = Number(p.reference.slice(-3));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `CAD-2026-${String(highest + 1).padStart(3, "0")}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function createDraftProposal(
  userId: string,
  input: CreateProposalInput,
): Promise<{ ok: true; projectId: string } | { ok: false; message: string }> {
  const membership = await getStudioMembership(userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot create proposals." };

  const projectId = `prj_${randomUUID().slice(0, 12)}`;
  const proposalId = `prp_${randomUUID().slice(0, 12)}`;
  const milestones: FixtureMilestone[] = input.milestones.map((m, i) => ({
    position: i + 1,
    title: m.title,
    description: m.description || undefined,
    amountMinor: toMinor(m.amount),
    status: "upcoming",
    dueDate: m.dueDate || undefined,
  }));

  const project: FixtureProject = {
    id: projectId,
    studioId: membership.studioId,
    reference: nextReference(),
    title: input.title,
    studioName: membership.studioName,
    clientName: input.clientName,
    currency: input.currency,
    stage: "proposal",
    contactUserIds: [],
    milestones,
  };
  demoProjects.push(project);
  demoProposals.push({
    id: proposalId,
    projectId,
    version: 0,
    issuedOn: "",
    revisionTerms: input.revisionTerms,
    status: "draft",
  });
  recordEvent({ projectId, kind: "proposal_drafted", actor: "studio", summary: "Draft proposal created" });
  return { ok: true, projectId };
}

/**
 * Sends the project's draft proposal to the client. Needs at least one contact, because
 * the client sees a proposal only through a project they are listed on. Client invitations
 * are not built yet, so the contact must already exist.
 */
export async function sendProposal(userId: string, projectId: string): Promise<WriteResult> {
  const membership = await getStudioMembership(userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot send proposals." };

  const project = demoProjects.find((p) => p.id === projectId && p.studioId === membership.studioId);
  if (!project) return { ok: false, message: "Project not found." };
  if (project.stage !== "proposal") return { ok: false, message: "This project has already moved past proposal." };

  const draft = demoProposals.find((p) => p.projectId === projectId && p.status === "draft");
  if (!draft) return { ok: false, message: "There is no draft to send." };
  if (project.contactUserIds.length === 0) {
    return { ok: false, message: "Add a client contact before sending. Client invitations are not built yet." };
  }

  const priorVersion = Math.max(
    0,
    ...demoProposals.filter((p) => p.projectId === projectId && p.status !== "draft").map((p) => p.version),
  );
  draft.version = priorVersion + 1;
  draft.status = "sent";
  draft.issuedOn = todayIso();
  recordEvent({ projectId, kind: "proposal_sent", actor: "studio", summary: `Proposal version ${draft.version} sent` });
  return { ok: true };
}
