// @vitest-environment happy-dom
/**
 * Real @mozilla/readability + the state probe against the fixture DOM corpus.
 * This is the high-value PR4 test: extraction runs over realistic markup, not
 * mocks, so a regression in the reader or the state probe reddens here.
 */

import { ARTICLE_HTML, DIRTY_FORM_HTML, MEDIA_HTML, SPA_HTML } from "@george43g/test-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { extract, extractMetadata, extractState, extractText } from "../src/extract.js";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Load a fixture into the live happy-dom window (head + body, for state/meta). */
function loadBody(html: string): void {
  const parsed = parse(html);
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.documentElement.setAttribute("lang", parsed.documentElement.getAttribute("lang") ?? "");
}

describe("metadata extraction", () => {
  it("harvests title / description / og:* / canonical / lang", () => {
    const md = extractMetadata(parse(ARTICLE_HTML));
    expect(md.description).toContain("perception API");
    expect(md.ogTitle).toBe("The Tab That Remembered");
    expect(md.ogDescription).toContain("event-sourced");
    expect(md.ogImage).toBe("https://example.com/cover.png");
    expect(md.siteName).toBe("browser-tab journal");
    expect(md.canonical).toBe("https://example.com/the-tab-that-remembered");
    expect(md.lang).toBe("en-GB");
  });
});

describe("text extraction (Readability)", () => {
  it("pulls reader-mode article text + title", () => {
    const { text, title } = extractText(parse(ARTICLE_HTML), 0);
    expect(title).toContain("The Tab That Remembered");
    expect(text).toContain("journal closes");
    expect(text).toContain("navigation counter");
    expect((text ?? "").length).toBeGreaterThan(200);
  });

  it("caps text at maxBytes and flags truncated", () => {
    const { text, truncated } = extractText(parse(ARTICLE_HTML), 40);
    expect((text ?? "").length).toBe(40);
    expect(truncated).toBe(true);
  });

  it("returns empty text for a content-less SPA shell", () => {
    const { text, truncated } = extractText(parse(SPA_HTML), 0);
    expect(text).toBe("");
    expect(truncated).toBeUndefined();
  });
});

describe("state extraction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("counts a form dirty only once a field diverges from its default", () => {
    loadBody(DIRTY_FORM_HTML);
    expect(extractState(window).dirtyForms).toBe(0);
    (document.getElementById("subject") as HTMLInputElement).value = "hi there";
    expect(extractState(window).dirtyForms).toBe(1);
    (document.getElementById("urgent") as HTMLInputElement).checked = true;
    expect(extractState(window).dirtyForms).toBe(1); // still the one form
    (document.getElementById("q") as HTMLInputElement).value = "query";
    expect(extractState(window).dirtyForms).toBe(2); // now both forms
  });

  it("reports a focused editable", () => {
    loadBody(DIRTY_FORM_HTML);
    expect(extractState(window).focusedEditable).toBe(false);
    (document.getElementById("body") as HTMLTextAreaElement).focus();
    expect(extractState(window).focusedEditable).toBe(true);
  });

  it("enumerates media elements", () => {
    loadBody(MEDIA_HTML);
    const media = extractState(window).media;
    expect(media).toHaveLength(2);
    expect(media.map((m) => m.kind).sort()).toEqual(["audio", "video"]);
    expect(media.every((m) => m.paused)).toBe(true);
    expect(media.every((m) => Number.isFinite(m.currentTime))).toBe(true);
  });

  it("counts visible words", () => {
    loadBody(ARTICLE_HTML);
    expect(extractState(window).wordCount).toBeGreaterThan(80);
  });
});

describe("extract() mode dispatch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns metadata for metadata mode, state for state mode", () => {
    loadBody(ARTICLE_HTML);
    const meta = extract(window, "metadata");
    expect(meta.mode).toBe("metadata");
    expect(meta.metadata?.ogTitle).toBe("The Tab That Remembered");
    expect(meta.state).toBeUndefined();

    const state = extract(window, "state");
    expect(state.mode).toBe("state");
    expect(state.state).toBeDefined();
    expect(state.metadata).toBeUndefined();
  });
});
