/**
 * Two-line help legend showing keybindings.
 *
 * Caller passes a list of { key, label } pairs. We render them
 * comma-separated, color-coding the key glyphs with the accent.
 */

import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeContext.js";

export interface KeyHint {
  key: string;
  label: string;
}

export interface HelpBarProps {
  hints: KeyHint[];
}

export function HelpBar({ hints }: HelpBarProps) {
  const theme = useTheme();
  return (
    <Box flexWrap="wrap" paddingX={1}>
      {hints.map((h, i) => (
        <Box key={h.key + h.label} marginRight={2}>
          <Text color={theme.palette.accent} bold>
            {h.key}
          </Text>
          <Text color={theme.palette.fgDim}> {h.label}</Text>
          {i < hints.length - 1 ? <Text color={theme.palette.borderDim}> · </Text> : null}
        </Box>
      ))}
    </Box>
  );
}
