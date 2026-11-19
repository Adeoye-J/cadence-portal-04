/**
 * Project audit trail. Append-only: events are added, never edited or removed.
 *
 * Visibility is decided by the event kind, not by each caller, so a new call site cannot
 * expose a studio-only event to a client by mistake. Summaries never contain payment details,
 * bank data or message bodies. Change request text is kept in its own record.
 *
 * Listeners are told about each new event. Notifications use this (server/notify-core.ts).
 * A listener's failure is caught and never reaches the write that caused the event.
 *
 * DEVELOPMENT STORE. Events live in memory and reset on restart. Production needs an insert-only
 * table with no update or delete grants.
 */

export type EventKind =
  | "proposal_drafted"
  | "proposal_sent"
  | "proposal_signed"
  | "invitation_sent"
  | "invitation_accepted"
  | "payment_started"
  | "payment_settled"
  | "milestone_delivered"
  | "milestone_approved"
  | "changes_requested"
  | "changes_responded"
  | "file_added"
  | "file_removed"
  | "project_completed";

export type EventActor = "studio" | "client" | "system";
export type EventAudience = "client" | "studio";

/** Kinds a client may see. Everything else is studio-only. */
const CLIENT_VISIBLE: Record<EventKind, boolean> = {
  proposal_drafted: false,
  proposal_sent: true,
  proposal_signed: true,
  invitation_sent: false,
  invitation_accepted: true,
  payment_started: false,
  payment_settled: true,
  milestone_delivered: true,
  milestone_approved: true,
  changes_requested: true,
  changes_responded: true,
  file_added: true,
  file_removed: false,
  project_completed: true,
};

export type ProjectEvent = {
  seq: number;
  projectId: string;
  kind: EventKind;
  actor: EventActor;
  summary: string;
  at: string;
  clientVisible: boolean;
};

type Listener = (event: ProjectEvent) => void | Promise<void>;

const events: ProjectEvent[] = [];
const listeners: Listener[] = [];
let sequence = 0;

/** Registers a listener for every future event. Used once at startup. */
export function onEvent(listener: Listener): void {
  listeners.push(listener);
}

export function recordEvent(input: { projectId: string; kind: EventKind; actor: EventActor; summary: string }): void {
  sequence += 1;
  const event: ProjectEvent = {
    ...input,
    seq: sequence,
    at: new Date().toISOString(),
    clientVisible: CLIENT_VISIBLE[input.kind],
  };
  events.push(event);
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(event))
      .catch(() => {
        // A failed notification must not affect the write. The notifier logs its own errors.
      });
  }
}

/** Newest first. A client gets only client-visible events. A studio gets all of them. */
export function listEvents(projectId: string, audience: EventAudience): ProjectEvent[] {
  return events
    .filter((e) => e.projectId === projectId && (audience === "studio" || e.clientVisible))
    .sort((a, b) => b.seq - a.seq);
}
