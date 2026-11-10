// Package jobhint tells the cache service which workflow run a guest's runner
// is executing, the moment the job starts.
//
// The cache service scopes a runner's requests from job facts the controller
// pushes. The controller learns the job from GitHub's JobStarted scale-set
// message, which arrives 7 to 38 s after the job is already running, so every
// job's first cache request waited for it. The runner itself knows sooner: its
// Worker process logs the whole job message at start, and that message carries
// the github context with the repository, run id and run attempt.
//
// What the guest sends is a hint. The job runs in the same VM and can write
// anything into the diag folder, so the cache service treats the claim as
// untrusted until the controller has checked it against GitHub. This package
// validates shape only, so a garbage claim never leaves the VM.
package jobhint

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// repositorySegment is the cache service's own rule for an owner or a name
// (cachetoken.ValidateRepository). It is copied, not imported: the guest image
// builds from apps/runtime alone.
var repositorySegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Hint is the claim the guest makes about its job. The JSON names are the
// cache service's wire format.
type Hint struct {
	Repository string `json:"repository"`
	RunID      int64  `json:"runID"`
	RunAttempt int64  `json:"runAttempt"`
}

// Validate checks a Hint built from the job's own, untrusted, data.
func (h Hint) Validate() error {
	owner, name, found := strings.Cut(h.Repository, "/")
	if !found || !repositorySegment.MatchString(owner) || !repositorySegment.MatchString(name) {
		return fmt.Errorf("%q is not owner/name", h.Repository)
	}
	if h.RunID <= 0 {
		return fmt.Errorf("run id %d is not a positive integer", h.RunID)
	}
	if h.RunAttempt <= 0 {
		return fmt.Errorf("run attempt %d is not a positive integer", h.RunAttempt)
	}
	return nil
}

// jobMessageMarker ends the Worker's log line that precedes the job message.
// actions/runner's Worker.cs writes
//
//	Trace.Info($"Job message:{Environment.NewLine} {StringUtil.ConvertToJson(jobMessage)}");
//
// so the line reads "[<time> INFO Worker] Job message:" and the indented JSON
// starts on the next line.
const jobMessageMarker = " Worker] Job message:"

// errNoMarker is Parse's answer for a log that ended before any job message.
var errNoMarker = errors.New("the Worker log has no job message")

// Parse reads a Worker log up to the end of its job message and returns the
// hint in the message's github context. It reads no further than the JSON,
// so a reader that blocks for more data returns as soon as the message is
// complete.
func Parse(r io.Reader) (Hint, error) {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadString('\n')
		if _, rest, found := strings.Cut(line, jobMessageMarker); found {
			return decodeJobMessage(io.MultiReader(strings.NewReader(rest), reader))
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return Hint{}, errNoMarker
			}
			return Hint{}, err
		}
	}
}

// contextValue is one PipelineContextData value as actions/runner serializes
// it (PipelineContextDataJsonConverter): a string or number as plain JSON, or
// an object whose "t" names its type. 0 is a string in "s", 4 a number in
// "n", 2 and 5 dictionaries whose "d" lists {"k","v"} pairs. The writer emits
// plain strings; the object forms are what its reader also accepts, so they
// are taken here too.
type contextValue struct {
	Type   *int               `json:"t"`
	String *string            `json:"s"`
	Number *json.Number       `json:"n"`
	Pairs  []contextValuePair `json:"d"`
}

type contextValuePair struct {
	Key   string          `json:"k"`
	Value json.RawMessage `json:"v"`
}

const (
	contextString                  = 0
	contextDictionary              = 2
	contextNumber                  = 4
	contextCaseSensitiveDictionary = 5
)

func decodeJobMessage(r io.Reader) (Hint, error) {
	// Only contextData is kept; the decoder skips every other field without
	// building it. encoding/json matches field names case-insensitively, which
	// covers the runner's camelCase "contextData" and a PascalCase writer.
	var message struct {
		ContextData map[string]json.RawMessage `json:"contextData"`
	}
	decoder := json.NewDecoder(r)
	decoder.UseNumber()
	if err := decoder.Decode(&message); err != nil {
		return Hint{}, fmt.Errorf("decode the job message: %w", err)
	}
	var github json.RawMessage
	for name, value := range message.ContextData {
		if strings.EqualFold(name, "github") {
			github = value
		}
	}
	if github == nil {
		return Hint{}, errors.New("the job message has no github context")
	}
	var dictionary contextValue
	if err := json.Unmarshal(github, &dictionary); err != nil {
		return Hint{}, fmt.Errorf("decode the github context: %w", err)
	}
	if dictionary.Type == nil || (*dictionary.Type != contextDictionary && *dictionary.Type != contextCaseSensitiveDictionary) {
		return Hint{}, errors.New("the github context is not a dictionary")
	}
	// Top-level keys only: github.event nests its own repository and run_id,
	// and those name whatever the event payload says, not this run.
	values := map[string]string{}
	for _, pair := range dictionary.Pairs {
		switch key := strings.ToLower(pair.Key); key {
		case "repository", "run_id", "run_attempt":
			scalar, err := contextScalar(pair.Value)
			if err != nil {
				return Hint{}, fmt.Errorf("github.%s: %w", key, err)
			}
			values[key] = scalar
		}
	}
	runID, err := positiveInteger(values["run_id"])
	if err != nil {
		return Hint{}, fmt.Errorf("github.run_id: %w", err)
	}
	runAttempt, err := positiveInteger(values["run_attempt"])
	if err != nil {
		return Hint{}, fmt.Errorf("github.run_attempt: %w", err)
	}
	hint := Hint{Repository: values["repository"], RunID: runID, RunAttempt: runAttempt}
	if err := hint.Validate(); err != nil {
		return Hint{}, err
	}
	return hint, nil
}

// contextScalar returns a string or number context value as text.
func contextScalar(raw json.RawMessage) (string, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", errors.New("missing")
	}
	switch raw[0] {
	case '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return "", err
		}
		return text, nil
	case '{':
		var value contextValue
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", err
		}
		// No "t" is a string, as the runner's own reader takes it.
		switch {
		case (value.Type == nil || *value.Type == contextString) && value.String != nil:
			return *value.String, nil
		case value.Type != nil && *value.Type == contextNumber && value.Number != nil:
			return integerText(*value.Number)
		}
		return "", errors.New("not a string or number")
	default:
		var number json.Number
		if err := json.Unmarshal(raw, &number); err != nil {
			return "", errors.New("not a string or number")
		}
		return integerText(number)
	}
}

// integerText renders a JSON number as decimal digits. The runner writes a
// NumberContextData as a double, so 7 can arrive as 7.0; anything with a
// fraction, or beyond where a double is exact, is not an id.
func integerText(number json.Number) (string, error) {
	if value, err := number.Int64(); err == nil {
		return strconv.FormatInt(value, 10), nil
	}
	value, err := number.Float64()
	if err != nil || value != math.Trunc(value) || math.Abs(value) > 1<<53 {
		return "", fmt.Errorf("%s is not an integer", number)
	}
	return strconv.FormatInt(int64(value), 10), nil
}

// positiveInteger parses decimal digits only: no sign, no space, no zero.
func positiveInteger(text string) (int64, error) {
	if text == "" || strings.Trim(text, "0123456789") != "" {
		return 0, fmt.Errorf("%q is not a positive integer", text)
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%q is not a positive integer", text)
	}
	return value, nil
}
