//go:build (!darwin && !linux) || (darwin && !cgo)

package nativepid

func group(_ int) ([]member, error) { return nil, unknown }
