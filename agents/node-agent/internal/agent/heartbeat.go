package agent

import "time"

// Heartbeat is sent over the outbound control channel on an interval. The agent
// dials out to the panel; no inbound port is opened.
type Heartbeat struct {
	MachineName  string         `json:"machineName"`
	Roles        []Role         `json:"roles"`
	AgentVersion string         `json:"agentVersion"`
	At           time.Time      `json:"at"`
	Resources    ResourceReport `json:"resources"`
}

func BuildHeartbeat(machineName string, roles []Role, agentVersion string) Heartbeat {
	return Heartbeat{
		MachineName:  machineName,
		Roles:        roles,
		AgentVersion: agentVersion,
		At:           time.Now().UTC(),
		Resources:    CollectResources(),
	}
}
