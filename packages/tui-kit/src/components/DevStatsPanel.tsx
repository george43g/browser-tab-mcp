/**
 * Toggleable dev stats panel — shows process + watchdog metrics in a corner
 * of the TUI. Bind to a key (typically `d`) in the host App.
 */

import { Box, Text } from "ink";
import { useDevStats } from "../hooks/useDevStats.js";
import { useTheme } from "../theme/ThemeContext.js";

export interface DevStatsPanelProps {
  /** When false, the panel is not rendered. Wire to a key-toggled boolean. */
  visible: boolean;
  /** Optional caller-supplied engine label (e.g. "Rust" or "TS"). */
  engine?: string;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function DevStatsPanel({ visible, engine }: DevStatsPanelProps) {
  const stats = useDevStats();
  const theme = useTheme();

  if (!visible) return null;

  const issuesColor =
    stats.eventLoopP99Ms >= 5000
      ? theme.palette.danger
      : stats.eventLoopP99Ms >= 500
        ? theme.palette.warning
        : theme.palette.success;

  return (
    <Box borderStyle="round" borderColor={theme.palette.border} flexDirection="column" paddingX={1}>
      <Text color={theme.palette.accent} bold>
        dev stats
      </Text>
      <Text color={theme.palette.fgDim}>
        pid {stats.pid} · up {fmtDuration(stats.uptimeSec)}
        {engine ? ` · ${engine}` : ""}
      </Text>
      <Text color={theme.palette.fgMuted}>
        cpu {stats.cpuPercent}% · heap {stats.heapMb} MB · rss {stats.rssMb} MB
      </Text>
      <Text color={issuesColor}>
        evt-loop p99 {stats.eventLoopP99Ms}ms (max {stats.eventLoopMaxMs}ms)
      </Text>
      <Text color={theme.palette.fgDim}>last activity {stats.lastActivityAgoSec}s ago</Text>
      {stats.killReason ? <Text color={theme.palette.danger}>kill: {stats.killReason}</Text> : null}
    </Box>
  );
}
