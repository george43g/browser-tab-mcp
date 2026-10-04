# Changelog

## 0.1.0 (2026-10-04)


### Features

* admit a second MCP app — tmux-control scaffolded, single-app assumptions lifted (Phase 1, Gate B) ([#199](https://github.com/george43g/browser-tab-mcp/issues/199)) ([c80a625](https://github.com/george43g/browser-tab-mcp/commit/c80a625fd8470a0e3dfda919b51b32a226d5fdd0))
* **bookmarks:** CRUD across MCP, CLI and the extension ([#66](https://github.com/george43g/browser-tab-mcp/issues/66)) ([dbdb8c3](https://github.com/george43g/browser-tab-mcp/commit/dbdb8c3c6071cdafa41c93e96dff13ff6bb48750))
* **daemon:** a Windows build target — extension-only mode, named pipe, Task Scheduler ([#64](https://github.com/george43g/browser-tab-mcp/issues/64)) ([f0e9999](https://github.com/george43g/browser-tab-mcp/commit/f0e9999d394e2c04dff61dd16023b1d4527a604d))
* **ext:** self-reload from the CLI, and say which build is running ([#54](https://github.com/george43g/browser-tab-mcp/issues/54)) ([7a15cf8](https://github.com/george43g/browser-tab-mcp/commit/7a15cf8d176b27c57fb98a44a4bb8d81bad1aeb9))
* favicons in the snapshot (per-favicon data: cap) ([#12](https://github.com/george43g/browser-tab-mcp/issues/12)) ([c07cffc](https://github.com/george43g/browser-tab-mcp/commit/c07cffcbcb1523b6c4082626eb7daa2b10909b23))
* **focus:** one focus_tab contract, with WM-actionable window state ([#30](https://github.com/george43g/browser-tab-mcp/issues/30)) ([6330b0c](https://github.com/george43g/browser-tab-mcp/commit/6330b0c417e6903177834b65282e7310c711ba80))
* global browsing history — chrome.history + Safari sqlite (PR6) ([#10](https://github.com/george43g/browser-tab-mcp/issues/10)) ([52d0178](https://github.com/george43g/browser-tab-mcp/commit/52d01786cba9ce19e6adc4bba1cb515f9de3245c))
* **groups:** dissolve a tab group by groupId, keeping every tab ([#125](https://github.com/george43g/browser-tab-mcp/issues/125)) ([932dc63](https://github.com/george43g/browser-tab-mcp/commit/932dc63fbee54e39a361660c27baec3d03f578fb))
* page content & state — on-demand extraction, capture-on-blur, annotations ([#8](https://github.com/george43g/browser-tab-mcp/issues/8)) ([f4e6ee3](https://github.com/george43g/browser-tab-mcp/commit/f4e6ee3ff29e260edce0488b764a5593fb40e1cd))
* screenshots — tier-1 tab (captureVisibleTab) + tier-2 window (screencapture) ([#9](https://github.com/george43g/browser-tab-mcp/issues/9)) ([edfe1c1](https://github.com/george43g/browser-tab-mcp/commit/edfe1c1c36bb762e80220d5e974cb6efe4604821))
* v2 contract — capabilities, tab groups, audio/sleep/focus enrichments ([#5](https://github.com/george43g/browser-tab-mcp/issues/5)) ([ad20240](https://github.com/george43g/browser-tab-mcp/commit/ad202408261213a4d75808e0f6ba1417b9ebc9b0))
* write-side control — tab actions, tab groups, window ops ([#7](https://github.com/george43g/browser-tab-mcp/issues/7)) ([0346e28](https://github.com/george43g/browser-tab-mcp/commit/0346e28223f85e8842f664ac049d1d11a480880c))


### Bug Fixes

* **ext:** restore a window before sending it geometry [skip-readme] ([#27](https://github.com/george43g/browser-tab-mcp/issues/27)) ([0313e0a](https://github.com/george43g/browser-tab-mcp/commit/0313e0a7148af298aa5a2e55f7a11453449f2d53))
* **tabs:** the dogfood five — own-window grouping, partial-success lists, honest move index, credential-free URLs, summary projection ([#71](https://github.com/george43g/browser-tab-mcp/issues/71)) ([ce6cde5](https://github.com/george43g/browser-tab-mcp/commit/ce6cde5a59b87c4e1c711cb8b17d529bfc6a7988))
* **tests:** disjoint port bands per integration file — kill the swallowed-EADDRINUSE flake ([#90](https://github.com/george43g/browser-tab-mcp/issues/90)) ([6ece79e](https://github.com/george43g/browser-tab-mcp/commit/6ece79e9be81b81a2ba942b252a337bc5db7d766))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @george43g/shared-types bumped to 0.1.0
