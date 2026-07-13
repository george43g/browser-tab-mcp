/**
 * Bottom status bar with mode indicator + message slot.
 *
 * A thin reusable container — the host provides mode label + status text.
 */

import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeContext.js";

export interface StatusBarProps {
  mode: string;
  message?: string;
  hint?: string;
}

export function StatusBar({ mode, message, hint }: StatusBarProps) {
  const theme = useTheme();
  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.palette.borderDim}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text color={theme.palette.accent} bold>
          {`[${mode}]`}
        </Text>
        {message ? <Text color={theme.palette.fg}> {message}</Text> : null}
      </Box>
      {hint ? <Text color={theme.palette.fgDim}>{hint}</Text> : null}
    </Box>
  );
}
