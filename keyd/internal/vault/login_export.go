package vault

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Why a row of a password manager's export was left out. Reports name these and the row's line,
// never a cell: in a broken row any cell may be a password.
const (
	skipNotLogin    = "not-a-login"
	skipNoWebsite   = "no-website"
	skipNotHTTPS    = "not-https"
	skipNoPassword  = "no-password"
	skipBadPassword = "unusable-password"
	skipBadAccount  = "unusable-account"
	skipSameSite    = "same-site"
	skipUnreadable  = "unreadable"
	skipTooMany     = "too-many"
)

const (
	// A saved password is typed into the page, which the browser's input path bounds and checks.
	maxTypedPassword = 1000
	maxTypedAccount  = 2000
	maxExportRows    = 20000
	maxListedLines   = 20
)

// ErrNotLoginExport: the file has no columns for a website and a password.
var ErrNotLoginExport = errors.New("not a password export")

// LoginExport is what an export holds for keyd to keep, and which rows it left out.
type LoginExport struct {
	Rows    int
	Logins  []ExportedLogin
	Skipped map[string][]int
}

type ExportedLogin struct {
	Line   int
	Origin string
	Login  Login
}

// The headers of Chrome, Edge, 1Password, Apple Passwords, Bitwarden, Firefox and LastPass exports.
var (
	websiteColumns  = []string{"url", "login_uri", "website", "web site", "web address", "uri"}
	accountColumns  = []string{"username", "login_username", "user name", "login name", "user", "login", "email", "e-mail"}
	passwordColumns = []string{"password", "login_password"}
)

var exportHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$`)

// ParseLoginExport keeps a login's site, account and password from each row and nothing else: no
// names, notes, one-time secrets or folders. Logins it returns are marked to wait for the user's tap.
func ParseLoginExport(raw []byte) (LoginExport, error) {
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(raw) {
		return LoginExport{}, ErrNotLoginExport
	}
	reader := csv.NewReader(bytes.NewReader(raw))
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	header, err := reader.Read()
	if err != nil {
		return LoginExport{}, ErrNotLoginExport
	}
	website, account, password, kind := -1, -1, -1, -1
	names := make([]string, len(header))
	for at, name := range header {
		names[at] = strings.ToLower(strings.TrimSpace(name))
		if names[at] == "type" {
			kind = at
		}
	}
	website, account, password = column(names, websiteColumns), column(names, accountColumns), column(names, passwordColumns)
	if website < 0 || password < 0 {
		return LoginExport{}, ErrNotLoginExport
	}
	export := LoginExport{Skipped: map[string][]int{}}
	seen := map[string]bool{}
	skip := func(reason string, line int) { export.Skipped[reason] = append(export.Skipped[reason], line) }
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return export, nil
		}
		export.Rows++
		var malformed *csv.ParseError
		if errors.As(err, &malformed) {
			skip(skipUnreadable, malformed.Line)
			continue
		}
		if err != nil {
			return LoginExport{}, ErrNotLoginExport
		}
		line, _ := reader.FieldPos(0)
		if export.Rows > maxExportRows || len(export.Logins) >= MaxLogins {
			skip(skipTooMany, line)
			continue
		}
		cell := func(at int) string {
			if at < 0 || at >= len(record) {
				return ""
			}
			return record[at]
		}
		if value := strings.ToLower(strings.TrimSpace(cell(kind))); value != "" && value != "login" {
			skip(skipNotLogin, line)
			continue
		}
		origin, problem := exportOrigin(cell(website))
		if problem != "" {
			skip(problem, line)
			continue
		}
		secret := cell(password)
		if secret == "" {
			skip(skipNoPassword, line)
			continue
		}
		if !typable(secret, maxTypedPassword) {
			skip(skipBadPassword, line)
			continue
		}
		username := strings.TrimSpace(cell(account))
		if !typable(username, maxTypedAccount) {
			skip(skipBadAccount, line)
			continue
		}
		if seen[origin] {
			skip(skipSameSite, line)
			continue
		}
		seen[origin] = true
		login := Login{Username: strings.Clone(username), Password: strings.Clone(secret), Confirm: true}
		if _, err := encodeLogin(login); err != nil {
			skip(skipBadPassword, line)
			continue
		}
		export.Logins = append(export.Logins, ExportedLogin{Line: line, Origin: origin, Login: login})
	}
}

func column(names, wanted []string) int {
	for _, name := range wanted {
		for at, have := range names {
			if have == name {
				return at
			}
		}
	}
	return -1
}

// exportOrigin reads a cell as the HTTPS origin a login is bound to. A manager may keep a bare host,
// so one without a scheme counts as HTTPS. Apps' own addresses and plain HTTP are no such origin.
func exportOrigin(cell string) (string, string) {
	value := strings.TrimSpace(cell)
	if at := strings.IndexByte(value, ','); at >= 0 {
		value = strings.TrimSpace(value[:at])
	}
	if value == "" {
		return "", skipNoWebsite
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil {
		return "", skipNoWebsite
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		return "", skipNotHTTPS
	default:
		return "", skipNoWebsite
	}
	host := strings.ToLower(u.Hostname())
	if !exportHost.MatchString(host) || (!strings.Contains(host, ".") && net.ParseIP(host) == nil) {
		return "", skipNoWebsite
	}
	origin := "https://" + host
	if port := u.Port(); port != "" && port != "443" {
		origin += ":" + port
	}
	if _, _, err := loginIdentity(origin); err != nil {
		return "", skipNoWebsite
	}
	return origin, ""
}

// typable is what the browser's private input path takes: no control or format characters, within
// its limit in UTF-16 units.
func typable(value string, limit int) bool {
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return len(utf16.Encode([]rune(value))) <= limit
}

// TypableLogin says whether a login from Settings can be typed into a page as saved.
func TypableLogin(login Login) bool {
	return typable(login.Password, maxTypedPassword) && typable(login.Username, maxTypedAccount)
}

// Import keeps the exported logins whose site has none saved yet and writes the list once.
func (l *Logins) Import(logins []ExportedLogin) (saved int, already []int, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.loadLocked(); err != nil {
		return 0, nil, err
	}
	defer func() {
		if saved > 0 {
			err = errors.Join(err, l.saveListLocked())
		}
	}()
	for _, exported := range logins {
		if l.findLocked(exported.Origin) >= 0 {
			already = append(already, exported.Line)
			continue
		}
		id, binding, err := loginIdentity(exported.Origin)
		if err != nil {
			continue
		}
		if err := l.storeLocked(exported.Origin, id, binding, exported.Login); err != nil {
			return saved, already, err
		}
		saved++
	}
	return saved, already, nil
}

// ListedLines is at most the first lines a report names of a reason's rows.
func ListedLines(lines []int) []int {
	if len(lines) > maxListedLines {
		return lines[:maxListedLines]
	}
	return lines
}
