---
"@erainfra/runtime": patch
"@erainfra/agent": patch
---

Guests and Docker job containers ask the resolver with `options edns0 timeout:1 attempts:3`. glibc waits 5 s for a lost DNS answer by default, and the resolvers sit across the Worker's uplink. On ubuntu0, 2 of 360 sampled lookups to github.com took 5 s; with this change a lost answer costs 1 s. `testdata/resolver-options.json` holds the option list, and the Go and TypeScript tests both read it.
