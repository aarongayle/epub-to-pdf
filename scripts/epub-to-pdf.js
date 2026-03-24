import fs from "node:fs/promises";
import path from "node:path";

import { convertEpubToPdf } from "../lib/convert.js";

function parseArgs(argv) {
  const opts = {
    input: "",
    output: "",
    screenWidth: 400,
    screenHeight: 600,
    pageMargin: "25mm",
    bookmarks: true,
    settleMs: 3000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      opts.input = next;
      i += 1;
    } else if (arg === "--output" && next) {
      opts.output = next;
      i += 1;
    } else if (arg === "--screen-width" && next) {
      opts.screenWidth = Number(next);
      i += 1;
    } else if (arg === "--screen-height" && next) {
      opts.screenHeight = Number(next);
      i += 1;
    } else if (arg === "--page-margin" && next) {
      opts.pageMargin = next;
      i += 1;
    } else if (arg === "--bookmarks" && next) {
      opts.bookmarks = next.toLowerCase() !== "false";
      i += 1;
    } else if (arg === "--settle-ms" && next) {
      opts.settleMs = Number(next);
      i += 1;
    }
  }

  if (!opts.input || !opts.output) {
    throw new Error(
      "Usage: node scripts/epub-to-pdf.js --input <file.epub> --output <file.pdf> " +
        "[--screen-width 1200] [--screen-height 1800] [--page-margin 18mm] [--bookmarks true] [--settle-ms 3000]",
    );
  }

  if (
    !Number.isFinite(opts.screenWidth) ||
    !Number.isFinite(opts.screenHeight)
  ) {
    throw new Error("screen-width and screen-height must be valid numbers.");
  }
  if (!Number.isFinite(opts.settleMs) || opts.settleMs < 0) {
    throw new Error("settle-ms must be a non-negative number.");
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = path.resolve(opts.input);
  const outputPath = path.resolve(opts.output);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const epubBuffer = await fs.readFile(inputPath);
  const pdfBuffer = await convertEpubToPdf(epubBuffer, {
    screenWidth: opts.screenWidth,
    screenHeight: opts.screenHeight,
    pageMargin: opts.pageMargin,
    bookmarks: opts.bookmarks,
    settleMs: opts.settleMs,
  });

  await fs.writeFile(outputPath, pdfBuffer);
  console.log(`PDF written to: ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
