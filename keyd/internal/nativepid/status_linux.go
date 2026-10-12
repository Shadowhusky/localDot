//go:build linux

package nativepid

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func group(pid int) ([]member, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil || len(entries) > 32768 {
		return nil, unknown
	}
	rows := []member{}
	for _, entry := range entries {
		id, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		path := "/proc/" + entry.Name()
		raw, err := os.ReadFile(path + "/stat")
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || len(raw) > 65536 {
			return nil, unknown
		}
		end := bytes.LastIndexByte(raw, ')')
		if end < 0 {
			return nil, unknown
		}
		fields := strings.Fields(string(raw[end+1:]))
		if len(fields) < 20 {
			return nil, unknown
		}
		pg, err := strconv.Atoi(fields[2])
		if err != nil {
			return nil, unknown
		}
		if pg != pid {
			continue
		}
		parent, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, unknown
		}
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, unknown
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil, unknown
		}
		rows = append(rows, member{id, parent, int(st.Uid), fields[19], fields[0] != "Z" && fields[0] != "X"})
	}
	return rows, nil
}
