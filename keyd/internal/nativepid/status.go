// Package nativepid observes one recorded process group. It never signals a process,
// reads arguments or environments, or treats an unreadable group as retired.
package nativepid

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
)

var unknown = errors.New("process group status unavailable")

type member struct {
	pid, parent, uid int
	start            string
	live             bool
}
type reply struct {
	State string `json:"state"`
	Start string `json:"start,omitempty"`
}

func Run(args []string, out io.Writer) int {
	if len(args) < 2 || len(args) > 3 {
		return 2
	}
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid < 2 || pid > 2147483647 {
		return 2
	}
	if args[0] != "identity" && args[0] != "status" {
		return 2
	}
	if (args[0] == "identity" && len(args) != 2) || (args[0] == "status" && (len(args) != 3 || len(args[2]) > 64)) {
		return 2
	}
	rows, err := group(pid)
	result := reply{State: "unknown"}
	if err == nil {
		if args[0] == "identity" {
			for _, p := range rows {
				if p.pid == pid && p.parent == os.Getppid() && p.uid == os.Getuid() && p.live {
					result = reply{State: "owned", Start: p.start}
					break
				}
			}
		} else {
			result.State = state(rows, pid, args[2])
		}
	}
	_ = json.NewEncoder(out).Encode(result)
	return 0
}
func state(rows []member, pid int, start string) string {
	live := false
	reused := false
	for _, p := range rows {
		if p.live {
			live = true
		}
		if p.pid == pid && p.start != start {
			reused = true
		}
	}
	if !live {
		return "exited"
	}
	if reused {
		return "unknown"
	}
	return "alive"
}
