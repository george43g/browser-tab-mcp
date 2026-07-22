/**
 * Page content / state extraction — injected on demand into a tab via
 * chrome.scripting.executeScript (never a persistent content script). Defines
 * an idempotent global `window.__btExtract(mode, maxBytes)` the injector calls.
 *
 * Three modes:
 *   metadata — title / description / og:* / canonical / lang (cheap).
 *   text     — reader-mode article text via @mozilla/readability (bundled).
 *   state    — live "where the user left this" signals: dirty forms, playing
 *              media, scroll depth, selection, word count (the blur capture).
 *
 * NO AI here — the tool returns raw signals; the consumer interprets. Kept
 * dependency-free of the workspace (types are local): this file is serialized
 * into the page, and the daemon validates the shape with Zod on receipt.
 */

import { Readability } from "@mozilla/readability";

interface PageMetadata {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  canonical?: string;
  lang?: string;
  siteName?: string;
}

interface PageMedia {
  kind: "audio" | "video";
  paused: boolean;
  currentTime: number;
  duration: number;
}

interface PageState {
  dirtyForms: number;
  focusedEditable: boolean;
  media: PageMedia[];
  scrollY: number;
  scrollPct: number;
  selectionLength: number;
  wordCount: number;
}

interface ExtractResult {
  mode: string;
  url: string;
  title?: string;
  text?: string;
  byline?: string;
  excerpt?: string;
  metadata?: PageMetadata;
  state?: PageState;
  truncated?: boolean;
  error?: string;
}

function attr(doc: Document, selector: string, name: string): string | undefined {
  const el = doc.querySelector(selector);
  const v = el?.getAttribute(name)?.trim();
  return v ? v : undefined;
}

export function extractMetadata(doc: Document): PageMetadata {
  const out: PageMetadata = {};
  const title = doc.title?.trim();
  if (title) out.title = title;
  const set = (key: keyof PageMetadata, value: string | undefined) => {
    if (value) out[key] = value;
  };
  set("description", attr(doc, 'meta[name="description"]', "content"));
  set("ogTitle", attr(doc, 'meta[property="og:title"]', "content"));
  set("ogDescription", attr(doc, 'meta[property="og:description"]', "content"));
  set("ogImage", attr(doc, 'meta[property="og:image"]', "content"));
  set("siteName", attr(doc, 'meta[property="og:site_name"]', "content"));
  set("canonical", attr(doc, 'link[rel="canonical"]', "href"));
  const lang = doc.documentElement?.getAttribute("lang")?.trim();
  if (lang) out.lang = lang;
  return out;
}

export function extractText(
  doc: Document,
  maxBytes = 0,
): Pick<ExtractResult, "text" | "title" | "byline" | "excerpt" | "truncated"> {
  // Readability mutates the document, so parse a clone.
  const clone = doc.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  let text = (article?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  let truncated = false;
  if (maxBytes > 0 && text.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }
  const out: Pick<ExtractResult, "text" | "title" | "byline" | "excerpt" | "truncated"> = { text };
  if (article?.title) out.title = article.title;
  if (article?.byline) out.byline = article.byline;
  if (article?.excerpt) out.excerpt = article.excerpt;
  if (truncated) out.truncated = true;
  return out;
}

function isFieldDirty(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
    return el.value !== el.defaultValue;
  }
  if (el instanceof HTMLTextAreaElement) return el.value !== el.defaultValue;
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.options).some((o) => o.selected !== o.defaultSelected);
  }
  return false;
}

export function extractState(win: Window): PageState {
  const doc = win.document;
  let dirtyForms = 0;
  for (const form of Array.from(doc.querySelectorAll("form"))) {
    if (Array.from(form.elements).some((el) => isFieldDirty(el))) dirtyForms++;
  }
  const active = doc.activeElement;
  const focusedEditable = Boolean(
    active &&
      (active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active as HTMLElement).isContentEditable),
  );
  const media: PageMedia[] = Array.from(doc.querySelectorAll("video, audio")).map((m) => {
    const el = m as HTMLMediaElement;
    return {
      kind: m.tagName.toLowerCase() === "video" ? "video" : "audio",
      paused: el.paused,
      currentTime: Number.isFinite(el.currentTime) ? el.currentTime : 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    };
  });
  const scrollY = win.scrollY || 0;
  const scrollable = (doc.documentElement?.scrollHeight ?? 0) - (win.innerHeight || 0);
  const scrollPct = scrollable > 0 ? Math.min(100, Math.round((scrollY / scrollable) * 100)) : 0;
  const selectionLength = win.getSelection()?.toString().length ?? 0;
  const words = (doc.body?.textContent ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    dirtyForms,
    focusedEditable,
    media,
    scrollY,
    scrollPct,
    selectionLength,
    wordCount: words.length,
  };
}

export function extract(win: Window, mode: string, maxBytes = 0): ExtractResult {
  const doc = win.document;
  const base: ExtractResult = { mode, url: win.location?.href ?? "" };
  if (doc.title) base.title = doc.title;
  if (mode === "metadata") return { ...base, metadata: extractMetadata(doc) };
  if (mode === "state") return { ...base, state: extractState(win) };
  return { ...base, ...extractText(doc, maxBytes) };
}

declare global {
  interface Window {
    __btExtract?: (mode: string, maxBytes?: number) => unknown;
  }
}

(() => {
  if (typeof window === "undefined") return;
  if (typeof window.__btExtract === "function") return; // idempotent define
  window.__btExtract = (mode: string, maxBytes = 0): unknown => {
    try {
      return extract(window, mode, maxBytes);
    } catch (err) {
      return {
        mode,
        url: window.location?.href ?? "",
        error: (err as Error)?.message ?? String(err),
      };
    }
  };
})();
