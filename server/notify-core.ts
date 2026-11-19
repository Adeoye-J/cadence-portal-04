import { demoProjects } from "@/db/fixtures/cadence-demo";
import { notificationFor, type Audience } from "@/lib/services/notification-templates";
import type { EventKind, ProjectEvent } from "@/server/events";
import type { OutboxInput } from "@/server/outbox";
import { emailFor, studioNotifiees } from "@/server/directory";

/**
 * Notification rules. Turns one event into outbox messages, one per recipient. No environment access,
 * so the rules can be tested without a database or an email provider.
 */

/** Who hears about each event kind. Kinds not listed here queue nothing. */
const PLAN: Partial<Record<EventKind, Audience[]>> = {
  proposal_sent: ["client"],
  proposal_signed: ["studio"],
  invitation_accepted: ["studio"],
  payment_settled: ["client", "studio"],
  milestone_delivered: ["client"],
  milestone_approved: ["studio"],
  changes_requested: ["studio"],
  changes_responded: ["client"],
  project_completed: ["client", "studio"],
  file_added: ["client"],
};

export function recipientsFor(projectId: string, audiences: Audience[]): { audience: Audience; email: string }[] {
  const project = demoProjects.find((p) => p.id === projectId);
  if (!project) return [];
  const seen = new Set<string>();
  const out: { audience: Audience; email: string }[] = [];
  for (const audience of audiences) {
    const userIds = audience === "client" ? project.contactUserIds : studioNotifiees(project.studioId);
    for (const userId of userIds) {
      const email = emailFor(userId);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ audience, email });
    }
  }
  return out;
}

/**
 * The outbox messages for one event. The dedupe key is the event's sequence number plus the address,
 * so a repeated delivery of the same event cannot queue a second email.
 */
export function planNotifications(event: ProjectEvent, appUrl: string): OutboxInput[] {
  const audiences = PLAN[event.kind];
  const project = demoProjects.find((p) => p.id === event.projectId);
  if (!audiences || !project) return [];

  const messages: OutboxInput[] = [];
  for (const recipient of recipientsFor(event.projectId, audiences)) {
    const link =
      recipient.audience === "client"
        ? `${appUrl}/projects/${project.id}`
        : `${appUrl}/studio/projects/${project.id}`;
    const message = notificationFor(event.kind, {
      projectTitle: project.title,
      summary: event.summary,
      link,
      audience: recipient.audience,
    });
    if (!message) continue;
    messages.push({
      dedupeKey: `${event.seq}:${recipient.email}`,
      to: recipient.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
  return messages;
}
