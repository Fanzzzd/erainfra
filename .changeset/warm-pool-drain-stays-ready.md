---
"@erainfra/agent": patch
---

A Firecracker Profile whose `warmPool` was lowered below the number of running warm jobs now stays ready while the pool drains. The Action Runner Agent and the control plane used to mark it failed until enough jobs finished. A pool short of its target still fails readiness, and so does a pool the runtime reports unhealthy, such as one whose replacement guest failed to boot.
