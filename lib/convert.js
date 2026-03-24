import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import puppeteer from "puppeteer";

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHref(href) {
  return decodeURIComponent(String(href || "").split("#")[0]).replace(
    /\\/g,
    "/",
  );
}

function decodeComponentSafe(value) {
  if (typeof value !== "string") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeBookPath(baseBookPath, hrefPath) {
  const baseDir = path.posix.dirname(baseBookPath || "");
  const joined = hrefPath
    ? path.posix.join(baseDir, decodeComponentSafe(hrefPath))
    : baseBookPath;
  const normalized = path.posix.normalize(joined || "");
  return normalized.replace(/^\.\/+/, "");
}

function makeSafeAnchorId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9:_.-]/g, "_");
}

function textFromMaybeObject(val) {
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (!val || typeof val !== "object") return "";
  if (typeof val["#text"] === "string") return val["#text"];
  if (typeof val["text"] === "string") return val["text"];
  return "";
}

function parseNcxNavPoint(navPoint, level, out) {
  const labelNode = navPoint?.navLabel?.text ?? navPoint?.navLabel;
  const title = textFromMaybeObject(labelNode).trim();
  const src = navPoint?.content?.src;
  const href = normalizeHref(src);
  if (href && title && !out.has(href)) {
    out.set(href, { title, level });
  }
  for (const childNavPoint of asArray(navPoint?.navPoint)) {
    parseNcxNavPoint(childNavPoint, level + 1, out);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalReference(baseDir, value) {
  if (!value || typeof value !== "string") return value;
  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("#")
  ) {
    return value;
  }
  const [rawPath, rawHash = ""] = value.split("#");
  const absolutePath = path.resolve(baseDir, rawPath);
  const hash = rawHash ? `#${rawHash}` : "";
  return `${pathToFileURL(absolutePath).href}${hash}`;
}

function resolveBookHyperlink(
  currentChapterDir,
  currentBookPath,
  href,
  htmlHrefSet,
  sectionAnchorByPath,
  elementAnchorByPathHash,
) {
  if (!href || typeof href !== "string") return href;
  const trimmedHref = href.trim();
  if (!trimmedHref) return href;

  if (
    trimmedHref.startsWith("http://") ||
    trimmedHref.startsWith("https://") ||
    trimmedHref.startsWith("data:") ||
    trimmedHref.startsWith("mailto:") ||
    trimmedHref.startsWith("tel:") ||
    trimmedHref.startsWith("javascript:") ||
    trimmedHref.startsWith("//")
  ) {
    return href;
  }

  if (trimmedHref.startsWith("#")) {
    const fragment = decodeComponentSafe(trimmedHref.slice(1));
    const mappedAnchor = elementAnchorByPathHash.get(
      `${currentBookPath}#${fragment}`,
    );
    return mappedAnchor ? `#${mappedAnchor}` : href;
  }

  const [rawPath, rawHash = ""] = trimmedHref.split("#");
  const targetBookPath = normalizeBookPath(currentBookPath, rawPath);
  const hasHash = rawHash.length > 0;
  const fragment = hasHash ? decodeComponentSafe(rawHash) : "";

  if (hasHash) {
    const mappedAnchor = elementAnchorByPathHash.get(
      `${targetBookPath}#${fragment}`,
    );
    if (mappedAnchor) return `#${mappedAnchor}`;
  }

  if (!htmlHrefSet.has(targetBookPath)) {
    return resolveLocalReference(currentChapterDir, href);
  }

  const sectionAnchor = sectionAnchorByPath.get(targetBookPath);
  if (!sectionAnchor) return href;
  return `#${sectionAnchor}`;
}

function demoteSourceHeadings($) {
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const $el = $(el);
    const tagName = String(el?.tagName || "h1").toLowerCase();
    const $replacement = $("<div></div>");

    for (const [name, value] of Object.entries(el?.attribs || {})) {
      if (name === "role" || name === "aria-level") continue;
      $replacement.attr(name, value);
    }

    const className = $replacement.attr("class");
    $replacement.attr(
      "class",
      className
        ? `${className} epub-heading ${tagName}`
        : `epub-heading ${tagName}`,
    );

    $replacement.html($el.html() || "");
    $el.replaceWith($replacement);
  });
}

/**
 * Convert an EPUB buffer to a PDF buffer.
 *
 * @param {Buffer} epubBuffer - Raw EPUB file contents
 * @param {object} [opts]
 * @param {number} [opts.screenWidth=400]
 * @param {number} [opts.screenHeight=600]
 * @param {string} [opts.pageMargin="25mm"]
 * @param {boolean} [opts.bookmarks=true]
 * @param {number} [opts.settleMs=3000]
 * @param {string} [opts.fontSize] - CSS font-size on the body, e.g. "16px" or "1.2em"
 * @returns {Promise<Buffer>} PDF file contents
 */
export async function convertEpubToPdf(epubBuffer, opts = {}) {
  const {
    screenWidth = 400,
    screenHeight = 600,
    pageMargin = "25mm",
    bookmarks = true,
    settleMs = 3000,
    fontSize = null,
  } = opts;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "epub-to-pdf-"));

  try {
    const epubPath = path.join(tempRoot, "input.epub");
    await fs.writeFile(epubPath, epubBuffer);

    const extractedDir = path.join(tempRoot, "epub");
    await fs.mkdir(extractedDir, { recursive: true });
    new AdmZip(epubPath).extractAllTo(extractedDir, true);

    const containerPath = path.join(
      extractedDir,
      "META-INF",
      "container.xml",
    );
    const containerXml = await fs.readFile(containerPath, "utf8");
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      trimValues: true,
    });
    const container = xmlParser.parse(containerXml);
    const rootfile =
      container?.container?.rootfiles?.rootfile?.["@_full-path"] ||
      asArray(container?.container?.rootfiles?.rootfile)[0]?.["@_full-path"];

    if (!rootfile) {
      throw new Error(
        "Could not find root OPF file in META-INF/container.xml.",
      );
    }

    const opfPath = path.resolve(extractedDir, rootfile);
    const opfDir = path.dirname(opfPath);
    const opfXml = await fs.readFile(opfPath, "utf8");
    const opf = xmlParser.parse(opfXml)?.package;

    const manifestItems = new Map();
    for (const item of asArray(opf?.manifest?.item)) {
      manifestItems.set(item?.["@_id"], item);
    }

    const spine = asArray(opf?.spine?.itemref);
    const tocId = opf?.spine?.["@_toc"];
    const tocItem = tocId ? manifestItems.get(tocId) : null;

    let tocPath = tocItem ? path.resolve(opfDir, tocItem["@_href"]) : "";
    if (!tocPath) {
      for (const item of manifestItems.values()) {
        if (item?.["@_media-type"] === "application/x-dtbncx+xml") {
          tocPath = path.resolve(opfDir, item["@_href"]);
          break;
        }
      }
    }

    const chapterTocEntries = new Map();
    if (tocPath && (await fileExists(tocPath))) {
      const tocXml = await fs.readFile(tocPath, "utf8");
      const toc = xmlParser.parse(tocXml);
      for (const navPoint of asArray(toc?.ncx?.navMap?.navPoint)) {
        parseNcxNavPoint(navPoint, 1, chapterTocEntries);
      }
    }

    const cssLinks = new Set();
    const chapterHtmlParts = [];
    const sectionAnchorByPath = new Map();
    const elementAnchorByPathHash = new Map();
    const htmlHrefSet = new Set();
    const chapterEntries = [];
    let lastInsertedChapterTitle = "";
    let sectionCounter = 0;

    for (const itemRef of spine) {
      const item = manifestItems.get(itemRef?.["@_idref"]);
      if (!item) continue;

      const mediaType = item?.["@_media-type"] || "";
      const isHtml =
        mediaType.includes("xhtml") || mediaType.includes("html");
      if (!isHtml) continue;

      const chapterHref = item["@_href"];
      const normalizedHref = normalizeHref(chapterHref);
      htmlHrefSet.add(normalizedHref);
      const chapterPath = path.resolve(opfDir, chapterHref);
      const chapterDir = path.dirname(chapterPath);

      if (!(await fileExists(chapterPath))) continue;

      const chapterRaw = await fs.readFile(chapterPath, "utf8");
      const $ = load(chapterRaw, { xmlMode: false, decodeEntities: false });

      for (const link of $("link[rel='stylesheet']").toArray()) {
        const href = $(link).attr("href");
        if (href) {
          cssLinks.add(resolveLocalReference(chapterDir, href));
        }
      }

      $("img, source, video, audio, object, embed, script").each((_, el) => {
        const attr = $(el).attr("src");
        if (attr) {
          $(el).attr("src", resolveLocalReference(chapterDir, attr));
        }
        const poster = $(el).attr("poster");
        if (poster) {
          $(el).attr("poster", resolveLocalReference(chapterDir, poster));
        }
      });

      sectionCounter += 1;
      const sectionAnchor = `epub-section-${sectionCounter}`;
      sectionAnchorByPath.set(normalizedHref, sectionAnchor);

      $("[id]").each((_, el) => {
        const existingId = $(el).attr("id");
        if (!existingId) return;
        const mappedId = `${sectionAnchor}-${makeSafeAnchorId(existingId)}`;
        $(el).attr("id", mappedId);
        elementAnchorByPathHash.set(
          `${normalizedHref}#${existingId}`,
          mappedId,
        );
      });

      $("a[name]").each((_, el) => {
        const nameValue = $(el).attr("name");
        if (!nameValue) return;
        const mappedId = `${sectionAnchor}-${makeSafeAnchorId(nameValue)}`;
        if (!$(el).attr("id")) {
          $(el).attr("id", mappedId);
        }
        elementAnchorByPathHash.set(
          `${normalizedHref}#${nameValue}`,
          mappedId,
        );
      });

      const chapterBodySnapshot =
        $("body").length > 0
          ? $("body").html() || ""
          : $.root().html() || "";
      if (!chapterBodySnapshot.trim()) continue;

      const explicitTocEntry = chapterTocEntries.get(normalizedHref);
      let shouldInsertBreak = false;
      let chapterTitle = "";
      let chapterHeadingLevel = 1;

      if (
        explicitTocEntry?.title &&
        explicitTocEntry.title !== lastInsertedChapterTitle
      ) {
        chapterTitle = explicitTocEntry.title;
        chapterHeadingLevel = Math.min(
          Math.max(explicitTocEntry.level || 1, 1),
          6,
        );
        shouldInsertBreak = true;
        lastInsertedChapterTitle = explicitTocEntry.title;
      }

      if (!chapterTitle) {
        const inferred = $("h1, h2, title").first().text().trim();
        if (inferred && inferred !== lastInsertedChapterTitle) {
          chapterTitle = inferred;
          chapterHeadingLevel = 2;
          shouldInsertBreak = true;
          lastInsertedChapterTitle = inferred;
        }
      }

      demoteSourceHeadings($);

      const chapterHeading = chapterTitle
        ? `<h${chapterHeadingLevel} class="chapter-marker toc-level-${chapterHeadingLevel}">${chapterTitle}</h${chapterHeadingLevel}>`
        : "";
      chapterEntries.push({
        $,
        normalizedHref,
        chapterHeading,
        shouldInsertBreak,
        sectionIndex: sectionCounter,
        sectionAnchor,
        chapterDir,
      });
    }

    for (const chapterEntry of chapterEntries) {
      const { $, normalizedHref, chapterDir } = chapterEntry;
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const mappedHref = resolveBookHyperlink(
          chapterDir,
          normalizedHref,
          href,
          htmlHrefSet,
          sectionAnchorByPath,
          elementAnchorByPathHash,
        );
        $(el).attr("href", mappedHref);
      });

      const chapterBody =
        $("body").length > 0
          ? $("body").html() || ""
          : $.root().html() || "";
      chapterHtmlParts.push(
        `<section id="${chapterEntry.sectionAnchor}" class="epub-section${chapterEntry.shouldInsertBreak ? " chapter-start" : ""}" data-index="${chapterEntry.sectionIndex}">
        ${chapterEntry.chapterHeading}
        ${chapterBody}
      </section>`,
      );
    }

    const cssTagBlock = Array.from(cssLinks)
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join("\n");

    const mergedHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>EPUB Print</title>
    ${cssTagBlock}
    <style>
      @page {
        size: ${screenWidth}px ${screenHeight}px;
        margin: ${pageMargin};
      }
      html, body {
        width: auto;
        max-width: 100%;
        margin: 0;
        padding: 0;
      }
      body {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
        overflow-wrap: anywhere;
        ${fontSize ? `font-size: ${fontSize};` : ""}
      }
      .epub-section {
        break-inside: avoid;
        max-width: 100%;
      }
      .chapter-start {
        break-before: page;
      }
      table, pre, code, blockquote {
        max-width: 100%;
      }
      .chapter-marker {
        break-after: avoid;
        margin: 0 0 12px 0;
        font-size: 24px;
        line-height: 1.25;
      }
      .epub-heading {
        display: block;
      }
      .epub-heading.h1 {
        font-size: 2em;
        margin: 0.67em 0;
        font-weight: 700;
      }
      .epub-heading.h2 {
        font-size: 1.5em;
        margin: 0.83em 0;
        font-weight: 700;
      }
      .epub-heading.h3 {
        font-size: 1.17em;
        margin: 1em 0;
        font-weight: 700;
      }
      .epub-heading.h4,
      .epub-heading.h5,
      .epub-heading.h6 {
        margin: 1.1em 0;
        font-weight: 700;
      }
      img, svg {
        max-width: 100%;
      }
    </style>
  </head>
  <body>
    ${chapterHtmlParts.join("\n")}
  </body>
</html>`;

    const mergedHtmlPath = path.join(tempRoot, "merged.html");
    await fs.writeFile(mergedHtmlPath, mergedHtml, "utf8");

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--allow-file-access-from-files", "--no-sandbox", "--disable-setuid-sandbox"],
      protocolTimeout: 0,
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: screenWidth, height: screenHeight });
      await page.goto(pathToFileURL(mergedHtmlPath).href, {
        waitUntil: "domcontentloaded",
        timeout: 0,
      });
      await page.emulateMediaType("screen");
      await page.evaluate(async () => {
        if (document.fonts?.ready) {
          await document.fonts.ready;
        }
      });
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      const pdfBuffer = await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        outline: bookmarks,
        tagged: true,
        timeout: 0,
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
