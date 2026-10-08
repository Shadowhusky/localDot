//go:build !darwin || !cgo

package nativewatch

func supported() bool                        { return false }
func observeGroup(_ int) (groupState, error) { return groupState{}, ErrUnsupported }
func renameResource(_, _ string) error       { return ErrUnsupported }
