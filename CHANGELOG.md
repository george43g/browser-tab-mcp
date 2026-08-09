# Changelog

## [1.0.1](https://github.com/george43g/browser-tab-mcp/compare/v1.0.0...v1.0.1) (2026-08-09)


### Bug Fixes

* **deps:** consume the published kits — robustness 0.6.0, cli-kit 0.3.1, tui-kit 0.3.3 ([#38](https://github.com/george43g/browser-tab-mcp/issues/38)) ([31821ad](https://github.com/george43g/browser-tab-mcp/commit/31821ad38bb711ff35e893065d6a0f0a330dca21))
* **release:** pin a parseable release-PR title so merges actually cut releases ([#33](https://github.com/george43g/browser-tab-mcp/issues/33)) ([46f6ac9](https://github.com/george43g/browser-tab-mcp/commit/46f6ac99b3996475232f09eb6759e69d64e116af))
* **release:** restore the component release branch — remove the two options that broke cutting ([#36](https://github.com/george43g/browser-tab-mcp/issues/36)) ([4d00fa1](https://github.com/george43g/browser-tab-mcp/commit/4d00fa18285e92df627dfff3f5f1cb8accaf0741))

## 1.0.0 (2026-08-09)


### Features

* **build:** stamp every artifact with a build identity ([#24](https://github.com/george43g/browser-tab-mcp/issues/24)) ([ed99f7a](https://github.com/george43g/browser-tab-mcp/commit/ed99f7a1765fd60fcdcd474562dd49085e626de9))
* **cli:** human-readable output for read commands + curated env flags ([#26](https://github.com/george43g/browser-tab-mcp/issues/26)) ([b1cb999](https://github.com/george43g/browser-tab-mcp/commit/b1cb999f81c3786e36291df248f1017e47ab4dd3))
* connector extension observability + Safari support ([#1](https://github.com/george43g/browser-tab-mcp/issues/1)) ([5a989b6](https://github.com/george43g/browser-tab-mcp/commit/5a989b6b2fca8be05df6391b8754369f6f20091c))
* **daemon:** detect + surface stale extensions on hello ([#20](https://github.com/george43g/browser-tab-mcp/issues/20)) ([78ea436](https://github.com/george43g/browser-tab-mcp/commit/78ea43600e1eedaccaa64c85bf500c0e65a87a56))
* favicons in the snapshot (per-favicon data: cap) ([#12](https://github.com/george43g/browser-tab-mcp/issues/12)) ([c07cffc](https://github.com/george43g/browser-tab-mcp/commit/c07cffcbcb1523b6c4082626eb7daa2b10909b23))
* focus & navigation journals — the tool's event-sourced memory ([#6](https://github.com/george43g/browser-tab-mcp/issues/6)) ([9dd869e](https://github.com/george43g/browser-tab-mcp/commit/9dd869e39df58b6b64e8f64f8ec5f1621b4dfd0b))
* **focus:** one focus_tab contract, with WM-actionable window state ([#30](https://github.com/george43g/browser-tab-mcp/issues/30)) ([6330b0c](https://github.com/george43g/browser-tab-mcp/commit/6330b0c417e6903177834b65282e7310c711ba80))
* global browsing history — chrome.history + Safari sqlite (PR6) ([#10](https://github.com/george43g/browser-tab-mcp/issues/10)) ([52d0178](https://github.com/george43g/browser-tab-mcp/commit/52d01786cba9ce19e6adc4bba1cb515f9de3245c))
* page content & state — on-demand extraction, capture-on-blur, annotations ([#8](https://github.com/george43g/browser-tab-mcp/issues/8)) ([f4e6ee3](https://github.com/george43g/browser-tab-mcp/commit/f4e6ee3ff29e260edce0488b764a5593fb40e1cd))
* screenshots — tier-1 tab (captureVisibleTab) + tier-2 window (screencapture) ([#9](https://github.com/george43g/browser-tab-mcp/issues/9)) ([edfe1c1](https://github.com/george43g/browser-tab-mcp/commit/edfe1c1c36bb762e80220d5e974cb6efe4604821))
* self-contained global bin (bundle workspace deps for pnpm add -g .) ([#14](https://github.com/george43g/browser-tab-mcp/issues/14)) ([35efdf8](https://github.com/george43g/browser-tab-mcp/commit/35efdf84d4309e6ffb7128454a3e81775e51b681))
* TUI status badges — full tab-enrichment coverage ([#11](https://github.com/george43g/browser-tab-mcp/issues/11)) ([96b8110](https://github.com/george43g/browser-tab-mcp/commit/96b8110af015f94511de6174b21d82c375302f77))
* v2 contract — capabilities, tab groups, audio/sleep/focus enrichments ([#5](https://github.com/george43g/browser-tab-mcp/issues/5)) ([ad20240](https://github.com/george43g/browser-tab-mcp/commit/ad202408261213a4d75808e0f6ba1417b9ebc9b0))
* write-side control — tab actions, tab groups, window ops ([#7](https://github.com/george43g/browser-tab-mcp/issues/7)) ([0346e28](https://github.com/george43g/browser-tab-mcp/commit/0346e28223f85e8842f664ac049d1d11a480880c))


### Bug Fixes

* add usage=3.3.0 to root mise.toml; commit generated cli artifacts ([32a272d](https://github.com/george43g/browser-tab-mcp/commit/32a272d757a07935053815304dbb672eedbb5d98))
* **build:** put git identity in turbo's cache key + collect tests/**/*.tsx ([#29](https://github.com/george43g/browser-tab-mcp/issues/29)) ([ee15cc1](https://github.com/george43g/browser-tab-mcp/commit/ee15cc171fc757bca82278e6bdda11f3231cb513))
* **ci:** remove scaffolder E2E + example-sync steps (meta-repo only) ([d86d75b](https://github.com/george43g/browser-tab-mcp/commit/d86d75bca521f6c0c74ef711bec0a19256212915))
* **correlate:** break cgWindowId bounds ties with window-manager titles ([#18](https://github.com/george43g/browser-tab-mcp/issues/18)) ([308c5d9](https://github.com/george43g/browser-tab-mcp/commit/308c5d936aa98b2af553459b0f9531dde3eb9e41))
* **daemon:** reject cross-browser handles; apply bounds+state together ([#22](https://github.com/george43g/browser-tab-mcp/issues/22)) ([5af7f15](https://github.com/george43g/browser-tab-mcp/commit/5af7f1540e68f86767cf029c0aeee267eb0ecf70))
* **ext:** apply window geometry BEFORE state so the state can't be cancelled ([#25](https://github.com/george43g/browser-tab-mcp/issues/25)) ([ac04930](https://github.com/george43g/browser-tab-mcp/commit/ac049308ed341400370a15e77692d19f5db2e40c))
* **ext:** restore a window before sending it geometry [skip-readme] ([#27](https://github.com/george43g/browser-tab-mcp/issues/27)) ([0313e0a](https://github.com/george43g/browser-tab-mcp/commit/0313e0a7148af298aa5a2e55f7a11453449f2d53))
* **tui:** derive the viewport from the terminal; supervise the subscription ([#23](https://github.com/george43g/browser-tab-mcp/issues/23)) ([d340acf](https://github.com/george43g/browser-tab-mcp/commit/d340acf4ade83c362407ea62a43ede4fce96c281))
