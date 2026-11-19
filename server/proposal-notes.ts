import { randomUUID } from "node:crypto";

/**
 * Client notes on a proposal: general notes, notes on a section, and requests for changes. Stored for the studio to
 * read. Development store: held in memory until the database is wired.
 */

export type ProposalNoteKind = "general" | "section" | "change";

export type ProposalNote = {
  id: string;
  proposalId: string;
  projectId: string;
  authorUserId: string;
  kind: ProposalNoteKind;
  sectionRef: string | null;
  body: string;
  createdAt: string;
};

const notes: ProposalNote[] = [];

export function addProposalNote(input: Omit<ProposalNote, "id" | "createdAt">, now: Date = new Date()): ProposalNote {
  const note: ProposalNote = { ...input, id: randomUUID(), createdAt: now.toISOString() };
  notes.push(note);
  return note;
}

export function listProposalNotes(proposalId: string): ProposalNote[] {
  return notes.filter((n) => n.proposalId === proposalId);
}
