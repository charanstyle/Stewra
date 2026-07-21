// Stand-in for ws's optional native accelerators (bufferutil / utf-8-validate) in the bundled binary.
// A single-executable app can't require() modules from disk, so we bundle this stub in their place.
// It throws on load exactly like an uninstalled optional dependency, which is the signal ws's
// buffer-util / validation code catches to fall back to its pure-JS implementation.
throw new Error('native addon not bundled — using pure-JS fallback');
