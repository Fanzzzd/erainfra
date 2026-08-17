package agent

import (
	"errors"
	"testing"
)

func TestResolveRejectsUnknownOperation(t *testing.T) {
	_, err := Resolve(Operation{Name: "rm -rf /", Args: map[string]string{}})
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("expected ErrNotAllowed, got %v", err)
	}
}

func TestResolveRejectsNonPortlessUnit(t *testing.T) {
	_, err := Resolve(Operation{Name: "systemctl.restart", Args: map[string]string{"unit": "sshd"}})
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("expected rejection for non-portless unit, got %v", err)
	}
}

func TestResolveAllowsPortlessUnit(t *testing.T) {
	cmd, err := Resolve(Operation{Name: "systemctl.restart", Args: map[string]string{"unit": "portless-nomad"}})
	if err != nil {
		t.Fatalf("expected portless unit allowed, got %v", err)
	}
	want := []string{"systemctl", "restart", "portless-nomad"}
	if len(cmd.Argv) != len(want) {
		t.Fatalf("argv = %v, want %v", cmd.Argv, want)
	}
	for i := range want {
		if cmd.Argv[i] != want[i] {
			t.Fatalf("argv = %v, want %v", cmd.Argv, want)
		}
	}
}

func TestResolveRejectsShellInjectionInArgs(t *testing.T) {
	_, err := Resolve(Operation{Name: "systemctl.restart", Args: map[string]string{"unit": "portless-x; rm -rf /"}})
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("expected injection rejected, got %v", err)
	}
}

func TestServiceLogsValidatesLines(t *testing.T) {
	_, err := Resolve(Operation{Name: "service.logs", Args: map[string]string{"unit": "portless-api", "lines": "abc"}})
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("expected invalid lines rejected, got %v", err)
	}
	cmd, err := Resolve(Operation{Name: "service.logs", Args: map[string]string{"unit": "portless-api", "lines": "50"}})
	if err != nil {
		t.Fatalf("expected valid logs op, got %v", err)
	}
	if cmd.Path != "journalctl" {
		t.Fatalf("expected journalctl, got %q", cmd.Path)
	}
}

func TestIsPortlessUnit(t *testing.T) {
	if !IsPortlessUnit("portless-consul.service") {
		t.Fatal("expected portless-consul.service to be allowed")
	}
	if IsPortlessUnit("nginx") {
		t.Fatal("expected nginx to be rejected")
	}
}

func TestResolveContainerOperationsValidateNamesAndArguments(t *testing.T) {
	remove, err := Resolve(Operation{Name: "container.remove", Args: map[string]string{"name": "flight-web"}})
	if err != nil {
		t.Fatalf("expected a Portless container name to be removable: %v", err)
	}
	if remove.Path != "docker" || len(remove.Argv) != 4 || remove.Argv[3] != "flight-web" {
		t.Fatalf("unexpected remove command: %+v", remove)
	}
	for _, op := range []Operation{
		{Name: "container.remove", Args: map[string]string{"name": "../../host"}},
		{Name: "container.network.remove", Args: map[string]string{"name": "host"}},
		{Name: "container.logs", Args: map[string]string{"name": "flight-web", "lines": "100", "extra": "ignored"}},
	} {
		if _, err := Resolve(op); !errors.Is(err, ErrNotAllowed) {
			t.Fatalf("unsafe operation accepted: %+v err=%v", op, err)
		}
	}
}
