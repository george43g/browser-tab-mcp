# Changelog

## [1.10.1](https://github.com/george43g/browser-tab-mcp/compare/v1.10.0...v1.10.1) (2026-09-02)


### Bug Fixes

* **docs:** act on the harness-drift audit — retire false claims, symlink skills, docs-integrity check [skip-readme] ([#168](https://github.com/george43g/browser-tab-mcp/issues/168)) ([670715f](https://github.com/george43g/browser-tab-mcp/commit/670715f42f8df50eceeeb4f4e1da18bf7bcc4f5a))

## [1.10.0](https://github.com/george43g/browser-tab-mcp/compare/v1.9.0...v1.10.0) (2026-09-02)


### Features

* **deploy:** deploy:local — build, restart, reload, VERIFY, auto on main (PR-H) ([#161](https://github.com/george43g/browser-tab-mcp/issues/161)) ([d7ebce2](https://github.com/george43g/browser-tab-mcp/commit/d7ebce28177ac3cefadcd70984f8de52950d2832))
* **endstate:** declarative §11 end-state planning on plan_tab_change (PR-J) ([#165](https://github.com/george43g/browser-tab-mcp/issues/165)) ([f8f84fe](https://github.com/george43g/browser-tab-mcp/commit/f8f84febbfd72e663353ed61fcb63975a50b1aea))
* **eval:** Claude-only model-facing eval corpus + runner (PR-K); PR-L deferred on measured evidence ([#166](https://github.com/george43g/browser-tab-mcp/issues/166)) ([c940db2](https://github.com/george43g/browser-tab-mcp/commit/c940db2138d47c95e9d2b05a9c2d96bec7cf41bb))
* **operations:** operation journal + §15 undo records + apply conflict modes (PR-I) ([#163](https://github.com/george43g/browser-tab-mcp/issues/163)) ([8ad6530](https://github.com/george43g/browser-tab-mcp/commit/8ad653095b33af36f8f77801239102e6cfdf7759))


### Bug Fixes

* **deploy:** accept a dirty-tree build stamp for the right commit; silence DEP0190 [skip-readme] ([#164](https://github.com/george43g/browser-tab-mcp/issues/164)) ([bcc064a](https://github.com/george43g/browser-tab-mcp/commit/bcc064a1ca7e16c825c7d80b21d86e79d21f07f4))
* **deploy:** reload extensions only after they reconnect to the restarted daemon [skip-readme] ([#162](https://github.com/george43g/browser-tab-mcp/issues/162)) ([bfe687f](https://github.com/george43g/browser-tab-mcp/commit/bfe687fe3ac782c4ea2d979f4424b33e40ac75e3))
* **e2e:** poll the minimize precondition instead of racing it [skip-readme] ([#159](https://github.com/george43g/browser-tab-mcp/issues/159)) ([8bf0f6e](https://github.com/george43g/browser-tab-mcp/commit/8bf0f6e32f8604fb73a0f70e727e35e4a35221d6))

## [1.9.0](https://github.com/george43g/browser-tab-mcp/compare/v1.8.0...v1.9.0) (2026-09-02)


### Features

* **copy:** copy_tabs — additive reconstructive transfer, sources untouched by construction ([#152](https://github.com/george43g/browser-tab-mcp/issues/152)) ([c915000](https://github.com/george43g/browser-tab-mcp/commit/c915000990e75900e57bce600a5edcd754a3704a))
* **cut:** cut_tabs — explicitly destructive transfer; the five-tool surface is complete ([#154](https://github.com/george43g/browser-tab-mcp/issues/154)) ([92c1edc](https://github.com/george43g/browser-tab-mcp/commit/92c1edce6479a1effc0016fd15aae86dc1b06ec1))

## [1.8.0](https://github.com/george43g/browser-tab-mcp/compare/v1.7.0...v1.8.0) (2026-09-02)


### Features

* **apply:** apply_tab_layout — the live-layout executor ([#150](https://github.com/george43g/browser-tab-mcp/issues/150)) ([106a16f](https://github.com/george43g/browser-tab-mcp/commit/106a16f5d24585ac596e92799c937f6b1cce3e99))
* **plan:** effect IR + pure transform planner + B24 focusedWindow fallback ([#147](https://github.com/george43g/browser-tab-mcp/issues/147)) ([bf0b76c](https://github.com/george43g/browser-tab-mcp/commit/bf0b76caca5ab8f397e2b74b981100b2c3e6c433))
* **plan:** plan_tab_change — read-only planning tool over the Phase 3 planner ([#149](https://github.com/george43g/browser-tab-mcp/issues/149)) ([5d93250](https://github.com/george43g/browser-tab-mcp/commit/5d93250ae096c1b30a09d366e276f49e2e765821))

## [1.7.0](https://github.com/george43g/browser-tab-mcp/compare/v1.6.0...v1.7.0) (2026-09-01)


### Features

* **select:** browser binding for control-language — domain, temporal seam, live-move domains ([#141](https://github.com/george43g/browser-tab-mcp/issues/141)) ([a21a9d4](https://github.com/george43g/browser-tab-mcp/commit/a21a9d4948192849695b82d347786f59d465242c))
* **select:** select_tabs — materialized selections + the first tool of the five-tool surface ([#143](https://github.com/george43g/browser-tab-mcp/issues/143)) ([ab522cb](https://github.com/george43g/browser-tab-mcp/commit/ab522cb6ffa845b9e0b46f296784e32a864d27c4))

## [1.6.0](https://github.com/george43g/browser-tab-mcp/compare/v1.5.0...v1.6.0) (2026-09-01)


### Features

* **control-language:** pure selection-language package — Phase 1 of the DSL workstream ([#136](https://github.com/george43g/browser-tab-mcp/issues/136)) ([ec124a4](https://github.com/george43g/browser-tab-mcp/commit/ec124a4f2a1aedf9da3ed89c437aced0b3e5eee4))
* **daemon:** monotonic snapshot revision + opaque token, separate from contract version ([#132](https://github.com/george43g/browser-tab-mcp/issues/132)) ([b859565](https://github.com/george43g/browser-tab-mcp/commit/b859565e5878258ab732b31551a3a3609465cf21))
* **mcp-kit:** titles for every tool + truthful annotation audit, contract-tested ([#131](https://github.com/george43g/browser-tab-mcp/issues/131)) ([d2acd99](https://github.com/george43g/browser-tab-mcp/commit/d2acd9909fc19ba5397e54f31630fcedeb315903))
* **move:** signed absolute + relative + same-window move_tab, wire-compatible ([#135](https://github.com/george43g/browser-tab-mcp/issues/135)) ([d4ba072](https://github.com/george43g/browser-tab-mcp/commit/d4ba0724c906642306508e52b67ae28b5ddbd27e))

## [1.5.0](https://github.com/george43g/browser-tab-mcp/compare/v1.4.1...v1.5.0) (2026-09-01)


### Features

* **groups:** dissolve a tab group by groupId, keeping every tab ([#125](https://github.com/george43g/browser-tab-mcp/issues/125)) ([932dc63](https://github.com/george43g/browser-tab-mcp/commit/932dc63fbee54e39a361660c27baec3d03f578fb))
* **macos:** effect-verify the AppleScript tier against a real browser ([#117](https://github.com/george43g/browser-tab-mcp/issues/117)) ([2692bcd](https://github.com/george43g/browser-tab-mcp/commit/2692bcdc743870e00d644a6f617ad0950d50bf8a))


### Bug Fixes

* **daemon,e2e:** close three backlog rows — leaked daemons, dead coverage, unthrottled respawn ([#122](https://github.com/george43g/browser-tab-mcp/issues/122)) ([f22b8db](https://github.com/george43g/browser-tab-mcp/commit/f22b8db91d920c6282adbc0e1b1f4342a8c9d1b5))

## [1.4.1](https://github.com/george43g/browser-tab-mcp/compare/v1.4.0...v1.4.1) (2026-08-23)


### Bug Fixes

* **cli:** brand CLI log files as browser-tab-cli ([#98](https://github.com/george43g/browser-tab-mcp/issues/98)) ([c94e5b9](https://github.com/george43g/browser-tab-mcp/commit/c94e5b951d4e01db6739272d33d0570375a81a26))
* **e2e:** per-spec port bands + daemon identity assertions ([#103](https://github.com/george43g/browser-tab-mcp/issues/103)) ([815ee93](https://github.com/george43g/browser-tab-mcp/commit/815ee936588c25e2160f8e7aaeead5bcf99d67e8))
* **focus:** un-minimize explicitly in the extension pathway too ([#106](https://github.com/george43g/browser-tab-mcp/issues/106)) ([65081e9](https://github.com/george43g/browser-tab-mcp/commit/65081e9efa3d2f92110c7292aee9f6c69b9e741e))

## [1.4.0](https://github.com/george43g/browser-tab-mcp/compare/v1.3.2...v1.4.0) (2026-08-21)


### Features

* **daemon:** cgWindowId correlation observability ([#85](https://github.com/george43g/browser-tab-mcp/issues/85)) ([e681666](https://github.com/george43g/browser-tab-mcp/commit/e68166681eb93af2ea448552a4078927de3550c7))
* Microsoft Edge as a first-class browser ([#84](https://github.com/george43g/browser-tab-mcp/issues/84)) ([500384d](https://github.com/george43g/browser-tab-mcp/commit/500384da02893c72a433c2c2179d4ce3dc218cbb))
* **tui:** port to tui-kit 0.5 primitives — scrollbar, detail pane, nav reducer + polish ([#87](https://github.com/george43g/browser-tab-mcp/issues/87)) ([9eed30b](https://github.com/george43g/browser-tab-mcp/commit/9eed30bac8ecd748aa33e8d2c2d50251750f6e82))


### Bug Fixes

* **tests:** disjoint port bands per integration file — kill the swallowed-EADDRINUSE flake ([#90](https://github.com/george43g/browser-tab-mcp/issues/90)) ([6ece79e](https://github.com/george43g/browser-tab-mcp/commit/6ece79e9be81b81a2ba942b252a337bc5db7d766))

## [1.3.2](https://github.com/george43g/browser-tab-mcp/compare/v1.3.1...v1.3.2) (2026-08-20)


### Bug Fixes

* **build:** guard rust-accel's build behind a rustc probe — rustless machines must skip, not fail ([#76](https://github.com/george43g/browser-tab-mcp/issues/76)) ([76e0e3e](https://github.com/george43g/browser-tab-mcp/commit/76e0e3e614d47cdfe19186c0d02c22d582b4fe41))
* **daemon:** a live extension feed means running=true — the poll cannot outvote the socket [skip-readme] ([#81](https://github.com/george43g/browser-tab-mcp/issues/81)) ([2c12466](https://github.com/george43g/browser-tab-mcp/commit/2c1246682a065c1ef776567fc9aae56aaedfc847))
* **stress:** kill the Windows phantom pass — entry guard backslashes + harness that could exit 0 without a verdict [skip-readme] ([#78](https://github.com/george43g/browser-tab-mcp/issues/78)) ([bf497c9](https://github.com/george43g/browser-tab-mcp/commit/bf497c94df250e19b72f9e6add8dcfd00559a8a1))
* **stress:** spawn the TUI soak workload via node --import tsx, not the bin shim ([#75](https://github.com/george43g/browser-tab-mcp/issues/75)) ([300e1d5](https://github.com/george43g/browser-tab-mcp/commit/300e1d5482142951410a917d29cadb2c2ffd2677))
* **tui:** make move mode reachable — the m-key guard read a memo that was empty outside move mode [skip-readme] ([#77](https://github.com/george43g/browser-tab-mcp/issues/77)) ([1a06608](https://github.com/george43g/browser-tab-mcp/commit/1a06608facad0a60f8e54d9926bf1ffa0180741a))

## [1.3.1](https://github.com/george43g/browser-tab-mcp/compare/v1.3.0...v1.3.1) (2026-08-20)


### Bug Fixes

* **tabs:** the dogfood five — own-window grouping, partial-success lists, honest move index, credential-free URLs, summary projection ([#71](https://github.com/george43g/browser-tab-mcp/issues/71)) ([ce6cde5](https://github.com/george43g/browser-tab-mcp/commit/ce6cde5a59b87c4e1c711cb8b17d529bfc6a7988))

## [1.3.0](https://github.com/george43g/browser-tab-mcp/compare/v1.2.1...v1.3.0) (2026-08-18)


### Features

* **bookmarks:** CRUD across MCP, CLI and the extension ([#66](https://github.com/george43g/browser-tab-mcp/issues/66)) ([dbdb8c3](https://github.com/george43g/browser-tab-mcp/commit/dbdb8c3c6071cdafa41c93e96dff13ff6bb48750))
* **cli,tui:** one feature, every surface — logs command, TUI action picker, parity guard ([#65](https://github.com/george43g/browser-tab-mcp/issues/65)) ([c3fd5b7](https://github.com/george43g/browser-tab-mcp/commit/c3fd5b7cb26348e1fa01ed15668b3db450027b3d))
* **daemon:** a Windows build target — extension-only mode, named pipe, Task Scheduler ([#64](https://github.com/george43g/browser-tab-mcp/issues/64)) ([f0e9999](https://github.com/george43g/browser-tab-mcp/commit/f0e9999d394e2c04dff61dd16023b1d4527a604d))
* **daemon:** an opt-in HTTP interface — reads, SSE events, and tool dispatch ([#67](https://github.com/george43g/browser-tab-mcp/issues/67)) ([39c7ee0](https://github.com/george43g/browser-tab-mcp/commit/39c7ee08746b78e046c98f99a5ca985f505359f9))


### Bug Fixes

* **cli:** the five backlog bugs — honest doctor, dated clocks, chromium, empty options, group colour ([#63](https://github.com/george43g/browser-tab-mcp/issues/63)) ([3a1ec07](https://github.com/george43g/browser-tab-mcp/commit/3a1ec072b412a649b3cfb595cae2be9a61c037d9))
* **release:** judge an untagged release by the tag, not by the label ([#61](https://github.com/george43g/browser-tab-mcp/issues/61)) ([cf66499](https://github.com/george43g/browser-tab-mcp/commit/cf66499358a0d29ee86f8f80c7feb0053d72eb79))

## [1.2.1](https://github.com/george43g/browser-tab-mcp/compare/v1.2.0...v1.2.1) (2026-08-18)


### Bug Fixes

* **release:** finish the version-lockstep — an unrefreshed release PR, and a red main after the cut ([#58](https://github.com/george43g/browser-tab-mcp/issues/58)) ([dafddf7](https://github.com/george43g/browser-tab-mcp/commit/dafddf7c13c024d0355c08958bfec48906817265))

## [1.2.0](https://github.com/george43g/browser-tab-mcp/compare/v1.1.1...v1.2.0) (2026-08-18)


### Features

* **ext:** self-reload from the CLI, and say which build is running ([#54](https://github.com/george43g/browser-tab-mcp/issues/54)) ([7a15cf8](https://github.com/george43g/browser-tab-mcp/commit/7a15cf8d176b27c57fb98a44a4bb8d81bad1aeb9))


### Bug Fixes

* **release:** version every artifact from one release line, and verify the cut landed ([#55](https://github.com/george43g/browser-tab-mcp/issues/55)) ([d967540](https://github.com/george43g/browser-tab-mcp/commit/d967540bc36356bc4998033553d6c02fc485dd1a))

## [1.1.1](https://github.com/george43g/browser-tab-mcp/compare/v1.1.0...v1.1.1) (2026-08-17)


### Bug Fixes

* **cli:** make the documented flags real, and refuse values we can't honour ([#49](https://github.com/george43g/browser-tab-mcp/issues/49)) ([3073159](https://github.com/george43g/browser-tab-mcp/commit/307315916cb8c0447140458814173fc0f161fef4))
* **cli:** print the field each renderer exists for, and mean it about width ([#52](https://github.com/george43g/browser-tab-mcp/issues/52)) ([3a51e75](https://github.com/george43g/browser-tab-mcp/commit/3a51e7581532907a771c202f24c2ec4f33d8515c))
* **cli:** signal tool failure to scripts, not just to humans ([#42](https://github.com/george43g/browser-tab-mcp/issues/42)) ([59131cf](https://github.com/george43g/browser-tab-mcp/commit/59131cf0211c816f9c3bc8e7d75e3bdaa824e530))
* **cli:** stop the bundler swapping picocolors for its browser stub ([#47](https://github.com/george43g/browser-tab-mcp/issues/47)) ([21549ee](https://github.com/george43g/browser-tab-mcp/commit/21549ee5e85ea3605d3279fd3b7f66b2d9814d64))
* **security:** allowlist navigable URL schemes; enforce devOnly at dispatch ([#50](https://github.com/george43g/browser-tab-mcp/issues/50)) ([4b66087](https://github.com/george43g/browser-tab-mcp/commit/4b660870f562cefcf7b72959316568563338240a))
* **tui:** clamp rows and chrome to the terminal width ([#45](https://github.com/george43g/browser-tab-mcp/issues/45)) ([e95f6d8](https://github.com/george43g/browser-tab-mcp/commit/e95f6d8b775189a4ae9c0b7973ae6bacde103c93))

## [1.1.0](https://github.com/george43g/browser-tab-mcp/compare/v1.0.1...v1.1.0) (2026-08-10)


### Features

* **daemon:** heartbeat file so shell consumers can check liveness with one stat ([#41](https://github.com/george43g/browser-tab-mcp/issues/41)) ([1956e75](https://github.com/george43g/browser-tab-mcp/commit/1956e75fda6150ed019d9a70a4ae3ed96a4f44f3))


### Bug Fixes

* **correlate:** resolve cgWindowId when a source reports display-local bounds ([#39](https://github.com/george43g/browser-tab-mcp/issues/39)) ([1291921](https://github.com/george43g/browser-tab-mcp/commit/129192104b6791d81fa3479de179a25c1f7b7a24))

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
