import { recordEvent } from "@/server/events";
import { randomUUID } from "node:crypto";
import { demoProjects, type FixtureMilestone, type FixtureProject } from "@/db/fixtures/cadence-demo";
import { canWrite } from "@/lib/authz";
import { nextStatus } from "@/lib/milestone-transitions";
import { getStudioMembership } from "@/server/studio";

/**
 * Milestone review: deliver (studio), approve or request changes (client).
 * Each write checks the actor, then the transition table, and only then changes state.
 *
 * DEVELOPMENT STORE. Change requests live in memory and reset on restart.
 */

export type ChangeRequest = {
  id: string;
  projectId: string;
  position: number;
  body: string;
  createdAt: string;
  reply?: { body: string; repliedAt: string };
};

const changeRequests: ChangeRequest[] = [];

export type MilestoneResult = { ok: true } | { ok: false; message: string };

function clientProject(viewerUserId: string, projectId: string): FixtureProject | null {
  const project = demoProjects.find((p) => p.id === projectId);
  if (!project || !project.contactUserIds.includes(viewerUserId)) return null;
  return project;
}

function studioProject(studioId: string, projectId: string): FixtureProject | null {
  return demoProjects.find((p) => p.id === projectId && p.studioId === studioId) ?? null;
}

function milestoneAt(project: FixtureProject, position: number): FixtureMilestone | undefined {
  return project.milestones.find((m) => m.position === position);
}

export type ClientMilestoneView = {
  project: FixtureProject;
  milestone: FixtureMilestone;
  changeRequests: ChangeRequest[];
};

export async function getClientMilestone(
  viewerUserId: string,
  projectId: string,
  position: number,
): Promise<ClientMilestoneView | null> {
  const project = clientProject(viewerUserId, projectId);
  if (!project) return null;
  const milestone = milestoneAt(project, position);
  if (!milestone) return null;
  return {
    project,
    milestone,
    changeRequests: changeRequests
      .filter((c) => c.projectId === projectId && c.position === position)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** Studio: marks an in-progress milestone as delivered. Needs a write role. */
export async function deliverMilestone(userId: string, projectId: string, position: number): Promise<MilestoneResult> {
  const membership = await getStudioMembership(userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot mark milestones delivered." };

  const project = studioProject(membership.studioId, projectId);
  const milestone = project ? milestoneAt(project, position) : undefined;
  if (!project || !milestone) return { ok: false, message: "Milestone not found." };

  const next = nextStatus(milestone.status, "deliver");
  if (!next) return { ok: false, message: "Only a milestone in progress can be marked delivered." };
  milestone.status = next;
  recordEvent({ projectId, kind: "milestone_delivered", actor: "studio", summary: `Milestone ${position} delivered` });
  return { ok: true };
}

/**
 * Client: approves a delivered milestone. The next milestone's payment becomes due. When every
 * milestone is approved, the project moves to Completed.
 */
export async function approveMilestone(viewerUserId: string, projectId: string, position: number): Promise<MilestoneResult> {
  const project = clientProject(viewerUserId, projectId);
  const milestone = project ? milestoneAt(project, position) : undefined;
  if (!project || !milestone) return { ok: false, message: "Milestone not found." };

  const next = nextStatus(milestone.status, "approve");
  if (!next) return { ok: false, message: "This milestone is not waiting for your approval." };
  milestone.status = next;

  const following = milestoneAt(project, position + 1);
  if (following && following.status === "upcoming") following.status = "payment_due";
  recordEvent({ projectId, kind: "milestone_approved", actor: "client", summary: `Milestone ${position} approved` });
  if (project.milestones.every((m) => m.status === "approved")) project.stage = "completed";
  if (project.stage === "completed") recordEvent({ projectId, kind: "project_completed", actor: "system", summary: "All milestones approved" });
  return { ok: true };
}

/** Client: asks for changes to a delivered milestone. The milestone returns to in progress. */
export async function requestChanges(
  viewerUserId: string,
  projectId: string,
  position: number,
  body: string,
): Promise<MilestoneResult> {
  const project = clientProject(viewerUserId, projectId);
  const milestone = project ? milestoneAt(project, position) : undefined;
  if (!project || !milestone) return { ok: false, message: "Milestone not found." };

  const next = nextStatus(milestone.status, "request_changes");
  if (!next) return { ok: false, message: "This milestone is not waiting for your review." };
  milestone.status = next;
  changeRequests.push({ id: randomUUID(), projectId, position, body, createdAt: new Date().toISOString() });
  recordEvent({ projectId, kind: "changes_requested", actor: "client", summary: `Changes requested on milestone ${position}` });
  return { ok: true };
}

/** Every change request for a project, newest first. The caller has already checked studio access. */
export async function listProjectChangeRequests(projectId: string): Promise<ChangeRequest[]> {
  return changeRequests
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Studio: replies to a change request once. The reply is visible to the client and is recorded in
 * the activity trail. The milestone's status does not change. The studio redelivers when the work is ready.
 */
export async function replyToChangeRequest(
  userId: string,
  projectId: string,
  changeRequestId: string,
  body: string,
): Promise<MilestoneResult> {
  const membership = await getStudioMembership(userId);
  if (!membership) return { ok: false, message: "Studio not found." };
  if (!canWrite(membership.role)) return { ok: false, message: "Your role cannot reply to change requests." };

  const project = studioProject(membership.studioId, projectId);
  const request = changeRequests.find((c) => c.id === changeRequestId && c.projectId === projectId);
  if (!project || !request) return { ok: false, message: "Change request not found." };
  if (request.reply) return { ok: false, message: "This change request already has a reply." };

  request.reply = { body, repliedAt: new Date().toISOString() };
  recordEvent({ projectId, kind: "changes_responded", actor: "studio", summary: `Studio replied to the change request on milestone ${request.position}` });
  return { ok: true };
}

export type ClientChangeRequestView = ChangeRequest & { milestoneTitle: string };

/** Every change request on a project, for a contact. Null when the viewer is not a contact. */
export async function getClientChangeRequests(viewerUserId: string, projectId: string): Promise<ClientChangeRequestView[] | null> {
  const project = clientProject(viewerUserId, projectId);
  if (!project) return null;
  return changeRequests
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({
      ...c,
      milestoneTitle: milestoneAt(project, c.position)?.title ?? `Milestone ${c.position}`,
    }));
}
