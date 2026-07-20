import extension from "@george43g/vitest-config/vitest.extension";

// Browser-runtime glue (socket/reconnect timers, the `api` Proxy), not a pure
// library — uses the middle "extension" coverage tier, not the strict shared bar.
export default extension;
