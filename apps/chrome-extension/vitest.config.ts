import extension from "@george43g/vitest-config/vitest.extension";

// Extension tier: environment "node" by default; DOM-touching tests opt in
// per-file with `// @vitest-environment happy-dom`.
export default extension;
