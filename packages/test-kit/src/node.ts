/**
 * @george43g/test-kit/node — helpers that pull the Node-only `ws` package.
 * Kept off the main barrel so factory-only consumers never drag `ws`.
 */

export { installNodeWebSocket } from "./fakes/websocket.js";
