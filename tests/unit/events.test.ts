import { describe, expect, it } from "vitest";
import { demoViewerId } from "@/db/fixtures/cadence-demo";
import { listEvents, recordEvent } from "@/server/events";
import { signProposal } from "@/server/proposals";

const PROJECT = "prj_cad_2026_090";

describe("audit trail visibility", () => {
  it("shows a client only the client-visible kinds, and the studio everything", () => {
    recordEvent({ projectId: PROJECT, kind: "invitation_sent", actor: "studio", summary: "Invite" });
    recordEvent({ projectId: PROJECT, kind: "payment_settled", actor: "system", summary: "Settled" });

    const client = listEvents(PROJECT, "client").map((e) => e.kind);
    const studio = listEvents(PROJECT, "studio").map((e) => e.kind);

    expect(client).toContain("payment_settled");
    expect(client).not.toContain("invitation_sent");
    expect(studio).toContain("invitation_sent");
    expect(studio).toContain("payment_settled");
  });

  it("returns the newest event first", () => {
    recordEvent({ projectId: "prj_order", kind: "milestone_delivered", actor: "studio", summary: "first" });
    recordEvent({ projectId: "prj_order", kind: "milestone_approved", actor: "client", summary: "second" });
    expect(listEvents("prj_order", "studio").map((e) => e.summary)).toEqual(["second", "first"]);
  });

  it("records the signature from the real sign-off path, visible to the client", async () => {
    const r = await signProposal(demoViewerId, "prp_cad_2026_090_v4", "Sofia Marin");
    expect(r.ok).toBe(true);
    const summaries = listEvents(PROJECT, "client").map((e) => e.summary);
    expect(summaries).toContain("Proposal signed");
  });

  it("keeps studio-only events out of the client view even for the same project", () => {
    const studioOnly = listEvents(PROJECT, "studio").filter((e) => !e.clientVisible);
    const clientKinds = new Set(listEvents(PROJECT, "client").map((e) => e.kind));
    for (const e of studioOnly) expect(clientKinds.has(e.kind)).toBe(false);
  });
});
