---
"@erainfra/cache-service": patch
---

The cache service saves entries whose key is longer than 115 bytes. It named an entry after its key's hex, so a longer key made one name segment longer than the 255 bytes MinIO allows, and MinIO refused the save with `XMinioInvalidObjectName` (three saves on ubuntu0 from 2026-11-15 to 16). A key's hex is now cut into 230-character segments, and a key over 200 bytes ends its name in a SHA-256 of the whole key, so the longest key GitHub accepts fits MinIO's 1024-byte name. Prefix restores still match through the store's listing; past 200 bytes the saved key decides. A ref that escapes to more than 255 bytes is named by its SHA-256. Keys up to 115 bytes and refs up to 255 bytes keep their names, so existing entries stay readable. The test store now refuses names MinIO refuses.
