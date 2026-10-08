package admin

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

type ReleaseIdentity struct {
	Version        string `json:"version"`
	PackageSHA256  string `json:"packageSha256"`
	ManifestSHA256 string `json:"manifestSha256"`
}

// Identity is supplied by the verified installer, not by an admin request. It contains public
// release metadata only. The installer must still verify the executable and launched process.
type ServiceIdentity struct {
	OwnerID string          `json:"ownerId"`
	Release ReleaseIdentity `json:"release"`
}

type ServiceProcessIdentity struct {
	ServiceIdentity
	PID int `json:"pid"`
}

var serviceOwnerPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var serviceHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var serviceVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$`)

func (s ServiceIdentity) Valid() bool {
	return serviceOwnerPattern.MatchString(s.OwnerID) &&
		len(s.Release.Version) <= 64 && serviceVersionPattern.MatchString(s.Release.Version) &&
		serviceHashPattern.MatchString(s.Release.PackageSHA256) &&
		serviceHashPattern.MatchString(s.Release.ManifestSHA256)
}

func ParseServiceIdentity(raw string) (*ServiceIdentity, error) {
	failure := errors.New("invalid installed service identity")
	if len(raw) > 1024 {
		return nil, failure
	}
	var identity ServiceIdentity
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&identity); err != nil || !identity.Valid() {
		return nil, failure
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, failure
	}
	return &identity, nil
}
