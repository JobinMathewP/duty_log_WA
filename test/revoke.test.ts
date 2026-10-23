import { describe, expect, it } from "vitest";
import { resolveRevokeId } from "../src/core/events.js";

describe("revoke id resolution", () => {
  const original = "false_120363000000000000@g.us_3EB0ABC_971500000000@c.us";

  it("prefers the original message id", () => {
    const id = resolveRevokeId(
      {
        message: { id: { id: "TOMB", _serialized: "false_group_TOMB_user" } },
        revoked: { id: { id: "3EB0ABC", _serialized: original } },
      },
      () => null,
    );
    expect(id).toBe(original);
  });

  it("uses the protocol key when the original body was not cached", () => {
    const id = resolveRevokeId(
      {
        message: {
          id: { id: "TOMB", _serialized: "false_group_TOMB_user" },
          protocolMessageKey: {
            fromMe: false,
            remote: "120363000000000000@g.us",
            id: "3EB0ABC",
            _serialized: original,
          },
        },
        revoked: null,
      },
      () => null,
    );
    expect(id).toBe(original);
  });

  it("falls back to the short-id index", () => {
    const id = resolveRevokeId(
      {
        message: {
          protocolMessageKey: {
            fromMe: false,
            remote: "120363000000000000@g.us",
            id: "3EB0ABC",
            _serialized: "",
          },
        },
      },
      (shortId) => (shortId === "3EB0ABC" ? original : null),
    );
    expect(id).toBe(original);
  });
});
