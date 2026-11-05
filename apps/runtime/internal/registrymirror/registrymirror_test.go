package registrymirror

import "testing"

func TestValidateAcceptsWhatDockerdAndBuildKitBothRead(t *testing.T) {
	for _, value := range []string{
		"http://10.20.0.5:5000",
		"http://10.20.0.5:5000/",
		"https://mirror.lan",
		"https://mirror.lan:8443/",
	} {
		if err := Validate(value); err != nil {
			t.Errorf("Validate(%q) = %v, want nil", value, err)
		}
	}
}

func TestValidateRejectsWhatWouldBreakDockerdOrMeanTwoMirrors(t *testing.T) {
	for _, value := range []string{
		"",
		"mirror.lan:5000",          // no scheme: dockerd refuses to start on it
		"ftp://mirror.lan",         // unsupported scheme
		"https://",                 // no host
		"https://:5000",            // a port is not a host
		"https://u:p@mirror.lan",   // credentials would be served to every job
		"https://mirror.lan?x=1",   // query
		"https://mirror.lan?",      // empty query is still a query to url.Parse
		"https://mirror.lan#frag",  // fragment
		"https://mirror.lan/proxy", // a path BuildKit's mirrors list cannot express
		"https://mirror.lan /",     // whitespace
		"https://mirror.lan\n",     // control character
		"https://mirror.lan\x7f",   // DEL
		"HTTPS://mirror.lan",       // dockerd's scheme check is case-sensitive too
		"https://[::1",             // does not parse
	} {
		if err := Validate(value); err == nil {
			t.Errorf("Validate(%q) accepted a value that must be refused", value)
		}
	}
}

func TestHostPlainAndCanonical(t *testing.T) {
	if got := Host("http://10.20.0.5:5000/"); got != "10.20.0.5:5000" {
		t.Fatalf("Host = %q", got)
	}
	if !Plain("http://10.20.0.5:5000") || Plain("https://mirror.lan") {
		t.Fatal("Plain misreports the scheme")
	}
	if got := Canonical("https://mirror.lan"); got != "https://mirror.lan/" {
		t.Fatalf("Canonical = %q", got)
	}
	if got := Canonical("https://mirror.lan/"); got != "https://mirror.lan/" {
		t.Fatalf("Canonical doubled the slash: %q", got)
	}
}
