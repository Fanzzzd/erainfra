// Side-effect module: reserved for durable-state env defaults that must be set BEFORE the router
// builds its singletons. Runtime stores default their own persist paths (see runtime/*.ts); tests
// import router.ts directly (never this), so they stay in-memory and hermetic.
//
// False positive: `export {}` below is not an empty specifier list, it is the module marker. This
// tsconfig sets `module: "ESNext"`, under which TypeScript does not infer module-ness from the
// package's `"type": "module"` — only from a top-level import or export. Remove it and a file whose
// whole job is to hold future `process.env` defaults becomes a script, so the first `const` written
// here would land in the global scope instead of this file's.
// oxlint-disable-next-line unicorn/require-module-specifiers
export {};
