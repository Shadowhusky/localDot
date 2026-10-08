# Offline signature fixture

`bundle.json` is the public SLSA v1 attestation for `sigstore@5.0.0`, retrieved from
https://registry.npmjs.org/-/npm/v1/attestations/sigstore@5.0.0 on October 7, 2026.
It was retained as a pretty-printed, otherwise unchanged JSON bundle. Its signer is
`https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main`.

`trusted-root.json` is the public Sigstore trust material from the installed npm copy of
`@sigstore/tuf`'s `seeds.json`, decoded from its production-mirror target. This is a test-only
snapshot, not production TUF refresh evidence or permission to trust an artifact-supplied root.
The public trust data is distributed by the Sigstore project under Apache-2.0.

The test pins both file hashes, uses actual Sigstore cryptography without network access, and
mutates the signed content, certificate, transparency records and identity policy. It verifies
the retained attestation, not the npm archive's contents or a localDot release. The same valid
foreign signature must fail localDot's compiled release policy. No fixture is a signing credential.
