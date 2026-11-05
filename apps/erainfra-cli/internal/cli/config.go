package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config is what `auth login` stores. One deployment per file: a fleet has one
// control plane, and ERAINFRA_URL / ERAINFRA_TOKEN cover the rare second one.
type Config struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// credentials is the Config a command runs with and where it came from, so
// `auth status` can say whether the environment overrode the file.
type credentials struct {
	Config
	Source string
}

// configPath follows the XDG base directory spec on every Unix, macOS
// included, the way gh does: $XDG_CONFIG_HOME/erainfra/config.json, else
// ~/.config/erainfra/config.json. Windows has no XDG convention, so it uses
// %AppData%.
func configPath(getenv func(string) string) (string, error) {
	if dir := getenv("XDG_CONFIG_HOME"); dir != "" && filepath.IsAbs(dir) {
		return filepath.Join(dir, "erainfra", "config.json"), nil
	}
	if runtime.GOOS == "windows" {
		if dir := getenv("AppData"); dir != "" {
			return filepath.Join(dir, "erainfra", "config.json"), nil
		}
	}
	home := getenv("HOME")
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return "", fmt.Errorf("find the home directory for the config file: %w", err)
		}
	}
	return filepath.Join(home, ".config", "erainfra", "config.json"), nil
}

func readConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return cfg, nil
}

// writeConfig stores the token readable by its owner only. The file is written
// to a temporary name and renamed, so a crash cannot leave a half-written
// credential, and the mode is set on the temporary file before any byte of the
// token reaches it.
func writeConfig(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// loadCredentials prefers the environment, then the config file. Both
// variables must be set for the environment to win, so a stray ERAINFRA_URL
// cannot send the stored token to another host.
func loadCredentials(getenv func(string) string) (credentials, error) {
	envURL, envToken := getenv("ERAINFRA_URL"), getenv("ERAINFRA_TOKEN")
	if envURL != "" || envToken != "" {
		if envURL == "" || envToken == "" {
			return credentials{}, errIncompleteEnvironment
		}
		base, err := normalizeBaseURL(envURL)
		if err != nil {
			return credentials{}, fmt.Errorf("ERAINFRA_URL: %w", err)
		}
		return credentials{Config{URL: base, Token: envToken}, "environment (ERAINFRA_URL, ERAINFRA_TOKEN)"}, nil
	}
	path, err := configPath(getenv)
	if err != nil {
		return credentials{}, err
	}
	cfg, err := readConfig(path)
	if errors.Is(err, os.ErrNotExist) {
		return credentials{}, errNotLoggedIn
	}
	if err != nil {
		return credentials{}, err
	}
	if cfg.URL == "" || cfg.Token == "" {
		return credentials{}, errNotLoggedIn
	}
	return credentials{cfg, path}, nil
}

var errIncompleteEnvironment = errors.New("set both ERAINFRA_URL and ERAINFRA_TOKEN, or neither")

var errNotLoggedIn = errors.New("not logged in; run `erainfra auth login --url <deployment> --token <token>`")

// normalizeBaseURL accepts the deployment's site URL. A token is a bearer
// credential, so plaintext http is refused except on loopback, where
// `convex dev --local` serves.
func normalizeBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%q is not an absolute URL", raw)
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return "", fmt.Errorf("%q uses plaintext http; use https (http is accepted only on loopback)", raw)
		}
	default:
		return "", fmt.Errorf("%q must be an https URL", raw)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", fmt.Errorf("%q must not carry credentials, a query or a fragment", raw)
	}
	return strings.TrimRight(parsed.Scheme+"://"+parsed.Host+parsed.Path, "/"), nil
}
