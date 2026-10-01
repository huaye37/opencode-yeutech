import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectFileReferences, projectFilePath } from "../web/src/project-file-reference.js";

test("accepts controlled relative project artifacts", () => {
  assert.equal(projectFilePath("产出/2026-09-15/迁移包_V9.zip"), "产出/2026-09-15/迁移包_V9.zip");
  assert.equal(projectFilePath("./docs/report.md"), "docs/report.md");
  assert.equal(projectFilePath("images\\preview.png"), "images/preview.png");
});

test("rejects external, absolute, traversal, and plain code references", () => {
  for (const value of ["https://example.com/a.zip", "file:///tmp/a.zip", "/volume1/private/a.zip", "../secret/a.md", "README.md", "npm run build"]) {
    assert.equal(projectFilePath(value), "", value);
  }
});

test("recovers URL encoded, file URL, absolute project, and legacy preview references", () => {
  const project = "轨迹风险审计agent开发";
  assert.equal(projectFilePath("%E4%BA%A7%E5%87%BA/2026-09-12/result.zip", project), "产出/2026-09-12/result.zip");
  assert.equal(projectFilePath("file:///projects/users/3/轨迹风险审计agent开发/产出/result.xlsx", project, { allowBare: true }), "产出/result.xlsx");
  assert.equal(projectFilePath("/Users/lucian/轨迹风险审计agent开发/产出/result.xlsx", project, { allowBare: true }), "产出/result.xlsx");
  assert.equal(projectFilePath("/codex/files?project=p1&path=%E4%BA%A7%E5%87%BA%2Fresult.xlsx", project, { allowBare: true }), "产出/result.xlsx");
  assert.equal(projectFilePath("/codex/files?project=p1&directory=%E4%BA%A7%E5%87%BA&name=result.xlsx", project, { allowBare: true }), "产出/result.xlsx");
  assert.equal(projectFilePath("C:\\Users\\lucian\\轨迹风险审计agent开发\\产出\\result.xlsx", project, { allowBare: true }), "产出/result.xlsx");
  assert.equal(projectFilePath("README.md", project, { allowBare: true }), "README.md");
});

test("uses both the workspace directory and display name when recovering absolute paths", () => {
  const aliases = ["project-7f31", "轨迹风险审计agent开发"];
  assert.equal(projectFilePath("/Users/lucian/project-7f31/产出/a.zip", aliases, { allowBare: true }), "产出/a.zip");
  assert.equal(projectFilePath("/Users/lucian/轨迹风险审计agent开发/产出/b.zip", aliases, { allowBare: true }), "产出/b.zip");
});

test("normalizes labelled, standalone, and previously nested file citations", () => {
  const project = "轨迹风险审计agent开发";
  const citation = ':codex-file-citation{path="/projects/users/3/轨迹风险审计agent开发/产出/结果.xlsx"}';
  assert.equal(normalizeProjectFileReferences(`[查看结果](${citation})`, project), "[查看结果](%E4%BA%A7%E5%87%BA/%E7%BB%93%E6%9E%9C.xlsx)");
  assert.equal(normalizeProjectFileReferences(citation, project), "[结果.xlsx](%E4%BA%A7%E5%87%BA/%E7%BB%93%E6%9E%9C.xlsx)");
  assert.equal(normalizeProjectFileReferences("[查看结果]([结果.xlsx](/codex/files?project=p1&path=%E4%BA%A7%E5%87%BA%2Fresult.xlsx))", project), "[查看结果](%E4%BA%A7%E5%87%BA/result.xlsx)");
});

test("restores collapsed imported code fences without exposing markers", () => {
  const normalized = normalizeProjectFileReferences("SHA-256： ```text abc123 ``` 2. next");
  assert.equal(normalized, "SHA-256： \n```text\nabc123\n```\n 2. next");
});
