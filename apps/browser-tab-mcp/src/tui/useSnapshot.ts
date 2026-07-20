/**
 * Live snapshot hook — subscribes to daemon events when the daemon is up
 * (push updates), else polls the tabs-service every 5s (which itself
 * degrades to direct osascript).
 */

import type { Snapshot } from "@george43g/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DaemonClient } from "../client/daemon-client.js";
import { getSnapshot } from "../client/tabs-service.js";

const POLL_FALLBACK_MS = 5_000;

export interface SnapshotFeed {
  snapshot: Snapshot | null;
  live: boolean; // true = daemon event stream; false = polling
  refresh: () => void;
}

export function useSnapshot(): SnapshotFeed {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const clientRef = useRef<DaemonClient | null>(null);

  const refresh = useCallback(() => {
    void getSnapshot({})
      .then(setSnapshot)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setLive(false);
      refresh();
      pollTimer = setInterval(refresh, POLL_FALLBACK_MS);
    };

    const trySubscribe = async () => {
      const client = new DaemonClient();
      clientRef.current = client;
      try {
        await client.subscribe((event) => {
          if (cancelled) return;
          if (event.event === "snapshot") setSnapshot(event.data as Snapshot);
        });
        if (cancelled) return;
        setLive(true);
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch {
        client.close();
        clientRef.current = null;
        startPolling();
      }
    };

    void trySubscribe();
    refresh(); // immediate first paint either way

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      clientRef.current?.close();
    };
  }, [refresh]);

  return { snapshot, live, refresh };
}
