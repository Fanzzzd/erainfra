package meshclient

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// DefaultQUICPort is the UDP port iroh sends QUIC address discovery (QAD) to when a relay entry
// names none (iroh_relay::defaults::DEFAULT_RELAY_QUIC_PORT).
const DefaultQUICPort = 7842

// Relay is one entry of a relay policy, in ERAINFRA_MESH_RELAYS and in set_relays. In JSON it is
// either a URL string or an object for a relay that serves QAD on another UDP port, or not at all:
//
//	"https://relay.example.com"
//	{"url":"https://relay.example.com","quic_port":443}
//	{"url":"https://relay.example.com","quic":false}
//
// A cloud security list that blocks udp/7842 leaves iroh unable to measure the relay over QUIC,
// and UDP 443 is often open where 7842 is not. An entry with neither setting is written as a plain
// string, so a sidecar released before the object form still accepts it.
type Relay struct {
	URL string
	// QUICPort is the UDP port of the relay's QAD server. Zero means DefaultQUICPort.
	QUICPort uint16
	// NoQUIC turns QAD with this relay off. The Node still relays through it.
	NoQUIC bool
}

// QUICNote is empty for a relay with the default QAD port, and otherwise the setting as it is
// written in ERAINFRA_MESH_RELAYS, for log lines: " quic_port=443" or " quic=false".
func (r Relay) QUICNote() string {
	switch {
	case r.NoQUIC:
		return " quic=false"
	case r.QUICPort != 0 && r.QUICPort != DefaultQUICPort:
		return fmt.Sprintf(" quic_port=%d", r.QUICPort)
	}
	return ""
}

func (r Relay) MarshalJSON() ([]byte, error) {
	switch {
	case r.NoQUIC && r.QUICPort != 0:
		return nil, fmt.Errorf("relay %s: QUIC address discovery is off, so it has no port", r.URL)
	case r.NoQUIC:
		return json.Marshal(struct {
			URL  string `json:"url"`
			QUIC bool   `json:"quic"`
		}{r.URL, false})
	case r.QUICPort != 0:
		return json.Marshal(struct {
			URL      string `json:"url"`
			QUICPort uint16 `json:"quic_port"`
		}{r.URL, r.QUICPort})
	}
	return json.Marshal(r.URL)
}

// UnmarshalJSON accepts the two forms Relay documents and refuses anything else with a message
// that names the problem. The sidecar applies the same rules (apps/mesh RelayEntry).
func (r *Relay) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*r = Relay{URL: s}
		return nil
	}
	var obj map[string]json.RawMessage
	if len(b) == 0 || b[0] != '{' || json.Unmarshal(b, &obj) != nil {
		return fmt.Errorf(`a relay is a URL string or an object like {"url":"https://relay.example.com","quic_port":443}, not %s`, b)
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if k != "url" && k != "quic" && k != "quic_port" {
			return fmt.Errorf(`relay field %q is unknown; a relay object has "url", "quic_port" and "quic"`, k)
		}
	}
	raw, ok := obj["url"]
	var u string
	if !ok || len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &u) != nil {
		return errors.New(`a relay object needs "url", a string`)
	}
	out := Relay{URL: u}
	if raw, ok := obj["quic"]; ok {
		switch string(raw) {
		case "true":
		case "false":
			out.NoQUIC = true
		default:
			return fmt.Errorf(`relay %s: "quic" must be true or false, not %s`, u, raw)
		}
	}
	if raw, ok := obj["quic_port"]; ok {
		p, err := strconv.ParseUint(string(raw), 10, 16)
		if err != nil || p == 0 {
			return fmt.Errorf(`relay %s: "quic_port" must be a port number from 1 to 65535, not %s`, u, raw)
		}
		if out.NoQUIC {
			return fmt.Errorf(`relay %s: "quic": false turns QUIC address discovery off, so drop "quic_port"`, u)
		}
		out.QUICPort = uint16(p)
	}
	*r = out
	return nil
}

// ParseRelays reads a relay list as ERAINFRA_MESH_RELAYS holds it: a JSON array of Relay entries.
// It checks each URL the way the sidecar does, so a bad entry stops the agent at startup with the
// entry's number instead of failing every mesh snapshot later. Plain http is allowed only when no
// token will be sent (withToken false).
func ParseRelays(raw []byte, withToken bool) ([]Relay, error) {
	const shape = `must be a JSON URL array, each entry a URL string or {"url":"https://relay.example.com","quic_port":443}`
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil || entries == nil {
		return nil, errors.New(shape)
	}
	out := make([]Relay, 0, len(entries))
	for i, e := range entries {
		var r Relay
		if err := json.Unmarshal(e, &r); err != nil {
			return nil, fmt.Errorf("entry %d: %w", i+1, err)
		}
		if err := r.checkScheme(withToken); err != nil {
			return nil, fmt.Errorf("entry %d: %w", i+1, err)
		}
		out = append(out, r)
	}
	return out, nil
}

func (r Relay) checkScheme(withToken bool) error {
	scheme := ""
	if u, err := url.Parse(r.URL); err == nil {
		scheme = u.Scheme
	}
	switch strings.ToLower(scheme) {
	case "https":
		return nil
	case "http":
		if withToken {
			return fmt.Errorf("relay %s is plain http; refusing to send the relay auth token over it", r.URL)
		}
		return nil
	}
	return fmt.Errorf("relay %s has scheme %q; use https", r.URL, scheme)
}
