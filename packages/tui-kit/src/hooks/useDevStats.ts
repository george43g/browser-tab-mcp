/**
 * Dev stats hook — samples process metrics + watchdog state on a 2s timer.
 *
 * Generalized from imsg-mcp/src/tui/hooks/useDevStats.ts. The TUI renders
 * the result via DevStatsPanel; toggled with the `d` key in the host App.
 */

import { readWatchdogState } from "@george43g/robustness";
import { useEffect, useState } from "react";

export interface DevStats {
  pid: number;
  uptimeSec: number;
  cpuPercent: number;
  heapMb: number;
  rssMb: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  lastActivityAgoSec: number;
  killReason: string | null;
}

const SAMPLE_INTERVAL_MS = 2000;

function readNow(
  prevCpu: NodeJS.CpuUsage | null,
  prevHrTime: bigint | null,
): {
  stats: DevStats;
  cpu: NodeJS.CpuUsage;
  hrTime: bigint;
} {
  const cpu = process.cpuUsage();
  const hrTime = process.hrtime.bigint();
  const memory = process.memoryUsage();
  const watchdog = readWatchdogState();

  let cpuPercent = 0;
  if (prevCpu && prevHrTime !== null) {
    const userDelta = cpu.user - prevCpu.user;
    const sysDelta = cpu.system - prevCpu.system;
    const cpuUsec = userDelta + sysDelta;
    const wallNs = Number(hrTime - prevHrTime);
    const wallUsec = wallNs / 1000;
    if (wallUsec > 0) cpuPercent = Math.min(999, (cpuUsec / wallUsec) * 100);
  }

  return {
    stats: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      heapMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
      rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      eventLoopP99Ms: Math.round(watchdog.eventLoopP99Ms * 10) / 10,
      eventLoopMaxMs: Math.round(watchdog.eventLoopMaxMs * 10) / 10,
      lastActivityAgoSec: Math.round((Date.now() - watchdog.lastActivityTs) / 1000),
      killReason: watchdog.killReason,
    },
    cpu,
    hrTime,
  };
}

export function useDevStats(): DevStats {
  const initial = readNow(null, null);
  const [stats, setStats] = useState<DevStats>(initial.stats);

  useEffect(() => {
    let prevCpu = initial.cpu;
    let prevHrTime = initial.hrTime;
    const id = setInterval(() => {
      const r = readNow(prevCpu, prevHrTime);
      prevCpu = r.cpu;
      prevHrTime = r.hrTime;
      setStats(r.stats);
    }, SAMPLE_INTERVAL_MS);
    id.unref();
    return () => clearInterval(id);
  }, [initial.cpu, initial.hrTime]);

  return stats;
}
