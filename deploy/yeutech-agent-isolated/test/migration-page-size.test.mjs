import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("all message sources request the newest ten records first", async () => {
  const source = await readFile(new URL("../web/src/api.js", import.meta.url), "utf8");
  const workbenchSection = source.slice(source.indexOf("export const workbenchApi"), source.indexOf("export const migrationApi"));
  const migrationSection = source.slice(source.indexOf("export const migrationApi"));
  assert.match(workbenchSection, /new URLSearchParams\(\{ limit: "10"/);
  assert.match(migrationSection, /new URLSearchParams\(\{ limit: "10" \}\)/);
  assert.doesNotMatch(source, /limit: "200"/);
});
