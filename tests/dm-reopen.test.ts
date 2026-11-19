import assert from "node:assert/strict";
import test from "node:test";
import { applyAuthResult } from "@/lib/theme-auth";
import { dmConversationById, openDmConversation, refreshDm } from "@/lib/social/dm-store";

test("an opened hidden thread retains its recipient after an older server omits it from the inbox", async (t) => {
  const conversation = {
    id: "fixture-thread",
    other: { id: "friend", handle: "friend", displayName: "Friend", presence: "online" },
    unread: 0,
    muted: false,
    at: "2026-11-19T00:00:00Z",
  };
  applyAuthResult({
    token: "fixture-token",
    user: { id: "viewer", handle: "viewer", username: "viewer" },
  });
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    if (init?.method === "POST") {
      assert.equal(JSON.parse(String(init.body)).userId, "friend");
      return Response.json({ conversation });
    }
    return Response.json({ conversations: [], unread: 0 });
  });
  const opened = await openDmConversation("friend");
  assert.equal(opened.id, conversation.id);
  await refreshDm();
  assert.equal(dmConversationById(opened.id)?.other?.handle, "friend");
  assert.equal(dmConversationById(opened.id)?.other?.presence, "online");
});
