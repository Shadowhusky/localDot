package vault

import (
	"errors"
	"regexp"
)

// ErrNotKeyd means the process at the other end of a socket is not a keyd daemon of this user.
var ErrNotKeyd = errors.New("the other end is not a keyd")

// DefaultService is the Keychain and keyring service of the installation's first dot. Every other
// dot on the machine keeps its items under its own, DefaultService + "." + its id, so two keyds
// never claim the same service or read each other's items.
const DefaultService = "localdot-keyd"

const testService = "localdot-keyd-test"

var dotService = regexp.MustCompile(`^localdot-keyd(\.[a-z][a-z0-9-]{0,23})?$`)

// DotService reports whether service is a dot's own service.
func DotService(service string) bool { return dotService.MatchString(service) }

// ValidService reports whether the item helper and the keyring may serve service: a dot's, or the
// one the tests use.
func ValidService(service string) bool { return DotService(service) || service == testService }
