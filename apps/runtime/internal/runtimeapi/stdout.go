package runtimeapi

import (
	"encoding/json"
	"io"
)

// WriteDocument prints one document a `runner-center-runtime` command hands
// the Action Runner Agent on stdout: `preflight`, `prepare`, `admission` and
// `prune-images`. Each is one line of JSON. Their golden tests write through
// this function, so a golden holds exactly the bytes the Agent parses.
func WriteDocument(out io.Writer, document any) error {
	return json.NewEncoder(out).Encode(document)
}
