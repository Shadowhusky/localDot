package keys

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// BindingIdentity hashes only public routing/auth-format policy. Credential values,
// surrogate IDs and proxy tokens are never part of a task's durable policy.
func BindingIdentity(b Binding) string {
	type op struct {
		Method, Path, Body, Cap string
		Model, Free             bool
	}
	ops := make([]op, 0, len(b.Ops))
	for _, o := range b.Ops {
		pattern := ""
		if o.Path != nil {
			pattern = o.Path.String()
		}
		ops = append(ops, op{o.Method, pattern, o.Body, o.Cap, o.Model, o.Free})
	}
	upstream := ""
	if b.Upstream != nil {
		upstream = b.Upstream.String()
	}
	raw, _ := json.Marshal(struct {
		SecretID, Tag, Route, Upstream, Header string
		Local                                  bool
		Format                                 Format
		Ops                                    []op
	}{b.SecretID, b.Tag, b.Route, upstream, b.Header, b.Local, b.Format, ops})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
