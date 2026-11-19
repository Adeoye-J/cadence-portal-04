/**
 * Runs once when the server starts. Importing lib/env validates every environment variable, so a bad
 * configuration fails at boot, not on a request. Notifications are then connected to the event log.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/env");
    const { registerNotifications } = await import("./server/notifications");
    registerNotifications();
  }
}
