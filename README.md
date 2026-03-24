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

Send a POST request with the raw EPUB as the body; receive the PDF back:

```bash
curl -X POST http://localhost:3000 \
  --data-binary @book.epub \
  -o book.pdf
```

### Query params

| Param | Default | Description |
|---|---|---|
| `screenWidth` | `400` | Viewport/page width in px |
| `screenHeight` | `600` | Viewport/page height in px |
| `pageMargin` | `25mm` | CSS page margin |
| `bookmarks` | `true` | Enable Chromium PDF outline |
| `settleMs` | `3000` | Wait time (ms) after DOM load before rendering |

Example with params:

```bash
curl -X POST "http://localhost:3000?screenWidth=800&pageMargin=20mm" \
  --data-binary @book.epub \
  -o book.pdf
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
- `--bookmarks`: `true`/`false` to enable Chromium outline generation (default `true`)
- `--settle-ms`: wait time after DOM load before PDF render (default `3000`)

## Notes

- EPUB chapter breaks are inferred from the TOC (`.ncx`) and inserted as heading markers, which Chromium can use to generate outline entries.
- Bookmark support depends on the Chromium version bundled with Puppeteer and is still experimental.
