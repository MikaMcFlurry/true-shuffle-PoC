# Line endings

Text files are stored and checked out with LF line endings on every platform.
The repository-level `.gitattributes` sets `* text=auto eol=lf`, which takes
precedence over a local or system `core.autocrlf` setting. This matters on
Windows, where Git for Windows defaults to `core.autocrlf=true`: without the
rule, a fresh checkout turns every source file into CRLF and `npm run lint`
(Biome) reports a formatting error for each of them.

Exceptions:

- `*.cmd` and `*.bat` are checked out with CRLF so `cmd.exe` reads them reliably.
- `*.png` is always binary. Other binary files are detected automatically.

A few historical evidence files under `docs/ai-dev/evidence/` were committed with
CRLF. The rule does not rewrite them; they keep their committed bytes.

No global Git configuration is needed. An existing clone that was checked out
before this rule existed can refresh its working tree with:

```sh
git rm --cached -r -q .
git reset --hard
```

Both commands discard uncommitted changes, so commit or stash first.
