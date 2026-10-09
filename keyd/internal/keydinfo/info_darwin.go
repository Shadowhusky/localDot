//go:build darwin && cgo

package keydinfo

/*
#define KEYD_INFO_PLIST \
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" \
  "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" \
  "<plist version=\"1.0\">\n" \
  "<dict>\n" \
  "  <key>CFBundleIdentifier</key><string>dev.localdot.keyd</string>\n" \
  "  <key>KeydGeneration</key><string>2</string>\n" \
  "</dict>\n" \
  "</plist>\n"

// codesign binds this section into the signature; the plist has no trailing NUL.
__attribute__((used, section("__TEXT,__info_plist")))
static const char keyd_info_plist[sizeof(KEYD_INFO_PLIST) - 1] = KEYD_INFO_PLIST;
*/
import "C"
