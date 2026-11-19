import {
  demoMemberships,
  demoProjects,
  demoProposals,
  demoStudios,
  type FixtureProject,
  type FixtureProposal,
} from "@/db/fixtures/cadence-demo";
import type { Currency, MilestoneStatus, ProjectStage } from "@/db/schema";
import { retainerTotals } from "@/lib/milestones";

/**
 * Studio data access. Every function starts from the viewer's membership. A user who is not
 * a member of a studio gets null, never another studio's data.
 * Roles are read here but not yet enforced on writes; the proposal builder will add those checks.
 */

export type StudioRole = "owner" | "admin" | "member" | "viewer";

export type StudioMembership = { studioId: string; studioName: string; role: StudioRole };

export async function getStudioMembership(userId: string): Promise<StudioMembership | null> {
  const membership = demoMemberships.find((m) => m.userId === userId);
  if (!membership) return null;
  const studio = demoStudios.find((s) => s.id === membership.studioId);
  if (!studio) return null;
  return { studioId: studio.id, studioName: studio.name, role: membership.role };
}

export type StudioProjectRow = {
  id: string;
  reference: string;
  title: string;
  clientName: string;
  stage: ProjectStage;
  currency: Currency;
  remainingMinor: number;
  awaitingPayment: boolean;
};

/** Projects for the viewer's studio. Returns null when the viewer is not a member. */
export async function listStudioProjects(userId: string): Promise<StudioProjectRow[] | null> {
  const membership = await getStudioMembership(userId);
  if (!membership) return null;
  return demoProjects
    .filter((p) => p.studioId === membership.studioId)
    .map((p) => {
      const statuses: MilestoneStatus[] = p.milestones.map((m) => m.status);
      return {
        id: p.id,
        reference: p.reference,
        title: p.title,
        clientName: p.clientName,
        stage: p.stage,
        currency: p.currency,
        remainingMinor: retainerTotals(p.milestones).remainingMinor,
        awaitingPayment: statuses.includes("payment_due"),
      };
    });
}

export type StudioProjectDetail = {
  project: FixtureProject;
  /** The most recent proposal for the project: a draft, sent, or signed one. */
  proposal: FixtureProposal | undefined;
  membership: StudioMembership;
};

/** One project in the viewer's studio. Returns null for other studios' projects, so IDs cannot be probed. */
export async function getStudioProject(userId: string, projectId: string): Promise<StudioProjectDetail | null> {
  const membership = await getStudioMembership(userId);
  if (!membership) return null;
  const project = demoProjects.find((p) => p.id === projectId && p.studioId === membership.studioId);
  if (!project) return null;
  const proposal = demoProposals.filter((p) => p.projectId === projectId).at(-1);
  return { project, proposal, membership };
}
