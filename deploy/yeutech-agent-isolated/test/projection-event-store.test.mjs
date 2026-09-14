import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectionEventStore } from "../src/projection-event-store.mjs";

test("persists durable cursors, suppresses only adjacent duplicates, and replays after reconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-projection-"));
  const database = path.join(directory, "events.sqlite");
  const first = createProjectionEventStore(database);
  const busy = first.append(3, "ses_one", "session", "session.state", { status: "busy" });
  assert.equal(busy.inserted, true);
  assert.equal(first.append(3, "ses_one", "session", "session.state", { status: "busy" }).inserted, false);
  const idle = first.append(3, "ses_one", "session", "session.state", { status: null });
  const busyAgain = first.append(3, "ses_one", "session", "session.state", { status: "busy" });
  assert.ok(busyAgain.cursor > idle.cursor);
  first.close();

  const reopened = createProjectionEventStore(database);
  assert.deepEqual(reopened.replay(3, "ses_one", busy.cursor).map((item) => item.data.status), [null, "busy"]);
  assert.equal(reopened.replay(4, "ses_one", 0).length, 0);
  assert.equal(reopened.latestCursor(3, "ses_one"), busyAgain.cursor);
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("replays every durable page after a long disconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-projection-pages-"));
  const database = path.join(directory, "events.sqlite");
  const store = createProjectionEventStore(database);
  for (let index = 0; index < 1_005; index += 1) {
    store.append(3, "ses_long", `message:${index}`, "message.upsert", { index });
  }
  const replayed = [...store.replayAll(3, "ses_long", 0, 200)];
  assert.equal(replayed.length, 1_005);
  assert.equal(replayed[0].data.index, 0);
  assert.equal(replayed.at(-1).data.index, 1_004);
  assert.equal(replayed.at(-1).cursor, store.latestCursor(3, "ses_long"));
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("serves the latest durable message values in ten-item reverse pages", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-projection-messages-"));
  const store = createProjectionEventStore(path.join(directory, "events.sqlite"));
  try {
    for (let index = 0; index < 23; index += 1) {
      store.append(3, "ses_messages", `message:msg_${index}`, "message.upsert", { id: `msg_${index}`, role: index % 2 ? "assistant" : "user", text: `v1-${index}`, createdAt: index + 1 });
    }
    store.append(3, "ses_messages", "message:msg_22", "message.upsert", { id: "msg_22", role: "user", text: "updated", createdAt: 23 });
    const newest = store.messages(3, "ses_messages");
    assert.equal(newest.records.length, 10);
    assert.equal(newest.records[0].id, "msg_13");
    assert.equal(newest.records.at(-1).text, "updated");
    assert.equal(newest.cursor, "13");
    const older = store.messages(3, "ses_messages", newest.cursor);
    assert.deepEqual(older.records.map((item) => item.id), Array.from({ length: 10 }, (_, index) => `msg_${index + 3}`));
    assert.equal(older.cursor, "3");
    assert.deepEqual(store.messages(4, "ses_messages").records, []);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
