package vault

import (
	"bytes"
	"errors"
	"os"
	"time"
)

// Credentials wraps the file vault's key so that only this machine can unwrap it.
type Credentials interface {
	Encrypt(plain []byte) ([]byte, error)
	Decrypt(sealed []byte) ([]byte, error)
	// TPM reports whether the wrap also needs this machine's TPM.
	TPM() bool
}

// credentialName is the name systemd-creds binds a wrapped vault key to, so one dot's key never
// unwraps as another's. The first dot keeps the name keyd has always used.
func credentialName(service string) string {
	if service == "" || service == DefaultService {
		return "localdot-keyd-vault"
	}
	return service + "-vault"
}

// SystemdCreds wraps with systemd-creds: this user's scope of the host key, plus the TPM when the
// machine has one. root, which has no user scope, uses the system scope.
type SystemdCreds struct {
	tool tool
	user bool
	tpm  bool
	// The Keychain and keyring service of the dot whose vault this wraps.
	service string
}

var errNoCredentials = errors.New("systemd-creds cannot wrap keys on this machine")

// FindSystemdCreds returns systemd-creds for service's vault when it can wrap and unwrap a probe
// here, or nil.
func FindSystemdCreds(getenv func(string) string, service string) *SystemdCreds {
	path := systemProgram("systemd-creds")
	if path == "" {
		return nil
	}
	c := &SystemdCreds{tool: tool{path: path, env: sessionEnv(getenv), timeout: 15 * time.Second}, user: os.Getuid() != 0, service: service}
	if c.probe() != nil {
		return nil
	}
	return c
}

func (c *SystemdCreds) probe() error {
	ctx, cancel := c.tool.deadline()
	defer cancel()
	c.tpm = c.tool.run(ctx, nil, "has-tpm2", "--quiet").code == 0
	value := []byte("keyd-probe")
	sealed, err := c.Encrypt(value)
	if err != nil {
		return err
	}
	if got, err := c.Decrypt(sealed); err != nil || !bytes.Equal(got, value) {
		return errNoCredentials
	}
	return nil
}

func (c *SystemdCreds) TPM() bool { return c.tpm }

func (c *SystemdCreds) args(op string) []string {
	args := []string{op, "--name=" + credentialName(c.service)}
	if c.user {
		args = append(args, "--user")
	}
	return append(args, "-", "-")
}

func (c *SystemdCreds) Encrypt(plain []byte) ([]byte, error) {
	ctx, cancel := c.tool.deadline()
	defer cancel()
	r := c.tool.run(ctx, plain, c.args("encrypt")...)
	if r.code != 0 || len(r.stdout) == 0 {
		return nil, errNoCredentials
	}
	return bytes.TrimSpace(r.stdout), nil
}

func (c *SystemdCreds) Decrypt(sealed []byte) ([]byte, error) {
	ctx, cancel := c.tool.deadline()
	defer cancel()
	r := c.tool.run(ctx, sealed, c.args("decrypt")...)
	if r.code != 0 || len(r.stdout) == 0 {
		return nil, errors.New("systemd-creds could not unwrap the vault key on this machine")
	}
	return r.stdout, nil
}
