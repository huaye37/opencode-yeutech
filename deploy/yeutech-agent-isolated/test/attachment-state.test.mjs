import assert from "node:assert/strict";
import test from "node:test";
import { removeDeletedAttachmentReferences, removeDeletedUploadStatuses } from "../web/src/attachment-state.js";

test("removes every composer reference after a project attachment is physically deleted", () => {
  const projectSpace = { project: "小说创作" };
  const otherProjectSpace = { project: "工作项目" };
  const attachments = [
    { path: "附件/设定.txt", workspacePath: "小说创作/附件/设定.txt", space: projectSpace, uploaded: true },
    { path: "附件/设定.txt", workspacePath: "小说创作/附件/设定.txt", space: projectSpace, uploaded: false },
    { path: "附件/设定.txt", workspacePath: "工作项目/附件/设定.txt", space: otherProjectSpace, uploaded: true },
  ];

  assert.deepEqual(removeDeletedAttachmentReferences(attachments, {
    path: "附件/设定.txt",
    workspacePath: "小说创作/附件/设定.txt",
    space: projectSpace,
  }), [attachments[2]]);
});

test("matches standalone attachment references through their shared user folder", () => {
  const attachments = [
    { path: "附件/notes.txt", workspacePath: "独立会话/附件/notes.txt", space: { session: "ses_a" }, uploaded: true },
    { path: "附件/notes.txt", workspacePath: "独立会话/附件/notes.txt", space: { session: "ses_b" }, uploaded: true },
  ];

  assert.deepEqual(removeDeletedAttachmentReferences(attachments, {
    path: "附件/notes.txt",
    space: { session: "ses_a" },
  }), []);
});

test("removes the completed upload status when its physical attachment is deleted", () => {
  const uploads = [
    { id: "one", name: "notes.txt", path: "附件/notes.txt", status: "done" },
    { id: "two", name: "other.txt", path: "附件/other.txt", status: "done" },
  ];

  assert.deepEqual(removeDeletedUploadStatuses(uploads, "附件/notes.txt"), [uploads[1]]);
});
