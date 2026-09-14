import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createWorkspaceFiles, sanitizeAttachmentName } from "../src/workspace-files.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-workspace-files-"));
  const user3 = path.join(root, "users", "3");
  const user7 = path.join(root, "users", "7");
  await Promise.all([
    mkdir(path.join(user3, "小说创作", "草稿"), { recursive: true }),
    mkdir(path.join(user7, "私有项目"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(user3, "小说创作", "README.md"), "# 小说"),
    writeFile(path.join(user3, "小说创作", "草稿", "第一章.txt"), "章节正文"),
    writeFile(path.join(user7, "私有项目", "secret.txt"), "other-user-secret"),
  ]);
  return { root, user3, user7 };
}

test("lists and reads only project-relative files from a real workspace", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    const listing = await files.list("小说创作");
    assert.deepEqual(listing.entries.map(({ name, type }) => ({ name, type })), [
      { name: "草稿", type: "directory" },
      { name: "README.md", type: "file" },
    ]);
    const nested = await files.list("小说创作", "草稿");
    assert.equal(nested.entries[0].path, "草稿/第一章.txt");
    const file = await files.file("小说创作", "草稿/第一章.txt");
    const chunks = [];
    for await (const chunk of file.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "章节正文");
    assert.equal(file.type, "text/plain; charset=utf-8");
    assert.equal(file.originalType, "text/plain");
    assert.deepEqual(file.preview, { kind: "text", inline: true, eligible: true, maxBytes: 2 * 1024 * 1024 });
  } finally { await rm(sample.root, { recursive: true }); }
});

test("hides system noise by default and exposes ordinary dotfiles only on request", async () => {
  const sample = await fixture();
  try {
    await Promise.all([
      writeFile(path.join(sample.user3, "小说创作", ".env.example"), "SAFE=true"),
      writeFile(path.join(sample.user3, "小说创作", ".DS_Store"), "noise"),
      writeFile(path.join(sample.user3, "小说创作", "._README.md"), "noise"),
      writeFile(path.join(sample.user3, "小说创作", "#recycle"), "noise"),
    ]);
    const files = await createWorkspaceFiles(sample.user3);
    const regular = await files.list("小说创作");
    assert.equal(regular.hiddenCount, 1);
    assert.equal(regular.entries.some((item) => item.name.startsWith(".")), false);
    const revealed = await files.list("小说创作", "", { showHidden: true });
    assert.equal(revealed.entries.some((item) => item.name === ".env.example" && item.hidden), true);
    assert.equal(revealed.entries.some((item) => [".DS_Store", "._README.md", "#recycle"].includes(item.name)), false);
    const readme = revealed.entries.find((item) => item.name === "README.md");
    assert.equal(readme.mimeType, "text/markdown");
    assert.equal(readme.size, 8);
    assert.equal(typeof readme.modifiedAt, "number");
    assert.deepEqual(readme.preview, { kind: "markdown", inline: true, eligible: true, maxBytes: 2 * 1024 * 1024 });
    await assert.rejects(files.file("小说创作", ".DS_Store"), (error) => error.statusCode === 403);
    await assert.rejects(files.file("小说创作", ".env.example"), (error) => error.statusCode === 403);
    const hidden = await files.file("小说创作", ".env.example", { showHidden: true, download: true });
    const hiddenChunks = [];
    for await (const chunk of hidden.stream) hiddenChunks.push(chunk);
    assert.equal(Buffer.concat(hiddenChunks).toString("utf8"), "SAFE=true");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("keeps a legacy ownerKey project visible inside its already isolated owner workspace", async () => {
  const sample = await fixture();
  try {
    await writeFile(path.join(sample.user3, "小说创作", ".yeutech-project.json"), JSON.stringify({
      id: "project-legacy",
      name: "小说创作",
      ownerKey: "legacy-owner-key-0123456789",
    }));
    const files = await createWorkspaceFiles(sample.user3, { portalUserId: 3 });
    const projects = await files.projects();
    assert.deepEqual(projects.find((project) => project.name === "小说创作"), {
      id: "project-legacy",
      name: "小说创作",
      workspaceDirectory: "小说创作",
      registered: true,
    });
    assert.equal((await files.registerProject("小说创作")).id, "project-legacy");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("never exposes hidden or service directories as discoverable NAS projects", async () => {
  const sample = await fixture();
  try {
    await Promise.all([
      mkdir(path.join(sample.user3, ".yeutech-replay-lab")),
      mkdir(path.join(sample.user3, ".git")),
      mkdir(path.join(sample.user3, "@eaDir")),
      mkdir(path.join(sample.user3, "附件")),
      mkdir(path.join(sample.user3, "独立会话")),
      mkdir(path.join(sample.user3, "待接入项目")),
    ]);
    const files = await createWorkspaceFiles(sample.user3, { portalUserId: 3 });
    assert.deepEqual((await files.projects()).map((project) => project.name), ["待接入项目", "小说创作"]);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("rejects absolute paths, traversal, cross-user access, and symlink escape", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    await symlink(path.join(sample.user7, "私有项目"), path.join(sample.user3, "小说创作", "跨用户"));
    await assert.rejects(files.list("小说创作", "../../7/私有项目"), (error) => error.statusCode === 400);
    await assert.rejects(files.file("小说创作", "/etc/passwd"), (error) => error.statusCode === 400);
    await assert.rejects(files.list("../7"), (error) => error.statusCode === 400);
    await assert.rejects(files.file("小说创作", "跨用户/secret.txt"), (error) => error.statusCode === 403);
    assert.equal(await readFile(path.join(sample.user7, "私有项目", "secret.txt"), "utf8"), "other-user-secret");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("streams attachments into the controlled folder and never overwrites duplicate names", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    const first = await files.upload("小说创作", Readable.from(["first"]), { filename: "../../设定：初稿?.pdf", type: "application/pdf", length: 5 });
    const second = await files.upload("小说创作", Readable.from(["second"]), { filename: "设定：初稿?.pdf", type: "application/pdf", length: 6 });
    assert.deepEqual(first, { name: "设定_初稿_.pdf", path: "附件/设定_初稿_.pdf", workspacePath: "小说创作/附件/设定_初稿_.pdf", size: 5, type: "application/pdf", uploaded: true });
    assert.equal(second.name, "设定_初稿__2.pdf");
    assert.equal(await readFile(path.join(sample.user3, "小说创作", "附件", first.name), "utf8"), "first");
    assert.equal(await readFile(path.join(sample.user3, "小说创作", "附件", second.name), "utf8"), "second");
    assert.equal(sanitizeAttachmentName("C:\\temp\\report.xlsx"), "report.xlsx");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("accepts arbitrary types, MIME mismatches, and empty files without an application limit", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    const executable = await files.upload("小说创作", Readable.from(["x"]), { filename: "payload.exe", type: "application/x-custom", length: 1 });
    const mismatch = await files.upload("小说创作", Readable.from(["x"]), { filename: "report.pdf", type: "image/png", length: 1 });
    const empty = await files.upload("小说创作", Readable.from([]), { filename: "empty.bin", type: "", length: 0 });
    assert.equal(executable.type, "application/x-custom");
    assert.equal(mismatch.type, "image/png");
    assert.equal(empty.size, 0);
    assert.equal(empty.type, "application/octet-stream");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("enforces only an explicitly configured upload limit and cleans failed temporary files", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3, { attachmentLimit: 5 });
    await assert.rejects(files.upload("小说创作", Readable.from(["123", "456"]), { filename: "report.txt", type: "text/plain" }), (error) => error.statusCode === 413);
    assert.deepEqual(await readdir(path.join(sample.user3, "小说创作", "附件")), []);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("uploads project files into the currently opened directory", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    const uploaded = await files.upload("小说创作", Readable.from(["draft"]), {
      filename: "notes.any",
      type: "application/x-anything",
      length: 5,
      directory: "草稿",
    });
    assert.equal(uploaded.path, "草稿/notes.any");
    assert.equal(uploaded.workspacePath, "小说创作/草稿/notes.any");
    assert.equal(await readFile(path.join(sample.user3, "小说创作", "草稿", "notes.any"), "utf8"), "draft");
  } finally { await rm(sample.root, { recursive: true }); }
});

test("rejects hidden and symlinked project upload directories", async () => {
  const sample = await fixture();
  try {
    await mkdir(path.join(sample.user3, "小说创作", ".git"));
    await mkdir(path.join(sample.user3, "小说创作", "真实目录", "子目录"), { recursive: true });
    await symlink(path.join(sample.user3, "小说创作", "草稿"), path.join(sample.user3, "小说创作", "alias"));
    await symlink(path.join(sample.user3, "小说创作", "真实目录"), path.join(sample.user3, "小说创作", "中间别名"));
    const files = await createWorkspaceFiles(sample.user3);
    await assert.rejects(files.upload("小说创作", Readable.from(["x"]), { filename: "config", directory: ".git" }), (error) => error.statusCode === 403);
    await assert.rejects(files.upload("小说创作", Readable.from(["x"]), { filename: "notes.txt", directory: "alias" }), (error) => error.statusCode === 403);
    await assert.rejects(files.upload("小说创作", Readable.from(["x"]), { filename: "notes.txt", directory: "中间别名/子目录" }), (error) => error.statusCode === 403);
    await assert.rejects(files.upload("小说创作", Readable.from(["x"]), { filename: "notes.txt", directory: "../小说创作" }), (error) => error.statusCode === 400);
    assert.deepEqual(await readdir(path.join(sample.user3, "小说创作", ".git")), []);
    assert.deepEqual(await readdir(path.join(sample.user3, "小说创作", "真实目录", "子目录")), []);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("refuses an attachment directory that is a symlink", async () => {
  const sample = await fixture();
  try {
    await symlink(path.join(sample.user7, "私有项目"), path.join(sample.user3, "小说创作", "附件"));
    const files = await createWorkspaceFiles(sample.user3);
    await assert.rejects(files.upload("小说创作", Readable.from(["safe"]), { filename: "safe.txt", type: "text/plain", length: 4 }), (error) => error.statusCode === 404);
    assert.deepEqual(await readdir(path.join(sample.user7, "私有项目")), ["secret.txt"]);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("stores standalone files in one visible user folder and deletes only uploaded attachments", async () => {
  const sample = await fixture();
  try {
    const files = await createWorkspaceFiles(sample.user3);
    assert.deepEqual((await files.list({ session: "ses_one" })).entries, []);
    const first = await files.upload({ session: "ses_one" }, Readable.from(["one"]), { filename: "notes.txt", type: "text/plain", length: 3 });
    const second = await files.upload({ session: "ses_two" }, Readable.from(["two"]), { filename: "notes.txt", type: "text/plain", length: 3 });
    assert.equal(first.workspacePath, "独立会话/附件/notes.txt");
    assert.equal(second.workspacePath, "独立会话/附件/notes_2.txt");
    assert.deepEqual((await files.list({ session: "ses_one" }, "\u9644\u4ef6")).entries.map((item) => item.name), ["notes_2.txt", "notes.txt"]);
    await files.removeUpload({ session: "ses_one" }, first.path);
    assert.deepEqual((await files.list({ session: "ses_one" }, "\u9644\u4ef6")).entries.map((item) => item.name), ["notes_2.txt"]);
    assert.deepEqual((await files.list({ session: "ses_two" }, "\u9644\u4ef6")).entries.map((item) => item.name), ["notes_2.txt"]);
    await assert.rejects(files.removeUpload({ project: "\u5c0f\u8bf4\u521b\u4f5c" }, "README.md"), (error) => error.statusCode === 400);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("does not expose the retired hidden attachment tree to standalone conversations", async () => {
  const sample = await fixture();
  const conversationID = "c16eae89-bf41-43ef-b587-4d20a48c2635";
  try {
    const legacy = path.join(sample.user3, ".独立会话附件", conversationID);
    await mkdir(path.join(legacy, "2026-09-12"), { recursive: true });
    await writeFile(path.join(legacy, "2026-09-12", "sample.pdf"), "legacy-pdf");
    const files = await createWorkspaceFiles(sample.user3);
    const space = { session: `portal:${conversationID}` };
    assert.deepEqual((await files.list(space)).entries, []);
    const uploaded = await files.upload(space, Readable.from(["new"]), { filename: "notes.txt", type: "text/plain", length: 3 });
    assert.equal(uploaded.workspacePath, "独立会话/附件/notes.txt");
    assert.equal(await readFile(path.join(sample.user3, "独立会话", "附件", "notes.txt"), "utf8"), "new");
    assert.equal(await readFile(path.join(legacy, "2026-09-12", "sample.pdf"), "utf8"), "legacy-pdf");
  } finally { await rm(sample.root, { recursive: true }); }
});
