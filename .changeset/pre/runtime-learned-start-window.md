---
"@erainfra/runtime": patch
---

The start budget learns how many Attempts may start at once instead of allowing a fixed 2 per 60 seconds. The window opens at `MAX_STARTING` (now 8), halves when the host's I/O stall reaches `IO_PRESSURE_LIMIT` (at most once per start window), and grows by one for each start window that ends with no congestion. The stall is now measured from the kernel's cumulative counter between readings a second or more apart, so a burst's end shows within a second or two instead of the ten seconds avg10 trails by. On ubuntu0 the fixed window held 329 of 338 Attempts while io "some" averaged 3.7%, for a median wait of 61 seconds before each job. The state the Agent forwards keeps its shape: `maxStarting` reports the current window and `ioSomeAvg10` the measured stall.
