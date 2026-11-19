import { env } from "@/lib/env";
import { onEvent, type ProjectEvent } from "@/server/events";
import { DrizzleOutbox } from "@/server/outbox-drizzle";
import { planNotifications } from "@/server/notify-core";
import type { OutboxStore } from "@/server/outbox";

let registered = false;

/** The durable outbox used by the app. */
export const outbox: OutboxStore = new DrizzleOutbox();

/**
 * Connects the event log to the outbox. Writes never send email themselves: they queue it. The
 * scheduled job (app/api/jobs/notifications) sends the queue. The guard keeps a hot reload from
 * registering twice.
 */
export function registerNotifications(): void {
  if (registered) return;
  registered = true;
  onEvent(async (event: ProjectEvent) => {
    const now = new Date();
    for (const message of planNotifications(event, env.APP_URL)) {
      try {
        await outbox.enqueue(message, now);
      } catch {
        console.error(`[notify] could not queue notification for kind=${event.kind}`);
      }
    }
  });
}
