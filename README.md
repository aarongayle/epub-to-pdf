# EPUB to PDF

Converts EPUBs to PDFs using Node.js + Puppeteer. Runs as an HTTP server or a CLI.

Features:
- Configurable screen/page size
- Automatic chapter markers from EPUB TOC entries
- Experimental PDF outline/bookmark generation through Chromium

## Install

```bash
pnpm install
```

## Server

```bash
pnpm start
# or: PORT=8080 node server.js
```

### Streaming response (default)

Long conversions can exceed reverse-proxy or client idle timeouts if the server sends nothing until the PDF is ready. **By default** the server streams **newline-delimited JSON** (`Content-Type: application/x-ndjson`) so bytes flow throughout the job: progress events first, then the PDF as base64 chunks, then a completion line.

Each line is a single JSON object:

| `type` | Description |
|--------|-------------|
| `start` | Conversion began. Includes `epubBytes` (input size). |
| `progress` | `stage` (string), `percent` (0–100), optional `message`. Stages include `start`, `extract`, `parse`, `chapters`, `merge`, `browser`, `load`, `fonts`, `settle`, `pdf`. |
| `pdfChunk` | `data`: base64 fragment of the PDF (concatenate all chunks in order). |
| `complete` | `totalBytes`: final PDF size. |
| `error` | `message`: failure reason. |

Example: save the PDF from a streaming POST with Node:

```javascript
import http from "node:http";
import fs from "node:fs";
import readline from "node:readline";

const epubPath = "book.epub";
const outPath = "book.pdf";

const req = http.request(
  {
    hostname: "localhost",
    port: 3000,
    method: "POST",
    path: "/",
    headers: { "Content-Length": fs.statSync(epubPath).size },
  },
  (res) => {
    const chunks = [];
    const rl = readline.createInterface({ input: res });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const o = JSON.parse(line);
      if (o.type === "progress") {
        console.error(`${o.percent}% ${o.stage}${o.message ? ` — ${o.message}` : ""}`);
      }
      if (o.type === "pdfChunk") chunks.push(Buffer.from(o.data, "base64"));
      if (o.type === "error") {
        console.error(o.message);
        process.exit(1);
      }
      if (o.type === "complete") {
        fs.writeFileSync(outPath, Buffer.concat(chunks));
        console.error(`Wrote ${outPath} (${o.totalBytes} bytes)`);
      }
    });
  },
);
req.on("error", (e) => {
  console.error(e);
  process.exit(1);
});
fs.createReadStream(epubPath).pipe(req);
```

### Raw PDF (no streaming)

For a **single** `application/pdf` response (same behavior as older versions), add **`?binary=1`** (or `format=binary`):

```bash
curl -X POST "http://localhost:3000?binary=1" \
  --data-binary @book.epub \
  -o book.pdf
```

### Query params

Same parameters apply to both streaming and binary modes:

| Param | Default | Description |
|---|---|---|
| `screenWidth` | `400` | Viewport/page width in px |
| `screenHeight` | `600` | Viewport/page height in px |
| `pageMargin` | `25mm` | CSS page margin |
| `fontSize` | *(book default)* | Body font size, e.g. `16px` or `1.2em` |
| `bookmarks` | `true` | Enable Chromium PDF outline |
| `settleMs` | `3000` | Wait time (ms) after DOM load before rendering |
| `binary` | *(off)* | Set to `1` for raw PDF body instead of NDJSON |
| `format` | — | `binary` is an alias for `binary=1` |

Example with params (streaming):

```bash
curl -N -X POST "http://localhost:3000?screenWidth=800&pageMargin=20mm" \
  --data-binary @book.epub -o book.ndjson
```

## CLI

```bash
pnpm convert -- \
  --input "input/book.epub" \
  --output "output/book.pdf" \
  --screen-width 1200 \
  --screen-height 1800 \
  --page-margin 18mm \
  --bookmarks true \
  --settle-ms 3000
```

### CLI options

- `--input` (required): path to `.epub`
- `--output` (required): output `.pdf` path
- `--screen-width`: viewport/page width in px (default `400`)
- `--screen-height`: viewport/page height in px (default `600`)
- `--page-margin`: CSS page margin (default `25mm`)
- `--font-size`: body font size, e.g. `16px` or `1.2em` (default: book's own styles)
- `--bookmarks`: `true`/`false` to enable Chromium outline generation (default `true`)
- `--settle-ms`: wait time after DOM load before PDF render (default `3000`)

## Notes

- EPUB chapter breaks are inferred from the TOC (`.ncx`) and inserted as heading markers, which Chromium can use to generate outline entries.
- Bookmark support depends on the Chromium version bundled with Puppeteer and is still experimental.
