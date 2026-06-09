import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const runDir = path.resolve("..");
const outputDir = path.resolve(".");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function setHeaderStyle(range) {
  range.format.fill.color = "#eaf2ff";
  range.format.font.bold = true;
  range.format.font.color = "#111827";
  range.format.wrapText = true;
}

const summaryCsv = await fs.readFile(path.join(runDir, "summary_for_review.csv"), "utf8");
const mergedCsv = await fs.readFile(path.join(runDir, "merged_results_for_review.csv"), "utf8");
const summaryRows = parseCsv(summaryCsv);
const mergedRows = parseCsv(mergedCsv);

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Summary");
const results = workbook.worksheets.add("Merged Results");

summary.getRangeByIndexes(0, 0, summaryRows.length, summaryRows[0].length).values = summaryRows;
results.getRangeByIndexes(0, 0, mergedRows.length, mergedRows[0].length).values = mergedRows;

setHeaderStyle(summary.getRange("A1:B1"));
setHeaderStyle(results.getRangeByIndexes(0, 0, 1, mergedRows[0].length));

summary.freezePanes.freezeRows(1);
results.freezePanes.freezeRows(1);
results.freezePanes.freezeColumns(4);

summary.getRange("A:A").format.columnWidthPx = 220;
summary.getRange("B:B").format.columnWidthPx = 760;

const widths = [
  110, 210, 130, 150, 120, 120, 240, 190, 150, 260, 420, 260, 360, 110,
  150, 110, 120, 120, 120, 120, 120, 120, 120, 130, 220, 420, 520,
];
for (let i = 0; i < widths.length; i += 1) {
  results.getRangeByIndexes(0, i, Math.max(mergedRows.length, 1), 1).format.columnWidthPx = widths[i];
}
results.getRangeByIndexes(0, 0, mergedRows.length, mergedRows[0].length).format.wrapText = true;
summary.getRangeByIndexes(0, 0, summaryRows.length, summaryRows[0].length).format.wrapText = true;

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const overview = await workbook.inspect({
  kind: "table",
  range: "Summary!A1:B10",
  tableMaxRows: 12,
  tableMaxCols: 3,
  maxChars: 3000,
});
console.log(overview.ndjson);

await fs.mkdir(outputDir, { recursive: true });
for (const [sheetName, range] of [
  ["Summary", "A1:B10"],
  ["Merged Results", "A1:AA18"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
  const previewBytes = new Uint8Array(await preview.arrayBuffer());
  const safeName = sheetName.toLowerCase().replaceAll(" ", "_");
  await fs.writeFile(path.join(outputDir, `${safeName}_preview.png`), previewBytes);
}
const output = await SpreadsheetFile.exportXlsx(workbook);
const outputPath = path.join(outputDir, "ai_video_benchmark_full_run_2026-05-02.xlsx");
await output.save(outputPath);
console.log(outputPath);
