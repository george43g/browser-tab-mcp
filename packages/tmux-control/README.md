# tmux-control application library

Phase 3 / M2 is a read-only slice. `adapter/read.ts` is the sole tmux process boundary. It passes argv arrays to `tmux`, asks for `-F` rows, and parses them into a snapshot. The model distinguishes a session's window **slot** (`$session:@window`) from the underlying window (`@window`), because one window can be linked into several sessions. Panes belong to the underlying window and appear once in the snapshot.

`makeTmuxDomain(snapshot)` binds this model to `@george43g/control-language` without changing that package. The 13 selector kinds that do not ask for a sibling view pass M1's conformance suite on captured real `-F` output. Sibling-dependent selection deliberately throws until the linked-window identity experiment in M3. This green M2 result does not decide that experiment.

The adapter compares server identity, session rows, client rows and structural window/pane rows across two reads. It rejects a concurrent structural change and validates every session, slot, window, pane and client reference before returning. This is a best-effort read boundary; M5 will add the snapshot token used to refuse a stale *apply*.

The `project` predicate field is the nearest Git checkout's repository name. For a linked worktree, the adapter follows the `.git` pointer to the common repository directory, so a pane in `tmux-m2` still reports `browser-tab-mcp`. If no Git checkout exists, the field is absent.

Existing tmux libraries and MCP servers were evaluated in the approved plan's §13. `libtmux` is the closest TypeScript library; this slice uses direct `-F` reads because its purpose is to prove this repo's existing selection core over a small, inspectable tmux model, without adopting another tool's object identity or 45-tool surface.
