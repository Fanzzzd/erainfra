package agent

import "testing"

func TestBuildInstallPlanForGatewayRelay(t *testing.T) {
	plan, err := BuildInstallPlan(Enrollment{
		Token:       "fp_test",
		MachineName: "sg-gateway-1",
		Roles:       []Role{RoleGateway, RoleRelay},
		Region:      "sg",
		PanelURL:    "https://panel.example.com",
		NetmakerURL: "https://netmaker.example.com",
	})
	if err != nil {
		t.Fatalf("BuildInstallPlan returned error: %v", err)
	}
	if len(plan) != 5 {
		t.Fatalf("expected 5 steps, got %d", len(plan))
	}
	if plan[3].Name != "install-cloudflared" {
		t.Fatalf("expected cloudflared step for gateway, got %q", plan[3].Name)
	}
	if plan[4].Name != "enable-relay" {
		t.Fatalf("expected relay step, got %q", plan[4].Name)
	}
}

func TestValidateEnrollment(t *testing.T) {
	err := ValidateEnrollment(Enrollment{})
	if err == nil {
		t.Fatal("expected validation error")
	}
}
