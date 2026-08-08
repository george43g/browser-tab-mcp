/**
 * Live snapshot hook — subscribes to daemon events when the daemon is up
 * (push updates), else polls the tabs-service every 5s (which itself
 * degrades to direct osascript).
 *
 * The subscription is supervised. Previously only the FIRST subscribe attempt
 * could fall back to polling, so a daemon that restarted (or crashed) after
 * the TUI was already running left the UI frozen on stale data while still
 * captioning itself "daemon stream". A drop now flips back to polling — which
 * is visible in the header — and retries the subscription with backoff.
 */

import type { Snapshot } from "@george43g/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DaemonClient } from "../client/daemon-client.js";
import { getSnapshot } from "../client/tabs-service.js";

const POLL_FALLBACK_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 10_000;

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
    let retryTimer: NodeJS.Timeout | null = null;
    let attempt = 0;

    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setLive(false);
      refresh();
      pollTimer = setInterval(refresh, POLL_FALLBACK_MS);
      pollTimer.unref?.();
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const scheduleRetry = () => {
      if (cancelled || retryTimer) return;
      const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void trySubscribe();
      }, delay);
      retryTimer.unref?.();
    };

    const degrade = () => {
      if (cancelled) return;
      startPolling();
      scheduleRetry();
    };

    const trySubscribe = async (): Promise<void> => {
      if (cancelled) return;
      // Drop any previous client first so its handlers don't outlive it.
      clientRef.current?.close();
      const client = new DaemonClient();
      clientRef.current = client;
      client.onClose(degrade);
      try {
        await client.subscribe((event) => {
          if (cancelled) return;
          if (event.event === "snapshot") setSnapshot(event.data as Snapshot);
        });
        if (cancelled) {
          client.close();
          return;
        }
        attempt = 0;
        setLive(true);
        stopPolling();
        // The stream only pushes on CHANGE, so a fresh subscription would show
        // pre-restart data until the user next touches a tab. Resync once.
        refresh();
      } catch {
        client.close();
        clientRef.current = null;
        degrade();
      }
    };

    void trySubscribe();
    refresh(); // immediate first paint either way

    return () => {
      cancelled = true;
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
      clientRef.current?.close();
    };
  }, [refresh]);

  return { snapshot, live, refresh };
}
