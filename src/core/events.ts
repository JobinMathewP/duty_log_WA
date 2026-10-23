import type { Message, MessageId } from "whatsapp-web.js";
import type { InboundMessage, SyncDeps } from "./sync.js";
import { applyMessage, applyRevoke } from "./sync.js";
import type { WaClient } from "./client.js";

export function asId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "_serialized" in value) {
    const serialized = (value as { _serialized?: unknown })._serialized;
    if (typeof serialized === "string") return serialized;
  }
  return "";
}

export function chatIdOf(message: { fromMe?: boolean; from?: unknown; to?: unknown }): string {
  return message.fromMe ? asId(message.to) : asId(message.from);
}

export function toInbound(message: Message): InboundMessage {
  const notifyName = (message as Message & { _data?: { notifyName?: string } })._data?.notifyName;
  return {
    serializedId: message.id?._serialized ?? "",
    shortId: message.id?.id ?? "",
    chatId: chatIdOf(message),
    senderName: notifyName ?? "",
    senderId: message.author ?? "",
    body: message.body ?? "",
    timestamp: message.timestamp ?? 0,
    type: message.type ?? "chat",
    isForwarded: Boolean(message.isForwarded),
  };
}

export interface RevokeParts {
  message: { id?: Partial<MessageId>; protocolMessageKey?: MessageId | null };
  revoked?: { id?: Partial<MessageId> } | null;
}

/** The tombstone id is not the duty-log id. Prefer the original message, then the protocol key, then the short-id index. */
export function resolveRevokeId(
  parts: RevokeParts,
  resolveShort: (shortId: string) => string | null,
): string | null {
  const serialized = parts.revoked?.id?._serialized;
  if (serialized) return serialized;
  const protocolSerialized = parts.message.protocolMessageKey?._serialized;
  if (protocolSerialized) return protocolSerialized;
  const short =
    parts.message.protocolMessageKey?.id || parts.revoked?.id?.id || parts.message.id?.id || "";
  if (!short) return null;
  return resolveShort(short);
}

export function attachEvents(client: WaClient, deps: SyncDeps): void {
  const targets = new Set(deps.config.targetGroupIds);

  client.on("message_create", (message) => {
    void handleCreate(message, targets, deps);
  });

  client.on("message_edit", (message, newBody) => {
    void handleEdit(message, String(newBody), targets, deps);
  });

  client.on("message_revoke_everyone", (message, revoked) => {
    void handleRevoke(message, revoked, deps);
  });
}

async function handleCreate(
  message: Message,
  targets: Set<string>,
  deps: SyncDeps,
): Promise<void> {
  try {
    if (!targets.has(chatIdOf(message))) return;
    await applyMessage(toInbound(message), deps);
  } catch (error) {
    deps.logger.error("message_create failed", { error: String(error) });
  }
}

async function handleEdit(
  message: Message,
  newBody: string,
  targets: Set<string>,
  deps: SyncDeps,
): Promise<void> {
  try {
    if (message.type === "revoked") return;
    if (!targets.has(chatIdOf(message))) return;
    const inbound = toInbound(message);
    inbound.body = newBody;
    await applyMessage(inbound, deps);
  } catch (error) {
    deps.logger.error("message_edit failed", { error: String(error) });
  }
}

async function handleRevoke(
  message: Message,
  revoked: Message | null | undefined,
  deps: SyncDeps,
): Promise<void> {
  try {
    const id = resolveRevokeId({ message, revoked }, (shortId) => deps.state.resolve(shortId));
    if (!id) {
      deps.logger.info("revoke ignored", { reason: "unresolved id" });
      return;
    }
    await applyRevoke(id, deps);
  } catch (error) {
    deps.logger.error("revoke failed", { error: String(error) });
  }
}
