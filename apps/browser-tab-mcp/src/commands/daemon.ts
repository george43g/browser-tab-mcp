/**
 * `browser-tab daemon <run|install|uninstall|status|stop|restart>` —
 * command registrar for the daemon lifecycle.
 *
 * run       foreground daemon (what launchd executes)
 * install   write + bootstrap the LaunchAgent plist
 * uninstall bootout + remove the plist
 * status    launchd state + live daemon status over the socket
 * stop      launchctl bootout (KeepAlive would resurrect a plain kill)
 * restart   launchctl kickstart -k
 */

import { printJson, resolveOutputMode } from "@george43g/cli-kit";
import type { Command } from "commander";
import { daemonStatus } from "../client/tabs-service.js";
import { runDaemon } from "../daemon/index.js";
import {
  installLaunchAgent,
  kickstartLaunchAgent,
  launchAgentStatus,
  uninstallLaunchAgent,
} from "../daemon/launchd.js";
import { LAUNCHD_LABEL, socketPath } from "../daemon/paths.js";
import { ensureToken } from "../daemon/token.js";
import { renderDaemonStatus } from "../render.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the browser-tab daemon (polling engine + IPC + extension socket)");

  daemon
    .command("run")
    .description("Run the daemon in the foreground (launchd invokes this)")
    .action(async () => {
      await runDaemon();
    });

  daemon
    .command("install")
    .description("Install + start the launchd LaunchAgent")
    .action(async () => {
      process.stdout.write(`${await installLaunchAgent()}\n`);
    });

  daemon
    .command("uninstall")
    .description("Stop + remove the launchd LaunchAgent")
    .action(async () => {
      process.stdout.write(`${await uninstallLaunchAgent()}\n`);
    });

  daemon
    .command("status")
    .description("Show launchd + live daemon status")
    .action(async () => {
      const agent = await launchAgentStatus();
      const live = await daemonStatus();
      const payload = {
        launchAgent: `${LAUNCHD_LABEL}: ${agent.detail}`,
        socket: socketPath(),
        ...live,
      };
      // Same precedence as every other read command: --json / piped / CI keep
      // the exact JSON, an interactive terminal gets the summary.
      if (
        resolveOutputMode({ json: program.opts<{ json?: boolean }>().json ?? false }) === "json"
      ) {
        printJson(payload);
      } else {
        process.stdout.write(`${renderDaemonStatus(payload)}\n`);
      }
      if (!live.reachable) process.exitCode = 1;
    });

  daemon
    .command("token")
    .description("Print the extension auth token (paste into the extension options page)")
    .action(() => {
      process.stdout.write(`${ensureToken()}\n`);
    });

  daemon
    .command("stop")
    .description("Stop the daemon (launchctl bootout — a plain kill gets resurrected)")
    .action(async () => {
      process.stdout.write(`${await uninstallLaunchAgent()}\n`);
    });

  daemon
    .command("restart")
    .description("Restart the daemon (launchctl kickstart -k)")
    .action(async () => {
      await kickstartLaunchAgent(true);
      process.stdout.write("kickstarted.\n");
    });
}
