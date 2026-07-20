import { describe, expect, it } from "vitest";
import {
  type ConnectorStatus,
  derivePhase,
  describeStatus,
  relativeTime,
  type SocketState,
} from "./status.js";

const socket = (over: Partial<SocketState> = {}): SocketState => ({
  connected: false,
  connectedAt: null,
  lastSnapshot: null,
  lastError: null,
  reconnectAttempts: 0,
  ...over,
});

const status = (over: Partial<ConnectorStatus> = {}): ConnectorStatus => ({
  phase: "connecting",
  browser: "chrome",
  port: 8790,
  extVersion: "0.2.0",
  hasToken: true,
  connectedAt: null,
  lastSnapshot: null,
  lastError: null,
  reconnectAttempts: 0,
  ...over,
});

describe("derivePhase", () => {
  it("is unconfigured without a token", () => {
    expect(derivePhase(socket({ connected: true }), false)).toBe("unconfigured");
  });
  it("is connected when the socket is up", () => {
    expect(derivePhase(socket({ connected: true }), true)).toBe("connected");
  });
  it("is error when disconnected with a recorded error", () => {
    expect(derivePhase(socket({ lastError: "daemon unreachable" }), true)).toBe("error");
  });
  it("is connecting when disconnected with no error yet", () => {
    expect(derivePhase(socket(), true)).toBe("connecting");
  });
});

describe("describeStatus", () => {
  it("muted + guidance when unconfigured", () => {
    const d = describeStatus(status({ phase: "unconfigured", hasToken: false }));
    expect(d.tone).toBe("muted");
    expect(d.word).toBe("not configured");
  });
  it("ok + host:port when connected", () => {
    const d = describeStatus(status({ phase: "connected", port: 8790 }));
    expect(d.tone).toBe("ok");
    expect(d.word).toBe("connected");
    expect(d.detail).toContain("127.0.0.1:8790");
  });
  it("warn + retry count when connecting", () => {
    const d = describeStatus(status({ phase: "connecting", reconnectAttempts: 3 }));
    expect(d.tone).toBe("warn");
    expect(d.detail).toContain("retry 3");
  });
  it("bad + surfaced error when erroring", () => {
    const d = describeStatus(status({ phase: "error", lastError: "rejected: bad token" }));
    expect(d.tone).toBe("bad");
    expect(d.detail).toBe("rejected: bad token");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("renders — for null", () => expect(relativeTime(null, now)).toBe("—"));
  it("just now under 3s", () => expect(relativeTime(now - 1000, now)).toBe("just now"));
  it("seconds", () => expect(relativeTime(now - 42_000, now)).toBe("42s ago"));
  it("minutes", () => expect(relativeTime(now - 6 * 60_000, now)).toBe("6m ago"));
  it("hours", () => expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago"));
});
