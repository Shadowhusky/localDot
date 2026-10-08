// debug's optional terminal-colour probe must not load an ambient, unpinned package.
// Verification workers have no interactive output; level zero preserves plain diagnostics.
module.exports = { level: 0 };
