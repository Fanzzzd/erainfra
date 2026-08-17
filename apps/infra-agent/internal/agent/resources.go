package agent

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// ResourceReport is what the agent sends with each heartbeat. Best-effort and
// dep-free: Linux fields are read from /proc; on other OSes they stay zero.
type ResourceReport struct {
	CPUCount       int     `json:"cpuCount"`
	GoOS           string  `json:"goos"`
	GoArch         string  `json:"goarch"`
	MemTotalMB     int64   `json:"memTotalMb"`
	MemAvailableMB int64   `json:"memAvailableMb"`
	LoadAvg1       float64 `json:"loadAvg1"`
}

func CollectResources() ResourceReport {
	r := ResourceReport{CPUCount: runtime.NumCPU(), GoOS: runtime.GOOS, GoArch: runtime.GOARCH}
	if runtime.GOOS == "linux" {
		r.MemTotalMB, r.MemAvailableMB = readMeminfo()
		r.LoadAvg1 = readLoadAvg1()
	}
	return r
}

func readMeminfo() (totalMB, availMB int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		kb, _ := strconv.ParseInt(fields[1], 10, 64) // value is in kB
		switch fields[0] {
		case "MemTotal:":
			totalMB = kb / 1024
		case "MemAvailable:":
			availMB = kb / 1024
		}
	}
	return totalMB, availMB
}

func readLoadAvg1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}
