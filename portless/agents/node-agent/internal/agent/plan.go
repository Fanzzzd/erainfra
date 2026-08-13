package agent

import (
	"errors"
	"fmt"
	"slices"
)

type Role string

const (
	RoleGateway  Role = "gateway"
	RoleWorker   Role = "worker"
	RoleDatabase Role = "database"
	RoleRelay    Role = "relay"
)

type Enrollment struct {
	Token       string `json:"token"`
	MachineName string `json:"machineName"`
	Roles       []Role `json:"roles"`
	Region      string `json:"region"`
	PanelURL    string `json:"panelUrl"`
	NetmakerURL string `json:"netmakerUrl"`
}

type InstallStep struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Command     string `json:"command"`
}

func ValidateEnrollment(input Enrollment) error {
	if input.Token == "" {
		return errors.New("token is required")
	}
	if input.MachineName == "" {
		return errors.New("machineName is required")
	}
	if input.PanelURL == "" {
		return errors.New("panelUrl is required")
	}
	if input.NetmakerURL == "" {
		return errors.New("netmakerUrl is required")
	}
	if len(input.Roles) == 0 {
		return errors.New("at least one role is required")
	}
	return nil
}

func BuildInstallPlan(input Enrollment) ([]InstallStep, error) {
	if err := ValidateEnrollment(input); err != nil {
		return nil, err
	}

	steps := []InstallStep{
		{
			Name:        "register-agent",
			Description: "Register this machine with Portless over the outbound control channel.",
			Command:     fmt.Sprintf("portless-agent register --panel %q --token %q --name %q", input.PanelURL, input.Token, input.MachineName),
		},
		{
			Name:        "install-netclient",
			Description: "Install Netmaker netclient to join the performance-first WireGuard fabric.",
			Command:     fmt.Sprintf("portless-agent install netclient --server %q", input.NetmakerURL),
		},
		{
			Name:        "install-nomad-consul",
			Description: "Install Nomad and Consul agents for scheduling and service discovery.",
			Command:     "portless-agent install nomad consul",
		},
	}

	if slices.Contains(input.Roles, RoleGateway) {
		steps = append(steps, InstallStep{
			Name:        "install-cloudflared",
			Description: "Install cloudflared because this machine may expose public ingress through Cloudflare Tunnel.",
			Command:     "portless-agent install cloudflared traefik",
		})
	}

	if slices.Contains(input.Roles, RoleRelay) {
		steps = append(steps, InstallStep{
			Name:        "enable-relay",
			Description: "Enable WireGuard relay mode for peers that cannot establish direct NAT-punched paths.",
			Command:     "portless-agent network enable-relay",
		})
	}

	return steps, nil
}
