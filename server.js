import http from "node:http";
import { convertEpubToPdf } from "./lib/convert.js";

const PORT = Number(process.env.PORT) || 3000;

/**
 * Parse a query string value as a number, returning the fallback if invalid.
 */
function parseNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Collect the full request body into a Buffer.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer(async (req, res) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed — send a POST request with an EPUB body.");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = url.searchParams;

  const opts = {
    screenWidth: parseNum(qs.get("screenWidth"), 400),
    screenHeight: parseNum(qs.get("screenHeight"), 600),
    pageMargin: qs.get("pageMargin") ?? "25mm",
    bookmarks: qs.get("bookmarks") !== "false",
    settleMs: parseNum(qs.get("settleMs"), 3000),
    fontSize: qs.get("fontSize") ?? null,
  };

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Failed to read request body: ${err.message}`);
    return;
  }

  if (!body.length) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Empty body — send the raw EPUB file as the request body.");
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Converting ${(body.length / 1024).toFixed(1)} KB EPUB…`,
  );

  try {
    const pdfBuffer = await convertEpubToPdf(body, opts);
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": pdfBuffer.length,
      "Content-Disposition": 'attachment; filename="output.pdf"',
    });
    res.end(pdfBuffer);
    console.log(
      `[${new Date().toISOString()}] Done — sent ${(pdfBuffer.length / 1024).toFixed(1)} KB PDF.`,
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Conversion failed:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Conversion failed: ${err.message || err}`);
    }
  }
});

server.listen(PORT, () => {
  console.log(`epub-to-pdf server listening on http://localhost:${PORT}`);
  console.log();
  console.log("Usage:");
  console.log(
    `  curl -X POST http://localhost:${PORT} \\`,
  );
  console.log(`    --data-binary @book.epub \\`);
  console.log(`    -o book.pdf`);
  console.log();
  console.log("Optional query params:");
  console.log(
    "  screenWidth (default 400), screenHeight (default 600), pageMargin (default 25mm),",
  );
  console.log("  bookmarks (default true), settleMs (default 3000)");
});
