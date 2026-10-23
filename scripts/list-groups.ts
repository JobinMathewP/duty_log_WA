import { attachQr, createClient } from "../src/core/client.js";

const client = createClient();
attachQr(client);

client.on("auth_failure", (message) => {
  console.error(`[error] auth_failure ${String(message)}`);
  process.exit(1);
});

client.on("ready", () => {
  void (async () => {
    try {
      const chats = await client.getChats();
      for (const chat of chats) {
        if (!chat.isGroup) continue;
        console.log(`${chat.name}\t${chat.id._serialized}`);
      }
    } catch (error) {
      console.error(`[error] list groups failed ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      await client.destroy().catch(() => undefined);
      process.exit(process.exitCode ?? 0);
    }
  })();
});

await client.initialize();
