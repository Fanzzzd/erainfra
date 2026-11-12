package server

// holdUpload registers an upload unless another job's live upload already
// holds the same entry: repository, write scope, key and version. The same job
// reserving again (a client retry, or a step that runs twice) is let through,
// as before; finalize then finds whichever of its sessions got the bytes. It checks and registers
// under one lock, so two jobs that reserve the same key at the same instant
// cannot both pass.
//
// Exists only sees committed entries. Without this, a burst of jobs that all
// miss one key (eight test shards restoring the same pnpm store on their first
// run) all rebuild it and all upload the same bytes, and the newest commit
// wins. The first reservation wins here instead, and the others skip their
// save, as GitHub's own cache does. A holder that dies stops blocking the key
// when its reservation expires and the sweeper drops it.
func (s *Server) holdUpload(repository, ref, key, version, runner string, register func()) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, held := range s.reservations {
		if held.repository == repository && held.ref == ref && held.key == key &&
			held.version == version && held.runner != runner && now.Before(held.expires) {
			return false
		}
	}
	for _, held := range s.sessions {
		if held.repository == repository && held.ref == ref && held.key == key &&
			held.version == version && held.runner != runner && now.Before(held.expires) {
			return false
		}
	}
	register()
	return true
}
