// Side-effect module: reserved for durable-state env defaults that must be set BEFORE the router
// builds its singletons. Runtime stores default their own persist paths (see runtime/*.ts); tests
// import router.ts directly (never this), so they stay in-memory and hermetic.
export {};
