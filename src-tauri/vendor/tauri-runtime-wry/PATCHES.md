# Robot Console local runtime patch

Baseline: crates.io `tauri-runtime-wry` 2.11.4, Tauri commit
`ca90b46b2e2cbbc981dae1b809f4af4343fe0558`, `crates/tauri-runtime-wry`.
The normalized registry Cargo.toml is retained so this copy builds without the
upstream workspace. MIT and Apache-2.0 licenses are included unchanged.

Issue: phamstered/rebotarm-debug-desk#260.

- Reparent retains source ownership until native reparent succeeds; missing or
  closed target/source produces an error response and never drops the WebView.
- Same-parent repair is a no-op, allowing the application to repair Tauri's
  eager parent metadata after a rejected move.
- The destination is marked as a child-WebView window. macOS inner-size queries
  then use the native window size instead of the incoming WebView's old bounds.
- Reparent copies the source routing ID and releases its mutex before posting
  the GUI request or waiting for its reply. The GUI commits the new routing ID
  after native success, before acknowledging. This prevents startup deadlock
  when a worker restores a page while the GUI emits workspace readiness events.
- A vanished response receiver does not panic the GUI thread; a vanished sender
  produces a runtime error instead of panicking the caller.

`src/reparent.rs` contains the actual registry transaction used by the runtime;
its tests cover failed/missing/same-parent requests, retained page payload and
exactly-once drop/transfer. A routing-lock regression also proves GUI event
reads remain possible while relocation is pending, with failure retaining the
old parent. `npm run test:rust` runs these dependency tests too.
Application-level bounds/visibility recovery is tested separately. Native fatal
process termination cannot be rolled back and is not claimed to be recoverable.

Keep this patch pinned until an upstream release has equivalent fixes and passes
the native migration/error-injection checks. Do not patch the user's Cargo cache.
