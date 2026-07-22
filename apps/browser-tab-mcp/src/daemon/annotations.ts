/**
 * Annotation store — a deliberately tiny URL-keyed note cache so consumers
 * (the AI on the other side) can stash their own summaries in ONE place. The
 * tool is the cache substrate, never the intelligence.
 *
 * One ndjson file, rewritten on each set (bounded: LRU 500 × 16KB). URL is
 * normalized (hash stripped). No TTLs, no namespaces — YAGNI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { warn } from "@george43g/robustness";
import type { AnnotateOutput } from "@george43g/shared-types";
import { annotationsPath } from "./paths.js";

const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_ENTRIES = 500;

interface Entry {
  url: string;
  note: string;
  updatedAt: number;
}

export class AnnotationStore {
  private readonly path: string;
  private readonly map = new Map<string, Entry>(); // insertion order = LRU (re-set moves to tail)

  constructor(path = annotationsPath()) {
    this.path = path;
    this.warm();
  }

  private normalize(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.toString();
    } catch {
      return url;
    }
  }

  get(url: string): AnnotateOutput {
    const key = this.normalize(url);
    const e = this.map.get(key);
    return e
      ? { url: key, note: e.note, updatedAt: e.updatedAt, existed: true }
      : { url: key, existed: false };
  }

  set(url: string, note: string, now = Date.now()): AnnotateOutput {
    const key = this.normalize(url);
    const existed = this.map.has(key);
    const trimmed = note.length > MAX_ENTRY_BYTES ? note.slice(0, MAX_ENTRY_BYTES) : note;
    this.map.delete(key); // move to tail (freshest)
    this.map.set(key, { url: key, note: trimmed, updatedAt: now });
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.persist();
    return { url: key, note: trimmed, updatedAt: now, existed };
  }

  private warm(): void {
    if (!existsSync(this.path)) return;
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Entry;
          this.map.delete(e.url);
          this.map.set(e.url, e);
        } catch {
          // skip a corrupt line
        }
      }
    } catch {
      // unreadable file — start empty
    }
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const lines = [...this.map.values()].map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(this.path, lines ? `${lines}\n` : "");
    } catch (err) {
      warn("annotations_write_failed", { message: (err as Error).message });
    }
  }
}
