// Package keydinfo gives the executable that imports it keyd's Info.plist. keyd is signed with a
// designated requirement that asks for the plist's KeydGeneration (vault.DesignatedRequirement), so
// a keyd from an earlier generation, which lacks it, cannot pass as keyd: neither to the Keychain
// helper nor to the access list of an item keyd stores.
package keydinfo
