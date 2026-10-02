package keys

import (
	"encoding/base64"
	"testing"
)

func TestGluedBasicPrefixesCannotHideASurrogate(t *testing.T) {
	f := newFixture(t)
	encoded := base64.StdEncoding.EncodeToString([]byte("x:" + f.pass.Token))
	for _, prefix := range []string{"Basic", "bAsIc:", "Basic;", "Basic="} {
		for _, dest := range []Dest{https("git.example.test"), https("unbound.example.test")} {
			v := at(t, f.r, dest, "GET", "/", hdr("Authorization", prefix+encoded))
			if v.Allow || v.Reason != ReasonMisplacedSurrogate || v.SurrogateID != f.pass.ID {
				t.Errorf("%s prefix escaped inspection at %s: %+v", prefix, dest.Host, v)
			}
		}
	}
}
