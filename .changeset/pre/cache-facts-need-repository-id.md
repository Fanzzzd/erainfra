---
"@erainfra/controller": patch
---

The job cache no longer matches by repository name alone. The cache service refuses job facts without a GitHub repository ID unless they grant nothing, as the controller's cold facts do, and answers such a push `400 facts carry no repository ID`. An index entry without an ID belongs to no repository: no job restores it, the first save under the name removes it, and the next sweep evicts it with reason `no repository ID`. The controller publishes cold facts for a workflow run that names no repository ID. Every controller since v0.2.0-rc.11 pushes the ID.
