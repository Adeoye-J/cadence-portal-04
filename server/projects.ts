import { demoProjects, demoProposals, type FixtureProject } from "@/db/fixtures/cadence-demo";

/**
 * Data access for the client project view.
 *
 * Authorisation: a viewer sees a project only if they are a listed contact on it.
 * Returns null for both "missing" and "not allowed", so a caller cannot tell
 * which project IDs exist. Callers respond with notFound().
 *
 * TODO(drizzle): replace the fixture read with a query joining project_contacts.
 */
export async function getClientProjectView(
  viewerUserId: string,
  projectId: string,
): Promise<FixtureProject | null> {
  const project = demoProjects.find((p) => p.id === projectId);
  if (!project) return null;
  if (!project.contactUserIds.includes(viewerUserId)) return null;
  return project;
}

export type ClientProjectSummary = {
  id: string;
  reference: string;
  title: string;
  studioName: string;
  stage: FixtureProject["stage"];
  /** The proposal waiting for this viewer's signature, or null. */
  openProposalId: string | null;
};

/** Projects where the viewer is a listed contact. An empty list is a valid state, not an error. */
export async function listClientProjects(viewerUserId: string): Promise<ClientProjectSummary[]> {
  return demoProjects
    .filter((p) => p.contactUserIds.includes(viewerUserId))
    .map((p) => ({
      id: p.id,
      reference: p.reference,
      title: p.title,
      studioName: p.studioName,
      stage: p.stage,
      openProposalId: demoProposals.find((d) => d.projectId === p.id && d.status === "sent")?.id ?? null,
    }));
}
