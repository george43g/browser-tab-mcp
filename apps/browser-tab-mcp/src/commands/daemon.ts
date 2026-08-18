/**
 * `browser-tab daemon <run|install|uninstall|status|stop|restart>` —
 * command registrar for the daemon lifecycle.
 *
 * run       foreground daemon (what the service manager executes)
 * install   register the daemon to start at login
 * uninstall deregister it
 * status    service state + live daemon status over the socket/pipe
 * stop      deregister (a plain kill gets resurrected by KeepAlive)
 * restart   restart the managed daemon
 *
 * THE MECHANISM IS NOT THIS FILE'S BUSINESS. macOS uses a launchd LaunchAgent,
 * Windows a Task Scheduler ONLOGON task, and anything else refuses with an
 * instruction — all behind `serviceManager()` (daemon/service.ts). Keeping the
 * platform knowledge there means these verbs read the same everywhere and
 * adding an OS is a new file, not six more branches here.
 */

import { printJson, resolveOutputMode } from "@george43g/cli-kit";
import type { Command } from "commander";
import { daemonStatus } from "../client/tabs-service.js";
import { runDaemon } from "../daemon/index.js";
import { socketPath } from "../daemon/paths.js";
import { serviceManager } from "../daemon/service.js";
import { ensureToken } from "../daemon/token.js";
import { renderDaemonStatus } from "../render.js";

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the browser-tab daemon (polling engine + IPC + extension socket)");

  daemon
    .command("run")
    .description("Run the daemon in the foreground (the service manager invokes this)")
    .action(async () => {
      await runDaemon();
    });

  daemon
    .command("install")
    .description("Register the daemon to start at login (launchd / Task Scheduler)")
    .action(async () => {
      process.stdout.write(`${await serviceManager().install()}\n`);
    });

  daemon
    .command("uninstall")
    .description("Stop the daemon and deregister it from login startup")
    .action(async () => {
      process.stdout.write(`${await serviceManager().uninstall()}\n`);
    });

  daemon
    .command("status")
    .description("Show service + live daemon status")
    .action(async () => {
      const svc = serviceManager();
      const agent = await svc.status();
      const live = await daemonStatus();
      const payload = {
        // Key kept as `launchAgent` — it is in the wm-stack-facing JSON and
        // renaming it would break consumers for a cosmetic gain. The VALUE now
        // names whichever mechanism is actually in use.
        launchAgent: `${svc.kind}: ${agent.detail}`,
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
    .description("Stop the daemon (deregisters it — a plain kill gets resurrected)")
    .action(async () => {
      process.stdout.write(`${await serviceManager().uninstall()}\n`);
    });

  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      await serviceManager().restart(true);
      process.stdout.write("restarted.\n");
    });
}
