# Robot Console local Tauri patch

Baseline: crates.io `tauri` 2.11.5, upstream commit
`7cd71369c00978a3783b6ae3e9972358abbe4ae6`, `crates/tauri`.
Registry Cargo.toml and both upstream licenses are retained. Issue: #260.

`Webview::reparent` commits parent metadata only after runtime success. Updating
it first can associate a live page with a closed target; a delayed Destroyed
event then unregisters the page and all subsequent IPC fails, even though its
picture and JS heap remain visible. The runtime patch alone cannot fix this.

The mock runtime rejects a destroyed target. The application regression test
checks the actual WebView list used by manager cleanup: the failed target must
have no page to unregister. It verifies the original page registration survives,
then reparents again successfully. `npm run test:rust` runs that test. Native
fault injection in the isolated debug app also exercises a closed target and a
subsequent migration, so a visible screenshot alone is never a success criterion.

Remove alongside the runtime patch only when an upstream release incorporates
equivalent fixes and passes the native migration tests. The user's Cargo cache
is not modified.
