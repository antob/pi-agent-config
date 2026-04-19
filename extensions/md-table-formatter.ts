/**
 * Markdown Table Formatter extension.
 *
 * Formats markdown tables with aligned columns and proper separators.
 *
 * - format_table tool: LLM can format markdown table text
 * - Auto-formats tables in tool results (bash, read, etc.)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "format_table",
    label: "Format Table",
    description:
      "Format a markdown table string with aligned columns. Pass the raw markdown table text and receive formatted output.",
    parameters: Type.Object({
      table: Type.String({ description: "Raw markdown table text to format" })
    }),
    async execute(_toolCallId, params) {
      const formatted = formatMarkdownTables(params.table);
      return {
        content: [{ type: "text", text: formatted }],
        details: {}
      };
    },
    renderCall(_args, _theme, _context) {
      return new Container();
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    }
  });

  // Auto-format markdown tables in tool results
  pi.on("tool_result", async (event) => {
    if (!event.content || event.content.length === 0) return;

    let modified = false;
    const newContent = event.content.map((block) => {
      if (block.type !== "text") return block;
      const text = block.text;
      if (!containsMarkdownTable(text)) return block;
      const formatted = formatMarkdownTables(text);
      if (formatted !== text) modified = true;
      return { type: "text" as const, text: formatted };
    });

    if (modified) {
      return { content: newContent };
    }
  });
}

// --- Table detection and formatting logic ---

function containsMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (
      isTableRow(lines[i]) &&
      (isSeparatorRow(lines[i]) || isSeparatorRow(lines[i + 1]))
    ) {
      return true;
    }
  }
  return false;
}

function formatMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      if (isValidTable(tableLines)) {
        const formatted = formatTable(tableLines);
        for (const fl of formatted) {
          result.push(fl);
        }
      } else {
        for (const tl of tableLines) {
          result.push(tl);
        }
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    trimmed.split("|").length > 2
  );
}

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const cells = trimmed.split("|").slice(1, -1);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function isValidTable(lines: string[]): boolean {
  if (lines.length < 2) return false;

  const rows = lines.map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
  );

  if (rows.length === 0 || rows[0].length === 0) return false;

  const firstRowCellCount = rows[0].length;
  const allSameColumnCount = rows.every(
    (row) => row.length === firstRowCellCount
  );
  if (!allSameColumnCount) return false;

  const hasSeparator = lines.some((line) => isSeparatorRow(line));
  return hasSeparator;
}

function formatTable(lines: string[]): string[] {
  const separatorIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (isSeparatorRow(lines[i])) {
      separatorIndices.add(i);
    }
  }

  const rows = lines.map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
  );

  if (rows.length === 0) return lines;

  const colCount = Math.max(...rows.map((row) => row.length));

  // Determine column alignments from separator rows
  const colAlignments: Array<"left" | "center" | "right"> =
    Array(colCount).fill("left");
  for (const rowIndex of separatorIndices) {
    const row = rows[rowIndex];
    for (let col = 0; col < row.length; col++) {
      const cell = row[col];
      const leftColon = cell.startsWith(":");
      const rightColon = cell.endsWith(":");
      if (leftColon && rightColon) {
        colAlignments[col] = "center";
      } else if (rightColon) {
        colAlignments[col] = "right";
      } else {
        colAlignments[col] = "left";
      }
    }
  }

  // Calculate max column widths
  const colWidths: number[] = Array(colCount).fill(0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (separatorIndices.has(rowIndex)) continue;
    const row = rows[rowIndex];
    for (let col = 0; col < row.length; col++) {
      const width = displayWidth(row[col]);
      if (width > colWidths[col]) {
        colWidths[col] = width;
      }
    }
  }

  // Minimum width of 3 for separator cells
  for (let col = 0; col < colCount; col++) {
    if (colWidths[col] < 3) colWidths[col] = 3;
  }

  // Build formatted rows
  const formatted: string[] = rows.map((row, rowIndex) => {
    const cells: string[] = [];
    for (let col = 0; col < colCount; col++) {
      const content = col < row.length ? row[col] : "";
      if (separatorIndices.has(rowIndex)) {
        cells.push(formatSeparatorCell(colWidths[col], colAlignments[col]));
      } else {
        cells.push(padCell(content, colWidths[col], colAlignments[col]));
      }
    }
    return "| " + cells.join(" | ") + " |";
  });

  return formatted;
}

function displayWidth(text: string): number {
  // Strip markdown formatting for width calculation
  let visual = text;
  let prev = "";
  while (visual !== prev) {
    prev = visual;
    visual = visual
      .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  }
  return visual.length;
}

function padCell(
  text: string,
  width: number,
  align: "left" | "center" | "right"
): string {
  const dw = displayWidth(text);
  const totalPadding = Math.max(0, width - dw);

  if (align === "center") {
    const leftPad = Math.floor(totalPadding / 2);
    const rightPad = totalPadding - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  } else if (align === "right") {
    return " ".repeat(totalPadding) + text;
  } else {
    return text + " ".repeat(totalPadding);
  }
}

function formatSeparatorCell(
  width: number,
  align: "left" | "center" | "right"
): string {
  if (align === "center") return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
  if (align === "right") return "-".repeat(Math.max(1, width - 1)) + ":";
  return "-".repeat(width);
}
