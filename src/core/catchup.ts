import type { SyncDeps } from "./sync.js";
import { applyMessage } from "./sync.js";
import { toInbound } from "./events.js";
import type { WaClient } from "./client.js";

let running = false;

export async function runCatchup(client: WaClient, deps: SyncDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const groupId of deps.config.targetGroupIds) {
      let oldest = Number.POSITIVE_INFINITY;
      let newest = 0;
      let count = 0;
      try {
        const chat = await client.getChatById(groupId);
        const messages = await chat.fetchMessages({ limit: deps.config.historicalFetchLimit });
        count = messages.length;
        for (const message of messages) {
          const inbound = toInbound(message);
          if (inbound.timestamp > 0) {
            oldest = Math.min(oldest, inbound.timestamp);
            newest = Math.max(newest, inbound.timestamp);
          }
          await applyMessage(inbound, deps);
        }
      } catch (error) {
        deps.logger.error("group catch-up failed", { groupId, error: String(error) });
        continue;
      }
      const last = deps.state.getLastSync();
      if (count > 0 && last > 0 && oldest > last) {
        deps.logger.warn("catchup_window_incomplete", { groupId, oldest, lastSync: last });
      }
      if (newest > 0) await deps.state.setLastSync(newest);
    }
  } finally {
    running = false;
  }
}
