import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownBlocks } from "../web/src/markdown-parser.js";

test("parses headings, horizontal rules, lists, and tables as structural blocks", () => {
  const blocks = parseMarkdownBlocks("# 标题\n\n---\n\n- 项目\n\n| 名称 | 数量 |\n| --- | ---: |\n| A | 2 |");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "hr", "list-item", "table"]);
  assert.deepEqual(blocks.at(-1).headers, ["名称", "数量"]);
  assert.deepEqual(blocks.at(-1).alignments, ["left", "right"]);
});
