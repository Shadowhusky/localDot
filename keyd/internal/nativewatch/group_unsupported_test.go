//go:build !darwin || !cgo

package nativewatch

import (
	"errors"
	"testing"
)

func TestUnsupportedRefusesBeforeSpawn(t *testing.T) {
	process, err := Start(Config{Command: "/usr/bin/true", Dir: "/", Env: []string{}})
	if process != nil || !errors.Is(err, ErrUnsupported) {
		t.Fatal("unsupported supervisor accepted launch")
	}
	if Run(nil, nil, nil, nil, nil, nil, -1) != 2 {
		t.Fatal("unsupported helper protocol accepted launch")
	}
}
