/**
 * Synthetic ordered-view fixture: a deliberately NON-browser domain (a music
 * library) proving the language is domain-agnostic. Exported publicly — the
 * later model-facing evaluation corpus (spec §26.4) and any second domain's
 * conformance tests reuse it.
 *
 * Shape:
 *   library L
 *   ├── playlist p1 "Focus"  → t1..t5
 *   ├── playlist p2 "Gym"    → t6..t8
 *   └── playlist p3 "Empty"  → (no tracks)
 *
 * Kinds: "library" | "playlist" | "track".
 * Relations: "playlists" (library→playlist), "tracks" (playlist→track).
 * Scopes: "allPlaylists", "allTracks" (visual order), "focusedPlaylist" (p1).
 * Fields: title (string), durationSec (number), rating (number, t7/t8 have
 * none — the unknown-policy fixtures), liked (boolean).
 */

import type { FieldType, SelectionDomain } from "./domain.js";

export interface FixtureEntity {
  kind: "library" | "playlist" | "track";
  key: string;
  title: string;
  durationSec?: number;
  rating?: number;
  liked?: boolean;
}

interface FixtureState {
  entities: Map<string, FixtureEntity>;
  childrenOf: Map<string, string[]>;
  parentOf: Map<string, string>;
}

export interface SyntheticTrack {
  key: string;
  title: string;
  durationSec: number;
  rating?: number;
  liked: boolean;
}

const DEFAULT_TRACKS: Record<string, SyntheticTrack[]> = {
  p1: [
    { key: "t1", title: "Alpha", durationSec: 180, rating: 5, liked: true },
    { key: "t2", title: "Beta", durationSec: 240, rating: 3, liked: false },
    { key: "t3", title: "Gamma", durationSec: 200, rating: 4, liked: true },
    { key: "t4", title: "Delta", durationSec: 320, rating: 2, liked: false },
    { key: "t5", title: "Alpha Reprise", durationSec: 150, rating: 5, liked: true },
  ],
  p2: [
    { key: "t6", title: "Sprint", durationSec: 210, rating: 4, liked: false },
    { key: "t7", title: "Lift", durationSec: 260, liked: true },
    { key: "t8", title: "Cooldown", durationSec: 300, liked: false },
  ],
  p3: [],
};

/** Build the synthetic domain. Pass custom playlists to reshape the forest. */
export function makeSyntheticDomain(
  playlists: Record<string, SyntheticTrack[]> = DEFAULT_TRACKS,
): SelectionDomain<FixtureEntity> {
  const st: FixtureState = { entities: new Map(), childrenOf: new Map(), parentOf: new Map() };
  const lib: FixtureEntity = { kind: "library", key: "L", title: "Library" };
  st.entities.set(lib.key, lib);
  st.childrenOf.set(lib.key, []);
  const titles: Record<string, string> = { p1: "Focus", p2: "Gym", p3: "Empty" };
  for (const [pk, tracks] of Object.entries(playlists)) {
    const pl: FixtureEntity = { kind: "playlist", key: pk, title: titles[pk] ?? pk };
    st.entities.set(pk, pl);
    st.childrenOf.get(lib.key)?.push(pk);
    st.parentOf.set(pk, lib.key);
    st.childrenOf.set(pk, []);
    for (const t of tracks) {
      const te: FixtureEntity = {
        kind: "track",
        key: t.key,
        title: t.title,
        durationSec: t.durationSec,
        liked: t.liked,
      };
      if (t.rating !== undefined) te.rating = t.rating;
      st.entities.set(t.key, te);
      st.childrenOf.get(pk)?.push(t.key);
      st.parentOf.set(t.key, pk);
    }
  }

  const scopes = new Map<string, string>([
    ["allPlaylists", "playlist"],
    ["allTracks", "track"],
    ["focusedPlaylist", "playlist"],
  ]);
  const relations = new Map<string, string>([
    ["playlists", "playlist"],
    ["tracks", "track"],
  ]);
  const fields = new Map<string, FieldType>([
    ["title", "string"],
    ["durationSec", "number"],
    ["rating", "number"],
    ["liked", "boolean"],
  ]);
  const relationSource: Record<string, "library" | "playlist"> = {
    playlists: "library",
    tracks: "playlist",
  };

  const children = (key: string): FixtureEntity[] =>
    (st.childrenOf.get(key) ?? []).map((k) => st.entities.get(k) as FixtureEntity);

  return {
    kindOf: (r) => r.kind,
    stableKey: (r) => r.key,
    byKey: (k) => st.entities.get(k),
    scopes: () => scopes,
    scopeMembers: (name) => {
      switch (name) {
        case "allPlaylists":
          return children(lib.key);
        case "allTracks":
          return children(lib.key).flatMap((p) => children(p.key));
        case "focusedPlaylist": {
          const first = children(lib.key)[0];
          return first ? [first] : [];
        }
        default:
          return [];
      }
    },
    relations: () => relations,
    orderedMembers: (parent, relation) => {
      const src = relationSource[relation];
      if (src === undefined || parent.kind !== src) return undefined;
      return children(parent.key);
    },
    parentOf: (r) => {
      const pk = st.parentOf.get(r.key);
      return pk === undefined ? undefined : st.entities.get(pk);
    },
    siblingsOf: (r) => {
      const pk = st.parentOf.get(r.key);
      if (pk === undefined) return [r];
      return children(pk);
    },
    fields: () => fields,
    readField: (r, field) => {
      switch (field) {
        case "title":
          return r.title;
        case "durationSec":
          return r.durationSec;
        case "rating":
          return r.rating;
        case "liked":
          return r.liked;
        default:
          return undefined;
      }
    },
  };
}
