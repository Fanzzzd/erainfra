package agent

import "sync"

// Registry maps an app (container name) to the loopback port it published, recorded by the agent
// itself on every successful deploy. The data plane resolves the proxy target from HERE, never from
// the hub's frame — so a compromised hub can't make the agent fetch an arbitrary host:port (SSRF).
type Registry struct {
	mu    sync.RWMutex
	ports map[string]int
}

func NewRegistry() *Registry { return &Registry{ports: map[string]int{}} }

func (r *Registry) Set(name string, port int) {
	r.mu.Lock()
	r.ports[name] = port
	r.mu.Unlock()
}

func (r *Registry) Port(name string) (int, bool) {
	r.mu.RLock()
	p, ok := r.ports[name]
	r.mu.RUnlock()
	return p, ok
}
