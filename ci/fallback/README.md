# Public synthetic Linux verification runner

This control tree cannot deploy. Root install/build/deploy deliberately exit1,
and root Wrangler has no executable entrypoint. The actual product is checked
out separately at47e32be6a72ba03d582e5a944520e2f1ee0c5ea2, whose1005 source
files match e3446e730abfc6a48367b3ddcbd234b1bff164a9229a76615bc81bc1586b971b.

This reduced public runner contains only source hash manifests, synthetic test
code and the expected names/counts of the old negative control. No prior raw
review reports/logs, Windows artifact ZIPs/source overlays, credentials,
original listening exports or desktop paths are included. Original private
evidence and packages remain local and immutable.

Linux CI builds both UI profiles, dry-runs their Workers and executes the
Linux-built packages with no_bundle=true in local Workerd/Chromium/FakeSpotify.
It does not claim to run the original Windows-produced ZIP under Linux.
The original control is only accepted as3PASS/2FAIL at the original two named
expectations; raw actual exit1 is retained in the new CI evidence. Assertions
in copied synthetic probes are preserved; only platform paths and process
group cleanup are adapted and their diffs recorded.
