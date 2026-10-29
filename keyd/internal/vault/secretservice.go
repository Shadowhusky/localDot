package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const secretServiceTimeout = 10 * time.Second

// SecretService keeps values in the desktop keyring (GNOME Keyring, KWallet) through libsecret's
// secret-tool, for Linux sessions that run one. Each value is one item, found by its service and
// account attributes; the item holds the binding beside the value, so a read never serves another
// destination. Any program of this user can ask the keyring for an item: there is no per-program
// rule like the Keychain's, so the binding and keyd's own checks are the guard.
type SecretService struct {
	Service string
	tool    tool
}

// NewSecretService finds secret-tool and the session bus; Check says whether the keyring answers.
func NewSecretService(service string, getenv func(string) string) *SecretService {
	return &SecretService{
		Service: service,
		tool:    tool{path: systemProgram("secret-tool"), env: sessionEnv(getenv), timeout: secretServiceTimeout},
	}
}

var errNoKeyring = errors.New("secret service: no unlocked keyring answers in this session")

// Check stores, reads back and clears a probe item. A keyring that is locked, or that would ask on a
// screen nobody is watching, fails at its deadline instead of waiting.
func (s *SecretService) Check() error {
	if s.tool.path == "" || !hasSessionBus(s.tool.env) || !ValidService(s.Service) {
		return errNoKeyring
	}
	ctx, cancel := s.tool.deadline()
	defer cancel()
	probe := []string{"service", s.Service + "-probe", "account", "probe"}
	value := []byte("keyd-probe")
	if r := s.tool.run(ctx, value, append([]string{"store", "--label=localDot keyd check"}, probe...)...); r.code != 0 {
		return errNoKeyring
	}
	r := s.tool.run(ctx, nil, append([]string{"lookup"}, probe...)...)
	s.tool.run(ctx, nil, append([]string{"clear"}, probe...)...)
	if r.code != 0 || !bytes.Equal(bytes.TrimSpace(r.stdout), value) {
		return errNoKeyring
	}
	return nil
}

// secret-tool reads at most 8191 bytes, so a value travels in hex parts of servicePartHex
// characters; the head item names the parts' count, the write that made them and the binding.
const (
	servicePartHex  = 4000
	maxServiceParts = (2*maxValueLen + servicePartHex - 1) / servicePartHex
)

// Put writes the parts, then the head that names them, then reads the value back: a write the keyring
// cut short is an error, never a stored fragment.
func (s *SecretService) Put(id string, value []byte, binding string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("secret service: %q is not a secret id", id)
	}
	if len(value) == 0 || len(value) > maxValueLen {
		return fmt.Errorf("secret service: store %s: want 1-%d bytes", id, maxValueLen)
	}
	if !bindingPattern.MatchString(binding) || !ValidService(s.Service) {
		return fmt.Errorf("secret service: store %s: invalid item (%w)", id, errUnchanged)
	}
	gen, err := newWriteID()
	if err != nil {
		return fmt.Errorf("secret service: store %s: %w (%w)", id, err, errUnchanged)
	}
	ctx, cancel := s.tool.deadline()
	defer cancel()
	encoded := hex.EncodeToString(value)
	n := (len(encoded) + servicePartHex - 1) / servicePartHex
	for i := range n {
		part := []byte(gen + ":" + encoded[i*servicePartHex:min(len(encoded), (i+1)*servicePartHex)])
		r := s.tool.run(ctx, part, append([]string{"store", "--label=localDot key " + id}, s.part(id, strconv.Itoa(i))...)...)
		clear(part)
		if !r.started && i == 0 {
			return fmt.Errorf("secret service: store %s: secret-tool could not start (%w)", id, errUnchanged)
		}
		if r.code != 0 {
			return s.abandon(ctx, id)
		}
	}
	head := []byte(serviceHead(gen, n, binding))
	if r := s.tool.run(ctx, head, append([]string{"store", "--label=localDot key " + id}, s.part(id, "head")...)...); r.code != 0 {
		return s.abandon(ctx, id)
	}
	if got, err := s.get(ctx, id, binding); err != nil || !bytes.Equal(got, value) {
		return s.abandon(ctx, id)
	}
	for i := n; i < maxServiceParts; i++ {
		s.tool.run(ctx, nil, append([]string{"clear"}, s.part(id, strconv.Itoa(i))...)...)
	}
	return nil
}

// abandon ends a failed Put. The keyring may hold the new value, the old one or a mix: take the
// whole item away, so the vault restores the old value or fails closed.
func (s *SecretService) abandon(ctx context.Context, id string) error {
	s.tool.run(ctx, nil, append([]string{"clear"}, s.attributes(id)...)...)
	return fmt.Errorf("secret service: store %s: write did not complete", id)
}

func (s *SecretService) Get(id, binding string) ([]byte, error) {
	if !idPattern.MatchString(id) || !bindingPattern.MatchString(binding) || !ValidService(s.Service) {
		return nil, errors.New("secret service: invalid secret id or binding")
	}
	ctx, cancel := s.tool.deadline()
	defer cancel()
	return s.get(ctx, id, binding)
}

// get refuses a value stored for another binding before reading any of its parts.
func (s *SecretService) get(ctx context.Context, id, binding string) ([]byte, error) {
	head, err := s.lookup(ctx, id, "head")
	if err != nil {
		return nil, err
	}
	gen, n, bound, ok := parseServiceHead(head)
	switch {
	case !ok:
		return nil, fmt.Errorf("secret service: item %s is not keyd's", id)
	case bound != binding:
		return nil, fmt.Errorf("secret service: item %s: %w", id, ErrRebound)
	}
	var encoded strings.Builder
	for i := range n {
		part, err := s.lookup(ctx, id, strconv.Itoa(i))
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		g, data, _ := strings.Cut(part, ":")
		if err != nil || g != gen || len(data) == 0 || len(data) > servicePartHex {
			return nil, fmt.Errorf("secret service: item %s was torn by an interrupted write; store it again", id)
		}
		encoded.WriteString(data)
	}
	value, err := hex.DecodeString(encoded.String())
	if err != nil || len(value) == 0 || len(value) > maxValueLen {
		return nil, fmt.Errorf("secret service: item %s was torn by an interrupted write; store it again", id)
	}
	return value, nil
}

func (s *SecretService) lookup(ctx context.Context, id, part string) (string, error) {
	r := s.tool.run(ctx, nil, append([]string{"lookup"}, s.part(id, part)...)...)
	switch {
	case r.timedOut:
		return "", fmt.Errorf("secret service: read %s: the keyring did not answer", id)
	case missing(r):
		return "", ErrNotFound
	case r.code != 0:
		return "", fmt.Errorf("secret service: read %s: secret-tool exited with status %d", id, r.code)
	}
	return string(bytes.TrimSpace(r.stdout)), nil
}

// missing is secret-tool's answer for no such item: status 1 and not a word.
func missing(r toolResult) bool {
	return r.code == 1 && !r.stderr && len(r.stdout) == 0
}

// Delete clears the head and every part, then makes sure the keyring no longer answers for either.
func (s *SecretService) Delete(id string) error {
	if !idPattern.MatchString(id) || !ValidService(s.Service) {
		return errors.New("secret service: invalid secret id")
	}
	ctx, cancel := s.tool.deadline()
	defer cancel()
	_, err := s.lookup(ctx, id, "head")
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	s.tool.run(ctx, nil, append([]string{"clear"}, s.attributes(id)...)...)
	for _, part := range []string{"head", "0"} {
		if _, gone := s.lookup(ctx, id, part); !errors.Is(gone, ErrNotFound) {
			return fmt.Errorf("secret service: delete %s: the item is still there", id)
		}
	}
	return err
}

// forgetAll clears every item under the service at once: each value's head and parts and keyd's own.
func (s *SecretService) forgetAll() error {
	if !ValidService(s.Service) {
		return errors.New("secret service: invalid service")
	}
	ctx, cancel := s.tool.deadline()
	defer cancel()
	if r := s.tool.run(ctx, nil, "clear", "service", s.Service); r.code != 0 && !missing(r) {
		return errors.New("secret service: the keyring items could not all be cleared")
	}
	return nil
}

func (s *SecretService) attributes(id string) []string {
	return []string{"service", s.Service, "account", id}
}

func (s *SecretService) part(id, part string) []string {
	return append(s.attributes(id), "part", part)
}

func serviceHead(gen string, count int, binding string) string {
	return fmt.Sprintf("keyd:2:%s:%d:%s", gen, count, binding)
}

func parseServiceHead(head string) (gen string, count int, binding string, ok bool) {
	parts := strings.Split(head, ":")
	if len(parts) != 5 || parts[0] != "keyd" || parts[1] != "2" || !bindingPattern.MatchString(parts[4]) {
		return "", 0, "", false
	}
	count, err := strconv.Atoi(parts[3])
	if err != nil || count < 1 || count > maxServiceParts || parts[2] == "" {
		return "", 0, "", false
	}
	return parts[2], count, parts[4], true
}
