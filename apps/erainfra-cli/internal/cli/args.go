package cli

import (
	"fmt"
	"strings"
)

// The standard library's flag package stops at the first positional argument,
// so `erainfra jobs view <id> --format json` would treat the flag as a second
// argument. Every CLI this one is compared against (gh, Blacksmith,
// actuated-cli) takes flags anywhere, so this small parser does too. It knows
// only `--name value`, `--name=value`, boolean `--name`, `-h`, and `--`.

type flagSpec struct {
	name    string
	metavar string // empty for a boolean flag
	usage   string
}

type parsedArgs struct {
	values map[string]string
	bools  map[string]bool
	args   []string
}

func (p parsedArgs) value(name string) (string, bool) {
	v, ok := p.values[name]
	return v, ok
}

type usageError struct{ message string }

func (e *usageError) Error() string { return e.message }

func usagef(format string, args ...any) error {
	return &usageError{fmt.Sprintf(format, args...)}
}

// globalFlags apply to every command.
var globalFlags = []flagSpec{
	{name: "format", metavar: "table|json", usage: "output format; json is a stable shape for scripts (default table)"},
	{name: "json", usage: "same as --format json"},
	{name: "help", usage: "show help for the command"},
}

func parseArgs(args []string, specs []flagSpec) (parsedArgs, error) {
	all := append(append([]flagSpec{}, specs...), globalFlags...)
	byName := make(map[string]flagSpec, len(all))
	for _, spec := range all {
		byName[spec.name] = spec
	}
	out := parsedArgs{values: map[string]string{}, bools: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--":
			out.args = append(out.args, args[i+1:]...)
			return out, nil
		case arg == "-h":
			out.bools["help"] = true
		case strings.HasPrefix(arg, "--") && len(arg) > 2:
			name, value, hasValue := strings.Cut(arg[2:], "=")
			spec, ok := byName[name]
			if !ok {
				return out, usagef("unknown flag --%s", name)
			}
			if spec.metavar == "" {
				if hasValue {
					return out, usagef("--%s takes no value", name)
				}
				out.bools[name] = true
				continue
			}
			if !hasValue {
				if i+1 >= len(args) {
					return out, usagef("--%s needs a value (%s)", name, spec.metavar)
				}
				i++
				value = args[i]
			}
			if _, seen := out.values[name]; seen {
				return out, usagef("--%s given twice", name)
			}
			out.values[name] = value
		case strings.HasPrefix(arg, "-") && arg != "-":
			return out, usagef("unknown flag %s", arg)
		default:
			out.args = append(out.args, arg)
		}
	}
	return out, nil
}

type outputFormat int

const (
	formatTable outputFormat = iota
	formatJSON
)

func resolveFormat(p parsedArgs) (outputFormat, error) {
	value, given := p.value("format")
	switch {
	case p.bools["json"] && given && value != "json":
		return 0, usagef("--json and --format %s disagree", value)
	case p.bools["json"]:
		return formatJSON, nil
	case !given || value == "table":
		return formatTable, nil
	case value == "json":
		return formatJSON, nil
	}
	return 0, usagef("--format must be table or json, not %q", value)
}
