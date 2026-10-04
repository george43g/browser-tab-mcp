# Changelog

## 0.1.0 (2026-10-04)


### Features

* **bookmarks:** CRUD across MCP, CLI and the extension ([#66](https://github.com/george43g/browser-tab-mcp/issues/66)) ([dbdb8c3](https://github.com/george43g/browser-tab-mcp/commit/dbdb8c3c6071cdafa41c93e96dff13ff6bb48750))
* **browser-tab:** support ChatGPT desktop browser connector ([#208](https://github.com/george43g/browser-tab-mcp/issues/208)) ([60e4271](https://github.com/george43g/browser-tab-mcp/commit/60e4271cbb9c70b4c1de2f598b7ed87edb77bba7))
* connector extension observability + Safari support ([#1](https://github.com/george43g/browser-tab-mcp/issues/1)) ([5a989b6](https://github.com/george43g/browser-tab-mcp/commit/5a989b6b2fca8be05df6391b8754369f6f20091c))
* **daemon:** a Windows build target — extension-only mode, named pipe, Task Scheduler ([#64](https://github.com/george43g/browser-tab-mcp/issues/64)) ([f0e9999](https://github.com/george43g/browser-tab-mcp/commit/f0e9999d394e2c04dff61dd16023b1d4527a604d))
* **daemon:** detect + surface stale extensions on hello ([#20](https://github.com/george43g/browser-tab-mcp/issues/20)) ([78ea436](https://github.com/george43g/browser-tab-mcp/commit/78ea43600e1eedaccaa64c85bf500c0e65a87a56))
* **daemon:** monotonic snapshot revision + opaque token, separate from contract version ([#132](https://github.com/george43g/browser-tab-mcp/issues/132)) ([b859565](https://github.com/george43g/browser-tab-mcp/commit/b859565e5878258ab732b31551a3a3609465cf21))
* **daemon:** reopen a closed tab — and say which kind of "back" it was ([#183](https://github.com/george43g/browser-tab-mcp/issues/183)) ([2336634](https://github.com/george43g/browser-tab-mcp/commit/2336634bcc8c01ef98647aeefbcf9e88f533beba))
* **ext:** self-reload from the CLI, and say which build is running ([#54](https://github.com/george43g/browser-tab-mcp/issues/54)) ([7a15cf8](https://github.com/george43g/browser-tab-mcp/commit/7a15cf8d176b27c57fb98a44a4bb8d81bad1aeb9))
* favicons in the snapshot (per-favicon data: cap) ([#12](https://github.com/george43g/browser-tab-mcp/issues/12)) ([c07cffc](https://github.com/george43g/browser-tab-mcp/commit/c07cffcbcb1523b6c4082626eb7daa2b10909b23))
* focus & navigation journals — the tool's event-sourced memory ([#6](https://github.com/george43g/browser-tab-mcp/issues/6)) ([9dd869e](https://github.com/george43g/browser-tab-mcp/commit/9dd869e39df58b6b64e8f64f8ec5f1621b4dfd0b))
* **focus:** one focus_tab contract, with WM-actionable window state ([#30](https://github.com/george43g/browser-tab-mcp/issues/30)) ([6330b0c](https://github.com/george43g/browser-tab-mcp/commit/6330b0c417e6903177834b65282e7310c711ba80))
* global browsing history — chrome.history + Safari sqlite (PR6) ([#10](https://github.com/george43g/browser-tab-mcp/issues/10)) ([52d0178](https://github.com/george43g/browser-tab-mcp/commit/52d01786cba9ce19e6adc4bba1cb515f9de3245c))
* Microsoft Edge as a first-class browser ([#84](https://github.com/george43g/browser-tab-mcp/issues/84)) ([500384d](https://github.com/george43g/browser-tab-mcp/commit/500384da02893c72a433c2c2179d4ce3dc218cbb))
* **move:** signed absolute + relative + same-window move_tab, wire-compatible ([#135](https://github.com/george43g/browser-tab-mcp/issues/135)) ([d4ba072](https://github.com/george43g/browser-tab-mcp/commit/d4ba0724c906642306508e52b67ae28b5ddbd27e))
* page content & state — on-demand extraction, capture-on-blur, annotations ([#8](https://github.com/george43g/browser-tab-mcp/issues/8)) ([f4e6ee3](https://github.com/george43g/browser-tab-mcp/commit/f4e6ee3ff29e260edce0488b764a5593fb40e1cd))
* screenshots — tier-1 tab (captureVisibleTab) + tier-2 window (screencapture) ([#9](https://github.com/george43g/browser-tab-mcp/issues/9)) ([edfe1c1](https://github.com/george43g/browser-tab-mcp/commit/edfe1c1c36bb762e80220d5e974cb6efe4604821))
* v2 contract — capabilities, tab groups, audio/sleep/focus enrichments ([#5](https://github.com/george43g/browser-tab-mcp/issues/5)) ([ad20240](https://github.com/george43g/browser-tab-mcp/commit/ad202408261213a4d75808e0f6ba1417b9ebc9b0))
* write-side control — tab actions, tab groups, window ops ([#7](https://github.com/george43g/browser-tab-mcp/issues/7)) ([0346e28](https://github.com/george43g/browser-tab-mcp/commit/0346e28223f85e8842f664ac049d1d11a480880c))


### Bug Fixes

* **tabs:** the dogfood five — own-window grouping, partial-success lists, honest move index, credential-free URLs, summary projection ([#71](https://github.com/george43g/browser-tab-mcp/issues/71)) ([ce6cde5](https://github.com/george43g/browser-tab-mcp/commit/ce6cde5a59b87c4e1c711cb8b17d529bfc6a7988))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @george43g/vitest-config bumped to 0.1.0
