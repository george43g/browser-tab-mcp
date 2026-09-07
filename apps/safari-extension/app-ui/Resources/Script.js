//
//  OVERLAY SOURCE — tracked at apps/safari-extension/app-ui/Resources/Script.js
//  and copied into the generated Xcode project by scripts/overlay-app-ui.sh.
//  Editing the copy under xcode/ is pointless: the next convert or sideload
//  overwrites it.
//
//  `render(report)` is called from ViewController.swift with the resolved
//  status. Every string the window can show is here; the Swift side decides
//  only which state applies.
//

/**
 * One entry per AppState in ViewController.swift.
 *
 * `button` is what the primary control DOES, and it is labelled for what it
 * does. "Quit and Open Safari Settings…" appears for exactly one state —
 * `extensionOff` — because that is the only situation restarting Safari
 * fixes. Everywhere else the honest label is "Check Again": the button
 * re-runs the whole check and re-renders. It does not redeploy anything.
 */
const STATES = {
  checking: {
    dot: "idle",
    headline: () => "Checking…",
    versions: false,
    button: { label: "Check Again", action: "retry", disabled: true },
  },

  extensionOff: {
    dot: "bad",
    headline: () =>
      "Browser Tab Helper’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.",
    versions: false,
    button: { label: "Quit and Open Safari Settings…", action: "open-settings" },
  },

  extensionUnknown: {
    dot: "warn",
    // Reachable in NORMAL use, not just when something is broken: for a few
    // seconds after a sideload, while LaunchServices re-registers the app,
    // Safari answers this query with SFErrorDomain error 1. Someone who meets
    // this has done nothing wrong, so the copy says to wait before it says to
    // go fix something.
    headline: () =>
      "Safari didn’t say whether the extension is on — this is normal for a few seconds after a rebuild.",
    versions: true,
    button: { label: "Check Again", action: "retry" },
    hint: "If it persists, turn the extension on in the Extensions section of Safari Settings.",
  },

  daemonUnreachable: {
    dot: "warn",
    headline: () =>
      "The extension is on, but the browser-tab daemon isn’t reachable — so the extension can’t be asked what version it’s running.",
    versions: true,
    button: { label: "Check Again", action: "retry" },
    hint: "Start it with:  browser-tab daemon install",
  },

  notConnected: {
    dot: "warn",
    headline: () =>
      "The extension is on and the daemon is running, but Safari’s extension hasn’t connected to it.",
    versions: true,
    button: { label: "Check Again", action: "retry" },
    hint: "Open the extension’s settings in Safari and check the token and browser name.",
  },

  stale: {
    dot: "warn",
    headline: () => "Safari is running a different build of the extension than this app ships.",
    versions: true,
    button: { label: "Check Again", action: "retry" },
    hint: "Safari usually picks up a rebuilt bundle within ~15s of this app launching. If it doesn’t, rebuild with:  pnpm --filter @george43g/safari-extension sideload",
  },

  healthy: {
    dot: "good",
    headline: () => "Browser Tab Helper’s extension is on and connected.",
    versions: true,
    button: { label: "Check Again", action: "retry" },
  },
};

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setRow(rowId, valueId, value) {
  const row = document.getElementById(rowId);
  if (!row) return;
  if (value) {
    row.hidden = false;
    setText(valueId, value);
  } else {
    row.hidden = true;
  }
}

/** Called from Swift. `report` is the JSON payload of a StatusReport. */
function render(report) {
  const spec = STATES[report.state] || STATES.checking;

  document.body.className = `state-${report.state}`;

  const dot = document.getElementById("dot");
  if (dot) dot.className = spec.dot;

  setText("headline-text", spec.headline(report));

  const versions = document.getElementById("versions");
  if (versions) {
    setRow("row-live", "v-live", spec.versions ? report.live : null);
    setRow("row-bundled", "v-bundled", spec.versions ? report.bundled : null);
    setRow("row-daemon", "v-daemon", spec.versions ? report.daemon : null);
    versions.hidden = !spec.versions || !(report.live || report.bundled || report.daemon);
  }

  const detail = document.getElementById("detail");
  if (detail) {
    detail.hidden = !report.detail;
    detail.textContent = report.detail || "";
  }

  const hint = document.getElementById("hint");
  if (hint) {
    hint.hidden = !spec.hint;
    hint.textContent = spec.hint || "";
  }

  const button = document.getElementById("primary");
  if (button) {
    button.textContent = spec.button.label;
    button.dataset.action = spec.button.action;
    button.disabled = Boolean(spec.button.disabled);
    // Drop focus on every render. The window re-checks when the app becomes
    // active, so this guarantees a keystroke aimed at something else cannot
    // land on a button that changed label underneath it — `extensionOff`'s
    // button quits Safari.
    button.blur();
  }

  reportHeight();
}

/**
 * Tell the app how tall the content actually is, so a NON-RESIZABLE window can
 * still fit variable-length error strings. `body` is `min-height: 100%`, which
 * would just echo the current window height back, so it is zeroed for the
 * measurement and restored immediately.
 */
function reportHeight() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const body = document.body;
      const previous = body.style.minHeight;
      body.style.minHeight = "0";
      const height = Math.ceil(body.scrollHeight);
      body.style.minHeight = previous;
      post(`resize:${height}`);
    }),
  );
}

function post(message) {
  // Absent when the page is rendered outside the app (a browser preview).
  globalThis.webkit?.messageHandlers?.controller?.postMessage(message);
}

document.getElementById("primary").addEventListener("click", (event) => {
  post(event.currentTarget.dataset.action || "retry");
});
