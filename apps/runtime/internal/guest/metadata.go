package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxMetadataBytes = 1 << 20

type Metadata struct {
	Kind           string   `json:"kind"`
	RunnerName     string   `json:"runner_name"`
	JITConfig      string   `json:"runner_jit_config"`
	Command        []string `json:"experiment_command"`
	ResultToken    string   `json:"result_token"`
	CacheURL       string   `json:"cache_url"`
	CacheServiceV2 string   `json:"cache_service_v2"`
	// CacheRunnerToken is the runner-auth bearer the in-guest cache interceptor
	// presents to the cache service. Empty means no cache; the guest runs exactly
	// as it did before the cache existed.
	CacheRunnerToken string `json:"cache_runner_token,omitempty"`
	ShutdownOnExit   bool   `json:"shutdown_on_exit"`
}

func (m Metadata) Validate() error {
	if m.RunnerName == "" {
		return errors.New("runner_name is required")
	}
	switch m.Kind {
	case "", "ci":
		if m.JITConfig == "" {
			return errors.New("runner_jit_config is required for CI")
		}
	case "experiment":
		if len(m.Command) == 0 || len(m.Command) > 32 || m.ResultToken == "" {
			return errors.New("experiment command and result token are required")
		}
	default:
		return errors.New("unknown runner kind")
	}
	// The host already validated these against provision-docker.sh's rules;
	// re-checking at the reading edge means a compromised or confused MMDS
	// value still cannot smuggle whitespace into the runner's environment.
	if m.CacheURL != "" {
		if !strings.HasPrefix(m.CacheURL, "http://") &&
			!strings.HasPrefix(m.CacheURL, "https://") {
			return errors.New("cache_url must be an absolute http(s) URL")
		}
		_, rest, _ := strings.Cut(m.CacheURL, "://")
		if host, _, _ := strings.Cut(rest, "/"); host == "" {
			return errors.New("cache_url must name a host")
		}
	}
	for _, r := range m.CacheURL {
		if r <= ' ' || r == 0x7f {
			return errors.New("cache_url must not contain whitespace or control characters")
		}
	}
	switch m.CacheServiceV2 {
	case "", "true", "false":
	default:
		return errors.New(`cache_service_v2 must be exactly "true" or "false"`)
	}
	return nil
}

type MetadataClient struct {
	baseURL string
	client  *http.Client
}

func NewMetadataClient(baseURL string, client *http.Client) *MetadataClient {
	if client == nil {
		client = &http.Client{
			Timeout:   5 * time.Second,
			Transport: &http.Transport{Proxy: nil},
		}
	}
	return &MetadataClient{baseURL: baseURL, client: client}
}

func (c *MetadataClient) Fetch(ctx context.Context) (Metadata, error) {
	delay := 250 * time.Millisecond
	for {
		metadata, err := c.fetchOnce(ctx)
		if err == nil {
			return metadata, nil
		}
		select {
		case <-ctx.Done():
			return Metadata{}, ctx.Err()
		case <-time.After(delay):
		}
		delay = min(3*time.Second, delay*2)
	}
}

func (c *MetadataClient) fetchOnce(ctx context.Context) (Metadata, error) {
	tokenRequest, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+"/latest/api/token", nil)
	if err != nil {
		return Metadata{}, fmt.Errorf("create MMDS token request: %w", err)
	}
	tokenRequest.Header.Set("X-Metadata-Token-TTL-Seconds", "900")
	tokenResponse, err := c.client.Do(tokenRequest)
	if err != nil {
		return Metadata{}, fmt.Errorf("request MMDS token: %w", err)
	}
	token, err := readResponse(tokenResponse, http.StatusOK)
	if err != nil {
		return Metadata{}, fmt.Errorf("read MMDS token: %w", err)
	}

	metadataRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		c.baseURL+"/latest/meta-data/runner-center",
		nil,
	)
	if err != nil {
		return Metadata{}, fmt.Errorf("create MMDS metadata request: %w", err)
	}
	metadataRequest.Header.Set("Accept", "application/json")
	metadataRequest.Header.Set("X-Metadata-Token", string(token))
	metadataResponse, err := c.client.Do(metadataRequest)
	if err != nil {
		return Metadata{}, fmt.Errorf("request MMDS metadata: %w", err)
	}
	payload, err := readResponse(metadataResponse, http.StatusOK)
	if err != nil {
		return Metadata{}, fmt.Errorf("read MMDS metadata: %w", err)
	}

	var metadata Metadata
	if err := json.Unmarshal(payload, &metadata); err != nil {
		return Metadata{}, fmt.Errorf("decode MMDS metadata: %w", err)
	}
	if err := metadata.Validate(); err != nil {
		return Metadata{}, fmt.Errorf("validate MMDS metadata: %w", err)
	}
	return metadata, nil
}

func readResponse(response *http.Response, expectedStatus int) ([]byte, error) {
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		return nil, fmt.Errorf("unexpected HTTP status %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxMetadataBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxMetadataBytes {
		return nil, errors.New("MMDS response exceeded 1 MiB")
	}
	return payload, nil
}
