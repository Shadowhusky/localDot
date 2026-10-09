// Command keyd-native supervises the daemon's native tasks: native-run starts one verified
// sandbox command and owns its process group, native-lock takes the lease its recovery needs.
// It is signed apart from keyd under its own identifier, so nothing it starts passes the
// Keychain helper's parent check, and it has no Keychain access of its own.
package main

import (
	"os"

	"github.com/shadowhusky/localdot/keyd/internal/nativewatch"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) > 0 && args[0] == "native-run" {
		return nativewatch.Run(args[1:], os.NewFile(3, "native-control"), os.NewFile(4, "native-events"), os.Stdin, os.Stdout, os.Stderr, 5)
	}
	if len(args) > 0 && args[0] == "native-lock" {
		return nativewatch.RunResourceLock(args[1:], os.NewFile(3, "native-resource-lease"), os.Stdout)
	}
	return 2
}
