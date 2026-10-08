//go:build !darwin

package nativewatch

import "os"

func Run(_ []string, _, _, _, _, _ *os.File, _ int) int { return 2 }
func RunResourceLock(_ []string, _, _ *os.File) int     { return 2 }
