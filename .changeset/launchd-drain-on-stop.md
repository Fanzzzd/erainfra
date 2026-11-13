---
"@erainfra/backend": patch
---

A macOS Worker's update or restart no longer kills its running jobs. The launchd plist now sets `ExitTimeOut` to 21600 s, so `launchctl bootout` and `kickstart -k` wait for the Action Runner Agent to drain instead of sending SIGKILL after launchd's default 5 s. The first update onto this version still stops under the old plist's timeout. `rc update` prints how to cancel the wait with `launchctl kill SIGKILL`.
