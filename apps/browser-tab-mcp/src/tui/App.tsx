/**
 * Demo TUI App — shows the layout the starter recommends:
 *   - Header (centered title)
 *   - Main content area (placeholder list — replace with your domain views)
 *   - DevStatsPanel (toggled with `d`)
 *   - StatusBar + HelpBar
 *
 * Keybindings: vim-style j/k/gg/G + Ctrl-D/U for movement; `d` toggles
 * dev stats; `q` or Esc quits.
 */

import { DevStatsPanel, HelpBar, StatusBar, useTheme, useVimKeys } from "@george43g/tui-kit";
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { APP_NAME, APP_VERSION } from "../meta.js";
import { engineLabel } from "../native-bridge.js";

const ITEMS = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  label: `Item ${i + 1} — replace this with your own data source`,
}));

export function App() {
  const theme = useTheme();
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [showStats, setShowStats] = useState(false);

  useVimKeys({
    onMove: (delta) => setCursor((c) => Math.max(0, Math.min(ITEMS.length - 1, c + delta))),
    onTop: () => setCursor(0),
    onBottom: () => setCursor(ITEMS.length - 1),
    onHalfPageDown: () => setCursor((c) => Math.min(ITEMS.length - 1, c + 10)),
    onHalfPageUp: () => setCursor((c) => Math.max(0, c - 10)),
    onUnhandled: () => {},
  });

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    if (input === "d") setShowStats((v) => !v);
  });

  const visibleStart = Math.max(0, cursor - 10);
  const visibleEnd = Math.min(ITEMS.length, visibleStart + 20);
  const visible = ITEMS.slice(visibleStart, visibleEnd);

  return (
    <Box flexDirection="column" height="100%">
      <Box paddingX={1}>
        <Text color={theme.palette.accent} bold>
          {APP_NAME}
        </Text>
        <Text color={theme.palette.fgDim}> v{APP_VERSION}</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} paddingX={1}>
        <Box flexDirection="column" flexGrow={1}>
          {visible.map((item, i) => {
            const idx = visibleStart + i;
            const isCursor = idx === cursor;
            const text = `${String(item.id).padStart(3)} ${item.label}`;
            return isCursor ? (
              <Text key={item.id} color={theme.palette.bg} backgroundColor={theme.palette.accent}>
                {text}
              </Text>
            ) : (
              <Text key={item.id} color={theme.palette.fg}>
                {text}
              </Text>
            );
          })}
        </Box>
        {showStats ? (
          <Box marginLeft={2}>
            <DevStatsPanel visible engine={engineLabel()} />
          </Box>
        ) : null}
      </Box>

      <StatusBar
        mode="browse"
        message={`${cursor + 1} / ${ITEMS.length}`}
        hint={`engine: ${engineLabel()}`}
      />
      <HelpBar
        hints={[
          { key: "j/k", label: "move" },
          { key: "gg/G", label: "top/bottom" },
          { key: "^d/^u", label: "half-page" },
          { key: "d", label: "dev stats" },
          { key: "q", label: "quit" },
        ]}
      />
    </Box>
  );
}
