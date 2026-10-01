
export function parseMarkdownBlocks(rawText = "") {
  const lines = String(rawText || "").split("\n");
  const blocks = [];
  let inCode = false;
  let codeLines = [];
  let codeLang = "";
  let paragraphLines = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push({ type: "paragraph", lines: [...paragraphLines] });
      paragraphLines = [];
    }
  };

  const isTableDelimiter = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") && !trimmed.endsWith("|")) return false;
    const cells = trimmed.split("|").slice(1, -1);
    if (!cells.length) return false;
    return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
  };

  const parseTableAlignments = (delimiterLine) => {
    return delimiterLine.trim().split("|").slice(1, -1).map((cell) => {
      const trimmed = cell.trim();
      const left = trimmed.startsWith(":");
      const right = trimmed.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });
  };

  const parseTableRow = (line) => {
    const trimmed = line.trim();
    const withoutEnds = trimmed.replace(/^\|/, "").replace(/\|$/, "");
    return withoutEnds.split("|").map((cell) => cell.trim());
  };

  while (i < lines.length) {
    const line = lines[i];

    const codeMatch = line.match(/^\s*```([^\s`]*)/);
    if (codeMatch && !inCode) {
      flushParagraph();
      inCode = true;
      codeLang = codeMatch[1] || "";
      codeLines = [];
      i++;
      continue;
    }
    if (inCode) {
      if (/^\s*```/.test(line)) {
        blocks.push({ type: "code", code: codeLines.join("\n"), lang: codeLang });
        inCode = false;
        codeLines = [];
        codeLang = "";
      } else {
        codeLines.push(line);
      }
      i++;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      blocks.push({ type: "heading", level, text: headingMatch[2] });
      i++;
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      const quoteLines = [quoteMatch[1]];
      i++;
      while (i < lines.length) {
        const nextQuote = lines[i].match(/^\s*>\s?(.*)$/);
        if (nextQuote) {
          quoteLines.push(nextQuote[1]);
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      const headers = parseTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows, alignments });
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*•])\s+(.+)$/);
    const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (bulletMatch || orderedMatch) {
      flushParagraph();
      const indent = (bulletMatch || orderedMatch)[1].length;
      const marker = bulletMatch ? "•" : `${orderedMatch[2]}.`;
      const content = (bulletMatch || orderedMatch)[3];
      blocks.push({
        type: "list-item",
        ordered: Boolean(orderedMatch),
        marker,
        indent,
        text: content,
      });
      i++;
      continue;
    }

    if (line.includes(":codex-file-citation{")) {
      flushParagraph();
      blocks.push({ type: "citation-line", line });
      i++;
      continue;
    }

    paragraphLines.push(line);
    i++;
  }

  flushParagraph();
  if (inCode && codeLines.length) {
    blocks.push({ type: "code", code: codeLines.join("\n"), lang: codeLang });
  }

  return blocks;
}

