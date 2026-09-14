import assert from "node:assert/strict";
import test from "node:test";
import { contextReceipt, mergeProjectionRecordPages, projectActivity, projectChildTree, projectMessage, projectOutline, projectSessionPages, projectStats, projectTrajectory, typedError, workGraph } from "../src/portal-contract.mjs";

const records = [
  { info: { id: "msg_user1", role: "user", time: { created: 10 } }, parts: [{ type: "text", text: "分析这个仓库" }] },
  { info: { id: "msg_agent1", role: "assistant", providerID: "yeutech", modelID: "gpt-5.6-sol", time: { created: 20, completed: 50 }, tokens: { input: 100, output: 20, reasoning: 5 }, cost: 0.01 }, parts: [{ id: "part_tool1", type: "tool", tool: "read", state: { status: "completed" }, time: { start: 25, end: 30 } }, { type: "text", text: "完成" }] },
];

test("restores structured attachment references without exposing the transport envelope", () => {
  const projected = projectMessage({
    info: { id: "msg_attachment", sessionID: "ses_attachment", role: "user", time: { created: 12 } },
    parts: [{ type: "text", text: "请读取并处理已附加的文件。\n\n[已附加工作区文件]\n- 附件/报告.pdf\n- 附件/数据.xlsx\n请仅在当前授权工作区内读取这些相对路径。" }],
  });
  assert.equal(projected.text, "");
  assert.deepEqual(projected.attachments, [
    { path: "附件/报告.pdf", workspacePath: "附件/报告.pdf", name: "报告.pdf" },
    { path: "附件/数据.xlsx", workspacePath: "附件/数据.xlsx", name: "数据.xlsx" },
  ]);
});

test("projects stable outline, activity, stats, context receipts, and work graph", () => {
  const children = [{ id: "ses_child1", title: "检查测试", time: { created: 22 }, status: "running" }];
  assert.deepEqual(projectOutline(records).map(({ turn, title }) => ({ turn, title })), [{ turn: 1, title: "分析这个仓库" }]);
  assert.deepEqual(projectActivity(records, children).map((item) => item.type), ["message", "message", "subagent", "tool"]);
  assert.deepEqual(projectStats(records, children), { turns: 1, assistantMessages: 1, toolCalls: 1, subagents: 1, tokens: { input: 100, output: 20, reasoning: 5, cacheRead: null, cacheWrite: null }, cost: 0.01, durationMs: 30, coverage: { assistantMessages: 1, tokenReports: 1, durationReports: 1, costReports: 1 } });
  const receipt = contextReceipt({ id: "ses_root" }, records, { workload: "novel-writing", workspaceFiles: 2, metadata: { contextEpoch: "epoch-7" } });
  assert.equal(receipt.workload, "novel-writing");
  assert.deepEqual(receipt.sources, ["session-messages", "runtime-tools", "workspace-files"]);
  assert.deepEqual(receipt.metadata, { contextEpoch: "epoch-7" });
  const graph = workGraph({ id: "ses_root", title: "根任务" }, records, children, [{ content: "校验", status: "pending" }], { sessionState: { type: "busy" } });
  assert.equal(graph.nodes[0].status, "busy");
  assert.equal(graph.nodes.at(-1).type, "plan");
});

test("does not invent context sources or zero-valued cost evidence", () => {
  const unknownCost = [{ info: { id: "msg_agent2", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "ok" }] }];
  assert.equal(projectStats(unknownCost).cost, null);
  assert.equal(projectStats([]).cost, null);
  assert.equal(projectStats([{ ...unknownCost[0], info: { ...unknownCost[0].info, cost: 0 } }]).cost, 0);
  assert.equal(projectStats([records[1], unknownCost[0]]).cost, null);
  assert.equal(projectStats(unknownCost).tokens.input, null);
  assert.equal(projectStats(unknownCost).durationMs, 1);
  assert.deepEqual(contextReceipt({ id: "ses_empty" }, []).sources, []);
  assert.deepEqual(contextReceipt({ id: "ses_text" }, [records[0]]).sources, ["session-messages"]);
});

test("merges overlapping long-session pages with stable turn ordinals and explicit coverage", () => {
  const page = (start, end) => Array.from({ length: end - start + 1 }, (_, offset) => {
    const turn = start + offset;
    return { info: { id: `msg_user${turn}`, role: "user", time: { created: turn } }, parts: [{ type: "text", text: `轮次 ${turn}` }] };
  });
  const older = page(1, 200);
  const newer = page(200, 400);
  const merged = mergeProjectionRecordPages([newer, older], { pageOrder: "newest-first" });
  assert.equal(merged.length, 400);
  assert.deepEqual(merged.slice(0, 2).map((record) => record.info.id), ["msg_user1", "msg_user2"]);
  assert.equal(merged.at(-1).info.id, "msg_user400");

  const projection = projectSessionPages({ id: "ses_long", title: "长会话" }, [newer, older], {
    pageOrder: "newest-first",
    complete: true,
    sessionState: "running",
    context: { workload: "general-agent" },
  });
  assert.equal(projection.outline.length, 400);
  assert.deepEqual(projection.outline.slice(198, 202).map(({ id, turn }) => ({ id, turn })), [
    { id: "msg_user199", turn: 199 }, { id: "msg_user200", turn: 200 },
    { id: "msg_user201", turn: 201 }, { id: "msg_user202", turn: 202 },
  ]);
  assert.deepEqual(projection.coverage, { complete: true, recordCount: 400, priorTurnCount: 0, nextCursor: null });
  assert.equal(projection.graph.nodes[0].status, "running");
  assert.equal(projection.graph.kind, "derived-session-map");
  assert.equal(projection.graph.authoritativeDependencies, false);

  const partial = projectOutline(page(201, 202), { priorTurnCount: 200 });
  assert.deepEqual(partial.map(({ id, turn }) => ({ id, turn })), [{ id: "msg_user201", turn: 201 }, { id: "msg_user202", turn: 202 }]);
});

test("typed errors always expose recovery semantics", () => {
  const result = typedError(Object.assign(new Error("busy"), { statusCode: 429, code: "worker_capacity", retryable: true, scope: "worker", recoveryAction: "retry_later" }));
  assert.equal(result.statusCode, 429);
  assert.deepEqual(result.body.error, { code: "worker_capacity", message: "busy", retryable: true, scope: "worker", recoveryAction: "retry_later" });
});

test("projects nested child trees and references oversized tool results outside the main trajectory", () => {
  const records = [{ info: { id: "msg_big", sessionID: "ses_big", role: "assistant", time: { created: 1 } }, parts: [{ id: "prt_big", type: "tool", tool: "bash", state: { status: "completed", output: "x".repeat(3000) } }] }];
  const children = [{ id: "ses_child", parentID: "ses_big", title: "child" }, { id: "ses_grand", parentID: "ses_child", title: "grand" }];
  const tree = projectChildTree(children);
  assert.equal(tree[0].children[0].id, "ses_grand");
  const trajectory = projectTrajectory(records, children, { inlineToolResultLimit: 100 });
  const tool = trajectory.find((item) => item.type === "tool");
  assert.equal(tool.result.truncated, true);
  assert.equal(tool.result.length, 3000);
  assert.match(tool.result.reference, /ses_big\/tool-results\/msg_big\/prt_big$/);
  assert.equal("inline" in tool.result, false);
});
