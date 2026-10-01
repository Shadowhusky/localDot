package keys

import (
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Characters a tool might unescape are built from code points.
var (
	tab          = string(rune(9))
	newline      = string(rune(10))
	backslash    = string(rune(92))
	del          = string(rune(0x7f))
	eAcute       = string(rune(0xe9))
	fullwidthDot = string(rune(0xff0e))
)

const integrityHost = "api.example.test"

// fixture mints, for cell c1 on integrityHost, one surrogate per format plus the neighbours the
// rules must tell apart: a second surrogate of the same secret and a second secret on the same header.
type fixture struct {
	r                                *Registry
	bearer, bearer2, bearerOther     Entry
	raw, raw2, rawSameHeader, rawApp Entry
	user, pass, pass2                Entry
	llm                              Entry
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	r := NewRegistry()
	m := func(rec vault.Record) Entry {
		t.Helper()
		b, err := FromRecord(rec)
		if err != nil {
			t.Fatal(err)
		}
		e, err := r.Mint("c1", b)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	httpRec := func(id, header, format string) vault.Record {
		return vault.Record{ID: id, Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: header, Format: format}
	}
	f := fixture{r: r}
	f.bearer = m(httpRec("api", "Authorization", "bearer"))
	f.bearer2 = m(httpRec("api", "Authorization", "bearer"))
	f.bearerOther = m(httpRec("api-other", "Authorization", "bearer"))
	f.raw = m(httpRec("dd-api", "Dd-Api-Key", "raw"))
	f.raw2 = m(httpRec("dd-api", "Dd-Api-Key", "raw"))
	f.rawSameHeader = m(httpRec("dd-api-b", "Dd-Api-Key", "raw"))
	f.rawApp = m(httpRec("dd-app", "Dd-Application-Key", "raw"))
	f.user = m(vault.Record{ID: "pay", Kind: vault.KindHTTP, Hosts: []string{"pay.example.test"}, Header: "Authorization", Format: "basic-user"})
	f.pass = m(vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"})
	f.pass2 = m(vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"})
	f.llm = m(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})
	return f
}

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i < len(kv); i += 2 {
		h.Add(kv[i], kv[i+1])
	}
	return h
}

func basicOf(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

// at inspects a request as the cell listener hands it over: the target parsed the way net/http
// parses a request line.
func at(t *testing.T, r *Registry, d Dest, method, target string, h http.Header) Verdict {
	t.Helper()
	u, err := url.ParseRequestURI(target)
	if err != nil {
		t.Fatalf("%q: %v", target, err)
	}
	return r.Inspect(d, method, u, h)
}

func https(host string) Dest { return Dest{Cell: "c1", Scheme: "https", Host: host} }

func wantDeny(t *testing.T, name string, v Verdict, reason string) {
	t.Helper()
	if v.Allow || v.Reason != reason || v.SurrogateID == "" || len(v.Swaps) != 0 {
		t.Errorf("%s: %+v, want deny %s with a surrogate id and no swaps", name, v, reason)
	}
}

func wantAllow(t *testing.T, name string, v Verdict, swaps int) {
	t.Helper()
	if !v.Allow || len(v.Swaps) != swaps {
		t.Errorf("%s: %+v, want allow with %d swaps", name, v, swaps)
	}
}

func TestTwoSurrogatesInOneValueAreRefused(t *testing.T) {
	f := newFixture(t)
	git := https("git.example.test")
	for _, sep := range []string{"", " ", ",", ";", ", ", "; "} {
		cases := []struct {
			name string
			d    Dest
			h    http.Header
		}{
			{"raw, the same surrogate twice", https(integrityHost), hdr("Dd-Api-Key", f.raw.Token+sep+f.raw.Token)},
			{"raw, two surrogates of one secret", https(integrityHost), hdr("Dd-Api-Key", f.raw.Token+sep+f.raw2.Token)},
			{"raw, two secrets bound to this header", https(integrityHost), hdr("Dd-Api-Key", f.raw.Token+sep+f.rawSameHeader.Token)},
			{"raw, a secret bound to another header", https(integrityHost), hdr("Dd-Api-Key", f.raw.Token+sep+f.rawApp.Token)},
			{"bearer, the same surrogate twice", https(integrityHost), hdr("Authorization", "Bearer "+f.bearer.Token+sep+f.bearer.Token)},
			{"bearer, two surrogates of one secret", https(integrityHost), hdr("Authorization", "Bearer "+f.bearer.Token+sep+f.bearer2.Token)},
			{"bearer, two secrets bound to this header", https(integrityHost), hdr("Authorization", "Bearer "+f.bearer.Token+sep+f.bearerOther.Token)},
			{"bearer, a second bearer", https(integrityHost), hdr("Authorization", "Bearer "+f.bearer.Token+sep+"Bearer "+f.bearer2.Token)},
			{"basic password, the same surrogate twice", git, hdr("Authorization", basicOf("x", f.pass.Token+sep+f.pass.Token))},
			{"basic password, two surrogates of one secret", git, hdr("Authorization", basicOf("x", f.pass.Token+sep+f.pass2.Token))},
			{"basic user, the same surrogate twice", https("pay.example.test"), hdr("Authorization", basicOf(f.user.Token+sep+f.user.Token, ""))},
		}
		for _, c := range cases {
			wantDeny(t, fmt.Sprintf("%s, separator %q", c.name, sep), at(t, f.r, c.d, "GET", "/", c.h), ReasonMisplacedSurrogate)
		}
	}
}

func TestASurrogateSitsExactlyInItsBoundFormat(t *testing.T) {
	f := newFixture(t)
	tok, raw := f.bearer.Token, f.raw.Token
	for _, value := range []string{
		"Bearer " + tok + " ", " Bearer " + tok, "Bearer " + tok + ",", "Bearer " + tok + ";", "Bearer ," + tok,
		"Bearer " + `"` + tok + `"`, "Bearer=" + tok, "Bearer:" + tok, "Bearer: " + tok, "Bearer" + tok, "Bearer " + tok + "x",
		"Bearer x" + tok, "Bearer  " + tok, "Bearer" + tab + tok, "Bearer " + tok + tab, "Token " + tok, "Basic " + tok,
		"Bearer " + tok + " Bearer", "Bearer Bearer " + tok, tok, "Bearer realm=" + tok,
	} {
		wantDeny(t, fmt.Sprintf("bearer value %q", strings.ReplaceAll(value, tok, "<surrogate>")), at(t, f.r, https(integrityHost), "GET", "/", hdr("Authorization", value)), ReasonMisplacedSurrogate)
	}
	for _, value := range []string{
		" " + raw, raw + " ", "x" + raw, raw + "x", raw + ",", raw + ";", `"` + raw + `"`, "Bearer " + raw, raw + "=", "=" + raw,
		raw + tab, raw + " " + raw, basicOf(raw, ""),
	} {
		h := http.Header{"Dd-Api-Key": {value}}
		wantDeny(t, fmt.Sprintf("raw value %q", strings.ReplaceAll(value, raw, "<surrogate>")), at(t, f.r, https(integrityHost), "GET", "/", h), ReasonMisplacedSurrogate)
	}
	git, pay := https("git.example.test"), https("pay.example.test")
	for _, c := range []struct {
		name string
		d    Dest
		v    string
	}{
		{"password with a suffix", git, basicOf("x", f.pass.Token+"x")},
		{"password with a prefix", git, basicOf("x", "x"+f.pass.Token)},
		{"password after a space", git, basicOf("x", " "+f.pass.Token)},
		{"password before a colon", git, basicOf("x", f.pass.Token+":y")},
		{"password before a newline", git, basicOf("x", f.pass.Token+newline)},
		{"password in the user half", git, basicOf(f.pass.Token, "x")},
		{"password in both halves", git, basicOf(f.pass.Token, f.pass.Token)},
		{"user with a suffix", pay, basicOf(f.user.Token+"x", "")},
		{"user with a prefix", pay, basicOf("x"+f.user.Token, "")},
		{"user in the password half", pay, basicOf("x", f.user.Token)},
		{"user in both halves", pay, basicOf(f.user.Token, f.user.Token)},
	} {
		wantDeny(t, "basic "+c.name, at(t, f.r, c.d, "GET", "/", hdr("Authorization", c.v)), ReasonMisplacedSurrogate)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("x:" + f.pass.Token))
	for _, c := range []struct {
		name string
		d    Dest
		h    http.Header
	}{
		{"Bearer", https(integrityHost), hdr("Authorization", "Bearer "+tok)},
		{"bearer", https(integrityHost), hdr("Authorization", "bearer "+tok)},
		{"BEARER", https(integrityHost), hdr("Authorization", "BEARER "+tok)},
		{"raw", https(integrityHost), hdr("Dd-Api-Key", raw)},
		{"Basic password", git, hdr("Authorization", "Basic "+encoded)},
		{"basic password", git, hdr("Authorization", "basic "+encoded)},
		{"BASIC password", git, hdr("Authorization", "BASIC "+encoded)},
		{"basic user with an empty password", pay, hdr("Authorization", basicOf(f.user.Token, ""))},
		{"basic user with a password", pay, hdr("Authorization", basicOf(f.user.Token, "pw"))},
	} {
		wantAllow(t, c.name, at(t, f.r, c.d, "GET", "/", c.h), 1)
	}
}

func TestASurrogateAppearsOnceInTheWholeRequest(t *testing.T) {
	f := newFixture(t)
	tok := f.bearer.Token
	encoded := "ld%5F" + tok[3:]
	final := tok[:len(tok)-1] + fmt.Sprintf("%%%02X", tok[len(tok)-1])
	bound := func(kv ...string) http.Header {
		return hdr(append([]string{"Authorization", "Bearer " + tok}, kv...)...)
	}
	nameHeader := bound()
	nameHeader["X-"+tok] = []string{"1"}
	for _, c := range []struct {
		name, target string
		h            http.Header
	}{
		{"and in another header", "/", bound("X-Copy", tok)},
		{"and in the second value of another header", "/", bound("X-Copy", "a", "X-Copy", tok)},
		{"and in a header name", "/", nameHeader},
		{"and in the path", "/a/" + tok, bound()},
		{"and percent-encoded in the path", "/a/" + encoded, bound()},
		{"and in the query", "/?a=" + tok, bound()},
		{"and percent-encoded in the query", "/?a=" + encoded, bound()},
		{"and in the query after a bad escape", "/?a=%zz&b=" + encoded, bound()},
		{"and in the query, its last character escaped", "/?a=" + final, bound()},
		{"and in the host", "https://" + tok + ".example.test/", bound()},
	} {
		wantDeny(t, "a surrogate in its bound header "+c.name, at(t, f.r, https(integrityHost), "GET", c.target, c.h), ReasonMisplacedSurrogate)
	}
}

func TestASurrogateTravelsOnlyInItsOwnHeader(t *testing.T) {
	f := newFixture(t)
	raw := f.raw.Token
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Dd-Api-Key", "Dd-Api-Key-2", "Dd-Application-Key", "X-Api-Key"} {
		wantDeny(t, "raw surrogate in "+name, at(t, f.r, https(integrityHost), "GET", "/", hdr(name, raw)), ReasonMisplacedSurrogate)
	}
	wantDeny(t, "raw surrogate in a cookie value", at(t, f.r, https(integrityHost), "GET", "/", hdr("Cookie", "k="+raw)), ReasonMisplacedSurrogate)
	wantDeny(t, "raw surrogate in a basic header of another name", at(t, f.r, https(integrityHost), "GET", "/", hdr("X-Auth", basicOf(raw, "x"))), ReasonMisplacedSurrogate)
	for _, c := range []struct {
		name string
		h    http.Header
	}{
		{"its header twice, the surrogate first", hdr("Dd-Api-Key", raw, "Dd-Api-Key", "x")},
		{"its header twice, the surrogate second", hdr("Dd-Api-Key", "x", "Dd-Api-Key", raw)},
		{"its header twice, the surrogate in both", hdr("Dd-Api-Key", raw, "Dd-Api-Key", raw)},
		{"its header under a name that is not canonical", http.Header{"dd-api-key": {raw}}},
	} {
		wantDeny(t, c.name, at(t, f.r, https(integrityHost), "GET", "/", c.h), ReasonMisplacedSurrogate)
	}
	// net/http folds a header name's case before keyd sees it; a surrogate in one is still refused.
	folded := hdr("Authorization", "Bearer "+f.bearer.Token, "X"+f.raw.Token, "1")
	if v := at(t, f.r, https(integrityHost), "GET", "/", folded); v.Allow {
		t.Errorf("a surrogate in a header name was allowed: %+v", v)
	}
}

func TestDestinationsBindSurrogatesExactly(t *testing.T) {
	f := newFixture(t)
	bearer := hdr("Authorization", "Bearer "+f.bearer.Token)
	llm := hdr("X-Api-Key", f.llm.Token)
	for _, c := range []struct {
		name string
		d    Dest
		h    http.Header
	}{
		{"an http surrogate on its host over CONNECT", Dest{Cell: "c1", Scheme: "connect", Host: integrityHost}, bearer},
		{"an http surrogate on its host over the gateway", Dest{Cell: "c1", Scheme: "gateway", Host: integrityHost}, bearer},
		{"an http surrogate on its host over plain http", Dest{Cell: "c1", Scheme: "http", Host: integrityHost}, bearer},
		{"an http surrogate on its host under another scheme", Dest{Cell: "c1", Scheme: "HTTPS", Host: integrityHost}, bearer},
		{"an http surrogate on a subdomain of its host", https("x." + integrityHost), bearer},
		{"an http surrogate on its host for another cell", Dest{Cell: "c2", Scheme: "https", Host: integrityHost}, bearer},
		{"an llm surrogate on its route over https", Dest{Cell: "c1", Scheme: "https", Host: "api.anthropic.com", Route: "anthropic"}, llm},
		{"an llm surrogate on its route over CONNECT", Dest{Cell: "c1", Scheme: "connect", Route: "anthropic"}, llm},
		{"an llm surrogate on another route", Dest{Cell: "c1", Scheme: "gateway", Route: "openai"}, llm},
		{"an llm surrogate on its route for another cell", Dest{Cell: "c2", Scheme: "gateway", Route: "anthropic"}, llm},
	} {
		wantDeny(t, c.name, at(t, f.r, c.d, "POST", "/", c.h), ReasonMisplacedSurrogate)
	}
	wantAllow(t, "an llm surrogate on its route", at(t, f.r, Dest{Cell: "c1", Scheme: "gateway", Route: "anthropic"}, "POST", "/anthropic/messages", llm), 1)
	if _, err := f.r.Mint("c1", LocalRoutes()["lmstudio"]); err == nil {
		t.Error("a surrogate was minted for a local route, which carries no secret")
	}
}

func TestEveryLLMProviderPlacesItsSurrogateItsOwnWay(t *testing.T) {
	r := NewRegistry()
	for _, c := range []struct {
		provider, base, header, prefix, wrongHeader string
	}{
		{"anthropic", "", "X-Api-Key", "", "Authorization"},
		{"openai", "", "Authorization", "Bearer ", "X-Api-Key"},
		{"google", "", "X-Goog-Api-Key", "", "X-Api-Key"},
		{"azure", "https://res.openai.azure.com/openai/v1", "Api-Key", "", "Authorization"},
		{"openai-compatible", "https://llm.example.test/v1", "Authorization", "Bearer ", "Api-Key"},
	} {
		b, err := FromRecord(vault.Record{ID: "my-" + c.provider, Kind: vault.KindLLM, Provider: c.provider, BaseURL: c.base})
		if err != nil {
			t.Fatal(err)
		}
		if b.Route != "my-"+c.provider || b.SecretID != "my-"+c.provider {
			t.Errorf("%s: route %q, secret %q, want both to be the record's id", c.provider, b.Route, b.SecretID)
		}
		e, err := r.Mint("c1", b)
		if err != nil {
			t.Fatal(err)
		}
		d := Dest{Cell: "c1", Scheme: "gateway", Route: b.Route}
		wantAllow(t, c.provider+" in its header", at(t, r, d, "POST", "/x", hdr(c.header, c.prefix+e.Token)), 1)
		wantDeny(t, c.provider+" in another header", at(t, r, d, "POST", "/x", hdr(c.wrongHeader, c.prefix+e.Token)), ReasonMisplacedSurrogate)
		wantDeny(t, c.provider+" in the query", at(t, r, d, "POST", "/x?key="+e.Token, http.Header{}), ReasonMisplacedSurrogate)
	}
}

func TestNamesAreNormalisedOnceAndMatchedExactly(t *testing.T) {
	for _, h := range []string{"API.example.test", "Api.Example.Test", "api.example.test.", " api.example.test", "api.example.test ", "api.example.test:443", "[api.example.test]", "api..example.test", ".api.example.test", "api.example.test/v1", "b" + string(rune(0xfc)) + "cher.example"} {
		if _, err := FromRecord(vault.Record{ID: "n", Kind: vault.KindHTTP, Hosts: []string{h}, Header: "Authorization", Format: "bearer"}); err == nil {
			t.Errorf("binding host %q accepted; a host is stored only as the policy writes it", h)
		}
	}
	for _, base := range []string{"https://API.example.test/v1", "https://api.example.test./v1", "https://Api.Example.Test"} {
		if _, err := FromRecord(vault.Record{ID: "n", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: base}); err == nil {
			t.Errorf("base URL %q accepted; its host is not as the policy writes it", base)
		}
	}
	r := NewRegistry()
	b, err := FromRecord(vault.Record{ID: "n", Kind: vault.KindHTTP, Hosts: []string{"api.example.test", "xn--bcher-kva.example"}, Header: "Authorization", Format: "bearer"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(b.Hosts, []string{"api.example.test", "xn--bcher-kva.example"}) {
		t.Fatalf("hosts %v changed on the way in", b.Hosts)
	}
	e, _ := r.Mint("c1", b)
	h := hdr("Authorization", "Bearer "+e.Token)
	for _, spelling := range []string{"api.example.test:443", "API.EXAMPLE.TEST:443", "Api.Example.Test.:443", "api.example.test.:443", "XN--BCHER-KVA.EXAMPLE.:443"} {
		target, reason := policy.ParseHostPort(spelling, 0)
		if reason != "" {
			t.Fatalf("%s: %s", spelling, reason)
		}
		wantAllow(t, "the policy's form of "+spelling, at(t, r, https(target.Host), "GET", "/", h), 1)
	}
	for _, host := range []string{"API.example.test", "api.example.test.", "api.example.test:443", " api.example.test", ""} {
		wantDeny(t, fmt.Sprintf("an un-normalised destination %q", host), at(t, r, https(host), "GET", "/", h), ReasonMisplacedSurrogate)
	}
}

func TestVerdictsNameSurrogatesOnlyByID(t *testing.T) {
	f := newFixture(t)
	ro := binding(t, vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "X-Ro-Key", Format: "raw", Methods: []string{"GET"}})
	roTok := mint(t, f.r, "c1", ro)
	unknown, _ := surrogate.Mint("key")
	hex12 := regexp.MustCompile(`^[0-9a-f]{12}$`)
	for _, c := range []struct {
		name, token, reason, secret string
		v                           Verdict
	}{
		{"unknown", unknown, ReasonUnknownSurrogate, "", at(t, f.r, https(integrityHost), "GET", "/", hdr("Authorization", "Bearer "+unknown))},
		{"misplaced", f.bearer.Token, ReasonMisplacedSurrogate, "api", at(t, f.r, https(integrityHost), "GET", "/?k="+f.bearer.Token, http.Header{})},
		{"policy", roTok, ReasonSurrogatePolicy, "ro", at(t, f.r, https(integrityHost), "POST", "/", hdr("X-Ro-Key", roTok))},
	} {
		v := c.v
		if v.Allow || v.Reason != c.reason || v.SecretID != c.secret || v.SurrogateID != surrogate.ID(c.token) || !hex12.MatchString(v.SurrogateID) {
			t.Errorf("%s: %+v, want reason %s, secret %q and the surrogate's id", c.name, v, c.reason, c.secret)
		}
		if text := v.Reason + " " + v.SecretID + " " + v.SurrogateID; strings.Contains(text, c.token) || strings.Contains(text, "ld_") {
			t.Errorf("%s: the verdict's fields carry the surrogate: %q", c.name, text)
		}
	}
	h := hdr("Dd-Api-Key", f.raw.Token, "Dd-Application-Key", f.rawApp.Token)
	v := at(t, f.r, https(integrityHost), "GET", "/", h)
	if !v.Allow || v.SecretID != v.Swaps[0].Binding.SecretID || v.SurrogateID != v.Swaps[0].ID || v.SurrogateID != surrogate.ID(v.Swaps[0].Token) {
		t.Errorf("an allowed verdict must name its first swap's secret and surrogate id: %+v", v)
	}
}

func TestErrorsNeverCarryAValue(t *testing.T) {
	b := binding(t, vault.Record{ID: "s", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: "basic-user"})
	for _, value := range []string{"short-v", "with-colon:real-secret-value-for-test", " real-secret-value-for-test", "real-secret-value-for-test ", "real-secret" + newline + "value-for-test", "real-secret-value" + del + "for-test"} {
		err := ValidValueFor(b, []byte(value))
		if err == nil {
			t.Errorf("value %q accepted", value)
			continue
		}
		if strings.Contains(err.Error(), strings.TrimSpace(value)) || strings.Contains(err.Error(), "real-secret") {
			t.Errorf("the error carries the value: %v", err)
		}
	}
	for _, format := range []string{"bearer", "raw", "basic-password"} {
		other := binding(t, vault.Record{ID: "s", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: format})
		if err := ValidValueFor(other, []byte("short-v")); err == nil {
			t.Errorf("%s: a value shorter than the vault allows was accepted", format)
		}
		if err := ValidValueFor(other, []byte("real-secret"+newline+"value")); err == nil {
			t.Errorf("%s: a value with a newline was accepted", format)
		}
		if err := ValidValueFor(other, []byte("with-colon:real-secret-value-for-test")); err != nil {
			t.Errorf("%s: a colon is refused only in a basic-auth user: %v", format, err)
		}
	}
	f := newFixture(t)
	h := hdr("Authorization", "Bearer "+f.bearer.Token)
	v := at(t, f.r, https(integrityHost), "GET", "/", h)
	boom := errors.New("keychain locked")
	err := ApplySwaps(h, v.Swaps, func(string) ([]byte, error) { return nil, boom })
	if !errors.Is(err, boom) || strings.Contains(err.Error(), f.bearer.Token) || strings.Contains(err.Error(), "ld_") {
		t.Errorf("ApplySwaps error %v: want the store's error, naming no surrogate", err)
	}
}

func TestSwapsWriteOnlyTheBoundHeaderInItsFormat(t *testing.T) {
	f := newFixture(t)
	values := map[string]string{"api": "real-bearer-value", "dd-api": "real-raw-value", "dd-app": "real-app-value", "git": "real-password-value", "pay": "real-user-value"}
	value := func(id string) ([]byte, error) { return []byte(values[id]), nil }
	for _, c := range []struct {
		name, host string
		h          http.Header
		want       map[string]string
	}{
		{"lower-case bearer", integrityHost, hdr("Authorization", "bearer "+f.bearer.Token, "X-Keep", "1"), map[string]string{"Authorization": "Bearer real-bearer-value"}},
		{"two raw headers", integrityHost, hdr("Dd-Api-Key", f.raw.Token, "Dd-Application-Key", f.rawApp.Token, "X-Keep", "1"), map[string]string{"Dd-Api-Key": "real-raw-value", "Dd-Application-Key": "real-app-value"}},
		{"lower-case basic, the user half kept", "git.example.test", hdr("Authorization", "basic "+base64.StdEncoding.EncodeToString([]byte("x-access token@=:"+f.pass.Token)), "X-Keep", "1"), map[string]string{"Authorization": basicOf("x-access token@=", "real-password-value")}},
		{"basic user, the password half kept", "pay.example.test", hdr("Authorization", basicOf(f.user.Token, "pw: x"), "X-Keep", "1"), map[string]string{"Authorization": basicOf("real-user-value", "pw: x")}},
	} {
		before := c.h.Clone()
		u, _ := url.ParseRequestURI("/v1/x?a=1")
		v := f.r.Inspect(https(c.host), "GET", u, c.h)
		if !v.Allow {
			t.Fatalf("%s: %+v", c.name, v)
		}
		if err := ApplySwaps(c.h, v.Swaps, value); err != nil {
			t.Fatal(err)
		}
		if u.String() != "/v1/x?a=1" {
			t.Errorf("%s: the URL changed to %s", c.name, u)
		}
		for name, vals := range c.h {
			want, swapped := c.want[name]
			switch {
			case swapped && !slices.Equal(vals, []string{want}):
				t.Errorf("%s: %s = %q, want %q", c.name, name, vals, want)
			case !swapped && !slices.Equal(vals, before[name]):
				t.Errorf("%s: %s changed from %q to %q", c.name, name, before[name], vals)
			}
		}
		if len(c.h) != len(before) {
			t.Errorf("%s: headers %v, want the same names as %v", c.name, c.h, before)
		}
	}
}

func TestPathLimitsHoldOnlyOnPathsEveryServerReadsAlike(t *testing.T) {
	r := NewRegistry()
	tok := mint(t, r, "c1", binding(t, vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1/"}}))
	h := hdr("Authorization", "Bearer "+tok)
	for _, target := range []string{
		"/v1/x%2Ejson", "/v1/x%2ejson", "/v1/%2E", "/v1/%c0%ae%c0%ae/admin", "/v1/%C0%AF..%C0%AFadmin", "/v1/x%09", "/v1/x%7f", "/v1/x%7F",
		"/v1/x%0d%0a", "/v1/" + eAcute, "/v1/%c3%a9", "/v1/" + fullwidthDot + fullwidthDot + "/admin", "/v1/./x", "/v1/x/.", "/v1/x/..",
		"/v1/x//", "/v1/x/./", "/v1/x" + backslash, "/v1/x%5C", "/v1/x%25", "/v1/x%00", "https://ro.example.test/v1/../admin",
		"https://ro.example.test", "/v1/x;", "/v1/x%3B",
	} {
		wantDeny(t, fmt.Sprintf("path %q", target), at(t, r, https("ro.example.test"), "GET", target, h), ReasonSurrogatePolicy)
	}
	for _, target := range []string{"/v1/forecast", "/v1/forecast/", "/v1/", "/v1/a.b/c-d_e~f", "/v1/x?y=1&z=%2e%2e", "https://ro.example.test/v1/x"} {
		wantAllow(t, fmt.Sprintf("path %q", target), at(t, r, https("ro.example.test"), "GET", target, h), 1)
	}
	if _, err := FromRecord(vault.Record{ID: "p", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1" + tab + "/"}}); err == nil {
		t.Error("a path prefix with a tab was accepted")
	}
	for _, prefix := range []string{"/v1" + del + "/", "/v1/" + eAcute + "/", "/v1//", "/v1/./", ""} {
		if _, err := FromRecord(vault.Record{ID: "p", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{prefix}}); err == nil {
			t.Errorf("path prefix %q accepted", prefix)
		}
	}
}

func TestMethodLimitsRefuseEveryOverrideSpelling(t *testing.T) {
	r := NewRegistry()
	tok := mint(t, r, "c1", binding(t, vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}}))
	d := https("ro.example.test")
	for _, name := range []string{"X-HTTP-Method-Override", "x-http-method-override", "X-HTTP-Method", "x-http-method", "X-Method-Override", "x-method-override"} {
		wantDeny(t, "override header "+name, at(t, r, d, "GET", "/v1/x", hdr("Authorization", "Bearer "+tok, name, "DELETE")), ReasonSurrogatePolicy)
	}
	for _, query := range []string{"_method=DELETE", "a=1;_method=DELETE", "a=1&_method=DELETE", "_METHOD=DELETE", "_Method=PUT", "%5fmethod=DELETE", "%5Fmethod=DELETE", "_me%74hod=DELETE", "_method", "_method=", "a=%zz&_method=DELETE"} {
		wantDeny(t, "query "+query, at(t, r, d, "GET", "/v1/x?"+query, hdr("Authorization", "Bearer "+tok)), ReasonSurrogatePolicy)
	}
	for _, query := range []string{"method=DELETE", "x_method=DELETE", "a=_method", "_methods=DELETE"} {
		wantAllow(t, "query "+query, at(t, r, d, "GET", "/v1/x?"+query, hdr("Authorization", "Bearer "+tok)), 1)
	}
}

func TestUnescapeDecodesEveryValidEscapeAndNeverReadsPastTheEnd(t *testing.T) {
	for in, want := range map[string]string{
		"":          "",
		"%":         "%",
		"%5":        "%5",
		"a%5":       "a%5",
		"%5F":       "_",
		"a%5f":      "a_",
		"%%5F":      "%_",
		"%zz%5Fb":   "%zz_b",
		"%5F%5f%41": "__A",
		"%2":        "%2",
		"x%4":       "x%4",
		"%G1%31":    "%G11",
		"+%20":      "+ ",
	} {
		if got := unescape(in); got != want {
			t.Errorf("unescape(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLLMRecordsTakeOnlyAProviderAndABaseURL(t *testing.T) {
	for _, rec := range []vault.Record{
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Header: "X-Api-Key"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Format: "raw"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Methods: []string{"POST"}},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Paths: []string{"/v1/"}},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://llm.example.test/v1#frag"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://llm.example.test:8443/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://llm.example.test:443/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://llm.example.test//v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://localhost/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://printer.local/v1"},
		{ID: "x", Kind: "", Provider: "anthropic"},
	} {
		if _, err := FromRecord(rec); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", rec)
		}
	}
}

func TestHTTPRecordsRefuseWhatCannotCarryASurrogate(t *testing.T) {
	rec := func(edit func(*vault.Record)) vault.Record {
		r := vault.Record{ID: "w", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: "bearer"}
		edit(&r)
		return r
	}
	var bad []vault.Record
	for _, name := range []string{"Host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Keep-Alive", "Te", "Trailer", "Upgrade", "Cookie", "Set-Cookie", "Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection"} {
		for _, spelling := range []string{name, strings.ToLower(name), strings.ToUpper(name)} {
			bad = append(bad, rec(func(r *vault.Record) { r.Header, r.Format = spelling, "raw" }))
		}
	}
	bad = append(bad,
		rec(func(r *vault.Record) { r.BaseURL = "https://api.example.test/v1" }),
		rec(func(r *vault.Record) { r.Header = "" }),
		rec(func(r *vault.Record) { r.Header = "X-Key:" }),
		rec(func(r *vault.Record) { r.Header = "X-Key" + newline }),
		rec(func(r *vault.Record) { r.Header, r.Format = "X-Key", "basic-user" }),
		rec(func(r *vault.Record) { r.Format = "" }),
		rec(func(r *vault.Record) { r.Format = "Bearer" }),
		rec(func(r *vault.Record) { r.Methods = []string{"CONNECT"} }),
		rec(func(r *vault.Record) { r.Methods = []string{"TRACE"} }),
		rec(func(r *vault.Record) { r.Methods = []string{"GET "} }),
		rec(func(r *vault.Record) { r.Hosts = []string{integrityHost, "localhost"} }),
		rec(func(r *vault.Record) { r.Hosts = []string{""} }),
	)
	var seventeen []string
	for i := range 17 {
		seventeen = append(seventeen, fmt.Sprintf("h%d.example.test", i))
	}
	bad = append(bad, rec(func(r *vault.Record) { r.Hosts = seventeen }))
	for _, r := range bad {
		if _, err := FromRecord(r); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", r)
		}
	}
	if _, err := FromRecord(rec(func(r *vault.Record) { r.Hosts = seventeen[:16] })); err != nil {
		t.Errorf("16 hosts refused: %v", err)
	}
}

func TestBindingsAreCopiesOfTheirRecords(t *testing.T) {
	r := vault.Record{ID: "w", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/"}}
	b, err := FromRecord(r)
	if err != nil {
		t.Fatal(err)
	}
	r.Hosts[0], r.Methods[0], r.Paths[0] = "evil.example.test", "DELETE", "/"
	if b.Hosts[0] != integrityHost || b.Methods[0] != "GET" || b.Paths[0] != "/v1/" {
		t.Fatalf("editing the record changed the binding: %+v", b)
	}
}

func TestGatewayOperationsAreAnExactAllowlist(t *testing.T) {
	for _, c := range []struct {
		provider, base string
		ok, refused    []string
	}{
		{"anthropic", "", []string{"POST messages", "POST messages/count_tokens", "GET models", "GET models/claude-opus-5.5"},
			[]string{"POST v1/messages", "POST xmessages", "POST messages/", "POST messages/batches", "POST messages/count_tokens/x", "GET models/", "GET models/../files", "GET models/a/b", "GET models/a..b", "DELETE models/x", "GET xmodels"}},
		{"openai", "", []string{"POST chat/completions", "POST responses", "GET models/ft:gpt-5:org:x/v2"},
			[]string{"POST chat/completions/x", "POST xchat/completions", "POST v1/chat/completions", "POST responses/x/cancel", "GET models/../files", "GET models/a/../b", "GET models/", "GET models/a/b/c", "POST files", "POST batches"}},
		{"google", "", []string{"POST models/gemini-3.6-flash:generateContent", "GET models/gemini-3.6-flash"},
			[]string{"POST models/../x:generateContent", "POST models/a/b:generateContent", "POST x/models/m:generateContent", "POST models/m:generateContent/x", "POST tunedModels/m:generateContent", "POST models/m:generateContentx", "POST models/:generateContent", "POST models/m:cachedContents", "POST files"}},
	} {
		b, err := FromRecord(vault.Record{ID: "r", Kind: vault.KindLLM, Provider: c.provider, BaseURL: c.base})
		if err != nil {
			t.Fatal(err)
		}
		for _, mp := range c.ok {
			method, p, _ := strings.Cut(mp, " ")
			if _, ok := b.Op(method, p); !ok {
				t.Errorf("%s: %s refused", c.provider, mp)
			}
		}
		for _, mp := range c.refused {
			method, p, _ := strings.Cut(mp, " ")
			if op, ok := b.Op(method, p); ok {
				t.Errorf("%s: %s allowed as %+v", c.provider, mp, op)
			}
		}
	}
	g, _ := FromRecord(vault.Record{ID: "g", Kind: vault.KindLLM, Provider: "google"})
	op, _ := g.Op("POST", "models/gemini-embedding-2.1-exp:embedContent")
	if got := op.ModelFrom("models/gemini-embedding-2.1-exp:embedContent"); got != "gemini-embedding-2.1-exp" {
		t.Errorf("ModelFrom = %q", got)
	}
}

func TestForCellListsOnlyThatCell(t *testing.T) {
	r := NewRegistry()
	b := binding(t, vault.Record{ID: "api", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: "bearer"})
	mine := mint(t, r, "c1", b)
	mint(t, r, "c2", b)
	mint(t, r, "c2", b)
	got := r.ForCell("c1")
	if len(got) != 1 || got[0].Token != mine || got[0].Cell != "c1" {
		t.Fatalf("ForCell(c1) = %+v", got)
	}
	if len(r.ForCell("c3")) != 0 {
		t.Fatal("ForCell lists surrogates of a cell that has none")
	}
	if n := r.RevokeCell("c2"); n != 2 || len(r.ForCell("c1")) != 1 {
		t.Fatalf("RevokeCell(c2) = %d and left c1 with %d", n, len(r.ForCell("c1")))
	}
}

func TestTheRegistryIsSafeForConcurrentUse(t *testing.T) {
	r := NewRegistry()
	b := binding(t, vault.Record{ID: "api", Kind: vault.KindHTTP, Hosts: []string{integrityHost}, Header: "Authorization", Format: "bearer"})
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cell := fmt.Sprintf("c%d", i%3)
			for range 200 {
				e, err := r.Mint(cell, b)
				if err != nil {
					t.Error(err)
					return
				}
				u, _ := url.ParseRequestURI("/")
				r.Inspect(Dest{Cell: cell, Scheme: "https", Host: integrityHost}, "GET", u, hdr("Authorization", "Bearer "+e.Token))
				r.Lookup(e.Token)
				r.ForCell(cell)
				if i == 0 {
					r.RevokeCell("c2")
					r.RevokeSecret("none")
				}
			}
		}()
	}
	wg.Wait()
}

func TestAFailedSwapLeavesEveryHeaderUntouched(t *testing.T) {
	f := newFixture(t)
	values := map[string]string{"api": "real-bearer-value", "dd-api": "real-raw-value", "dd-app": "real-app-value", "pay": "real-user-value"}
	boom := errors.New("keychain locked")
	h := hdr("Dd-Api-Key", f.raw.Token, "Dd-Application-Key", f.rawApp.Token)
	v := at(t, f.r, https(integrityHost), "GET", "/", h)
	if !v.Allow || len(v.Swaps) != 2 {
		t.Fatalf("%+v", v)
	}
	for _, c := range []struct {
		name  string
		h     http.Header
		swaps []Entry
	}{
		{"two raw swaps from Inspect", h, v.Swaps},
		{"a bearer swap, then a raw one", hdr("Authorization", "Bearer "+f.bearer.Token, "Dd-Api-Key", f.raw.Token), []Entry{f.bearer, f.raw}},
		{"a basic swap, then a raw one", hdr("Authorization", basicOf(f.user.Token, "pw"), "Dd-Api-Key", f.raw.Token), []Entry{f.user, f.raw}},
		{"a raw swap, then a basic one", hdr("Authorization", basicOf(f.user.Token, "pw"), "Dd-Api-Key", f.raw.Token), []Entry{f.raw, f.user}},
	} {
		for failing := 1; failing <= len(c.swaps); failing++ {
			h := c.h.Clone()
			h.Set("X-Keep", "1")
			before := h.Clone()
			calls := 0
			err := ApplySwaps(h, c.swaps, func(id string) ([]byte, error) {
				calls++
				if calls == failing {
					return nil, boom
				}
				return []byte(values[id]), nil
			})
			if !errors.Is(err, boom) {
				t.Fatalf("%s, value %d failing: err = %v", c.name, failing, err)
			}
			if !maps.EqualFunc(h, before, slices.Equal[[]string]) {
				t.Errorf("%s, value %d failing: the headers became %v; a failed swap must leave every header as it was", c.name, failing, h)
			}
		}
	}
}

func TestSwapsOnOneHeaderCompose(t *testing.T) {
	f := newFixture(t)
	values := map[string]string{"pay": "real-user-value", "git": "real-password-value"}
	value := func(id string) ([]byte, error) { return []byte(values[id]), nil }
	for _, order := range [][]Entry{{f.user, f.pass}, {f.pass, f.user}} {
		h := hdr("Authorization", basicOf(f.user.Token, f.pass.Token))
		if err := ApplySwaps(h, order, value); err != nil {
			t.Fatal(err)
		}
		if got, want := h.Values("Authorization"), []string{basicOf("real-user-value", "real-password-value")}; !slices.Equal(got, want) {
			t.Errorf("a user swap and a password swap on one header gave %q, want %q", got, want)
		}
	}
}

func TestABasicHeaderCarriesAtMostOneUserAndOnePasswordSecret(t *testing.T) {
	r := NewRegistry()
	const host = "basic.example.test"
	rec := func(id, format string) vault.Record {
		return vault.Record{ID: id, Kind: vault.KindHTTP, Hosts: []string{host}, Header: "Authorization", Format: format}
	}
	u := mint(t, r, "c1", binding(t, rec("user", "basic-user")))
	u2 := mint(t, r, "c1", binding(t, rec("user", "basic-user")))
	uOther := mint(t, r, "c1", binding(t, rec("user-other", "basic-user")))
	p := mint(t, r, "c1", binding(t, rec("pass", "basic-password")))
	p2 := mint(t, r, "c1", binding(t, rec("pass", "basic-password")))
	pOther := mint(t, r, "c1", binding(t, rec("pass-other", "basic-password")))
	pFar := mint(t, r, "c1", binding(t, vault.Record{ID: "pass-far", Kind: vault.KindHTTP, Hosts: []string{"far.example.test"}, Header: "Authorization", Format: "basic-password"}))
	pForeign := mint(t, r, "c2", binding(t, rec("pass", "basic-password")))
	d := https(host)

	h := hdr("Authorization", basicOf(u, p))
	v := at(t, r, d, "GET", "/", h)
	wantAllow(t, "a user and a password of two secrets", v, 2)
	values := map[string]string{"user": "real-user-value", "pass": "real-password-value"}
	if err := ApplySwaps(h, v.Swaps, func(id string) ([]byte, error) { return []byte(values[id]), nil }); err != nil {
		t.Fatal(err)
	}
	if got, want := h.Values("Authorization"), []string{basicOf("real-user-value", "real-password-value")}; !slices.Equal(got, want) {
		t.Errorf("the pair swapped to %q, want %q", got, want)
	}

	for _, c := range []struct{ name, user, pass string }{
		{"two user secrets, one in each half", u, uOther},
		{"two user secrets in the user half", u + uOther, ""},
		{"two password secrets, one in each half", pOther, p},
		{"two password secrets in the password half", "x", p + pOther},
		{"each in the other's half", p, u},
		{"the user in the password half", "x", u},
		{"the password in the user half", p, ""},
		{"the user half with extra text", u + "x", p},
		{"the user half after extra text", "x" + u, p},
		{"the password half with extra text", u, p + "x"},
		{"the password half after a space", u, " " + p},
		{"the password half before a colon", u, p + ":"},
		{"two surrogates of the user secret", u, u2},
		{"two surrogates of the password secret", p2, p},
		{"the password twice", u, p + p},
		{"a password bound to another host", u, pFar},
		{"another cell's password", u, pForeign},
	} {
		wantDeny(t, c.name, at(t, r, d, "GET", "/", hdr("Authorization", basicOf(c.user, c.pass))), ReasonMisplacedSurrogate)
	}
}
