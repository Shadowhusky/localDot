package vault

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestParseLoginExportReadsEachManagersColumns(t *testing.T) {
	for name, file := range map[string]string{
		"Chrome":    "name,url,username,password,note\nGitHub,https://github.com/login,octo@example.com,fixture-pass,a note\n",
		"1Password": "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nGitHub,https://github.com/login,octo@example.com,fixture-pass,otpauth://totp/x,false,false,,a note\n",
		"Bitwarden": "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,a note,,0,https://github.com/login,octo@example.com,fixture-pass,JBSWY3DP\n",
		"Apple":     "Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com/login,octo@example.com,fixture-pass,a note,otpauth://totp/x\n",
		"BOM, CRLF": "\xef\xbb\xbfname,url,username,password\r\nGitHub,https://github.com/login,octo@example.com,fixture-pass\r\n",
	} {
		export, err := ParseLoginExport([]byte(file))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if export.Rows != 1 || len(export.Logins) != 1 || len(export.Skipped) != 0 {
			t.Fatalf("%s: %+v", name, export)
		}
		got := export.Logins[0]
		if got.Origin != "https://github.com" || got.Login != (Login{Username: "octo@example.com", Password: "fixture-pass", Confirm: true}) {
			t.Fatalf("%s: %+v", name, got)
		}
	}
}

func TestParseLoginExportKeepsPasswordsExactly(t *testing.T) {
	export, err := ParseLoginExport([]byte("url,username,password\nexample.com,a,\" pa,ss \"\"wörd\"\" 密碼 \"\n"))
	if err != nil || len(export.Logins) != 1 {
		t.Fatalf("%+v, %v", export, err)
	}
	if got := export.Logins[0]; got.Origin != "https://example.com" || got.Login.Password != ` pa,ss "wörd" 密碼 ` {
		t.Fatalf("%+v", got)
	}
}

func TestParseLoginExportSaysWhyARowIsLeftOut(t *testing.T) {
	file := strings.Join([]string{
		"type,url,username,password",
		"login,https://ok.example.com,a,p",
		"card,https://card.example.com,a,p",
		"login,,a,p",
		"login,androidapp://com.example,a,p",
		"login,http://plain.example.com,a,p",
		"login,https://nopass.example.com,a,",
		"login,https://ok.example.com,other,p",
		"login,https://user:pass@creds.example.com,a,p",
		"login,https://ctl.example.com,a,p\x07p",
		"login,https://wide.example.com,a," + strings.Repeat("x", 1001),
		"login,https://accountctl.example.com,a\x07,p",
		`login,https://broken.example.com,a,"p`,
	}, "\n") + "\n"
	export, err := ParseLoginExport([]byte(file))
	if err != nil {
		t.Fatal(err)
	}
	if len(export.Logins) != 1 || export.Logins[0].Origin != "https://ok.example.com" {
		t.Fatalf("kept %+v", export.Logins)
	}
	want := map[string][]int{
		skipNotLogin:    {3},
		skipNoWebsite:   {4, 5, 9},
		skipNotHTTPS:    {6},
		skipNoPassword:  {7},
		skipSameSite:    {8},
		skipBadPassword: {10, 11},
		skipBadAccount:  {12},
		skipUnreadable:  {13},
	}
	for reason, lines := range want {
		if !slices.Equal(export.Skipped[reason], lines) {
			t.Fatalf("%s: lines %v, want %v (all %v)", reason, export.Skipped[reason], lines, export.Skipped)
		}
	}
}

func TestParseLoginExportNormalisesTheOrigin(t *testing.T) {
	for cell, want := range map[string]string{
		"https://GitHub.com/login?next=/x": "https://github.com",
		"github.com":                       "https://github.com",
		"https://example.com:443/":         "https://example.com",
		"https://example.com:8443/a":       "https://example.com:8443",
		"https://a.example.com,https://b":  "https://a.example.com",
		"https://www.example.com":          "https://www.example.com",
	} {
		if got, problem := exportOrigin(cell); got != want || problem != "" {
			t.Fatalf("%s: got %q, %q", cell, got, problem)
		}
	}
	for _, cell := range []string{"not a site", "https://exämple.com", "https://localhost", "javascript:alert(1)", "otpauth://totp/x"} {
		if got, problem := exportOrigin(cell); got != "" || problem == "" {
			t.Fatalf("%s: took %q", cell, got)
		}
	}
}

func TestParseLoginExportRefusesOtherFiles(t *testing.T) {
	for _, file := range []string{"", "\xff\xfe", "a,b,c\n1,2,3\n", "name,url\nx,https://a.example\n", "url,username\nhttps://a.example,u\n"} {
		if _, err := ParseLoginExport([]byte(file)); err == nil {
			t.Fatalf("took %q", file)
		}
	}
}

func TestParseLoginExportStopsAtTheLimit(t *testing.T) {
	var file strings.Builder
	file.WriteString("url,password\n")
	for i := range MaxLogins + 3 {
		fmt.Fprintf(&file, "https://s%d.example.com,p\n", i)
	}
	export, err := ParseLoginExport([]byte(file.String()))
	if err != nil || len(export.Logins) != MaxLogins || len(export.Skipped[skipTooMany]) != 3 {
		t.Fatalf("kept %d, skipped %v, %v", len(export.Logins), len(export.Skipped[skipTooMany]), err)
	}
}
