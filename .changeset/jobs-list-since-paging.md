---
"@erainfra/backend": patch
---

`erainfra jobs list --since 720h --all` no longer fails on page 2 with "cursor is not valid for these filters". The CLI turns a `--since` span into a time once, before the first page, and its hint for the next page names that time. The operator API's refusal now says when a `since` span sent with a cursor is the likely cause.
