# Pushing this repository to GitHub

This repository is published at **<https://github.com/khalegh2131/chain-event-indexer>**
(branch `main`, one commit, 91 files). The steps in this document are the ones used
to publish it and the routine to follow for future changes.

## 1. Review before pushing

```bash
git log --oneline
git status --short          # should be clean
git ls-files | wc -l        # tracked file count

# Make sure no secret slipped in
git ls-files | grep -E '(^|/)\.env$|config/config\.json$'   # must print nothing
grep -rIn --exclude-dir=node_modules --exclude-dir=.git -E 'PRIVATE KEY|ALCHEMY_|mnemonic' . | head
```

Checklist:

- [ ] `config/config.json` is not tracked (only `config/config.example.json`).
- [ ] `.env` is not tracked (only `.env.example`).
- [ ] `node_modules/`, `dist/`, `coverage/` are not tracked.
- [x] `package.json` `author` is set to `Khaleq Salehi <khaleq.sa@gmail.com>`.
- [x] `LICENSE` copyright line names Khaleq Salehi.
- [x] Commit author/committer is `Khaleq Salehi <khaleq.sa@gmail.com>`.
- [x] No placeholder author or bot account remains anywhere in the tree.

## 2. Create the remote

```bash
# Public or private, your choice. No secrets are in the tree, so either is fine.
gh repo create chain-event-indexer --private --source=. --remote=origin
# or create it in the web UI and then:
git remote add origin git@github.com:khalegh2131/chain-event-indexer.git
```

## 3. Authenticate

```bash
# HTTPS (personal access token with `repo` scope) or SSH
gh auth login
# or
ssh -T git@github.com
```

Never put a token in a commit, in `.env`, or in the remote URL.

## 4. Push

```bash
git branch -M main          # if the branch is not called main yet
git push -u origin main
```

## 5. Verify CI

After the push:

1. Open the repository's **Actions** tab.
2. The `CI` workflow (`.github/workflows/ci.yml`) should run and pass:
   `npm ci` → lint → typecheck → unit tests → integration tests (with a
   PostgreSQL service container) → build → `docker build` → compose validation.
3. If a step fails, reproduce it locally:

```bash
bash scripts/check.sh
docker compose -f docker-compose.test.yml config -q
CONFIG_FILE=config/config.example.json docker compose config -q
```

## 6. Recommended repository settings

| Setting | Value |
| --- | --- |
| Default branch | `main` |
| Branch protection | Require the `CI / Lint, typecheck, tests, build` check before merging |
| Secrets | `ETH_RPC_URL` (and any provider keys) only if you add a deployment workflow |
| Topics | `evm`, `indexer`, `ethereum`, `viem`, `fastify`, `postgresql` |
| Releases | Tag `v0.1.0` once CI is green: `git tag -a v0.1.0 -m "0.1.0" && git push origin v0.1.0` |

## 6.1 Uploading from another machine (offline transfer)

If the machine that produced this repository cannot authenticate to GitHub, a git
bundle carries the complete history in a single file:

```bash
# On the producing machine
git bundle create chain-event-indexer.bundle --all
git bundle verify chain-event-indexer.bundle

# Copy the bundle anywhere, then on a machine with GitHub access:
git clone chain-event-indexer.bundle chain-event-indexer
cd chain-event-indexer
git remote remove origin
git remote add origin git@github.com:khalegh2131/chain-event-indexer.git
git push -u origin main
```

The bundle contains every commit and ref, so the clone is identical to the
original (`git log --oneline` and `git ls-files | wc -l` match).

> Note on line endings: `.gitattributes` forces `eol=lf` for the whole repository.
> Without it, a Windows checkout with `core.autocrlf=true` would rewrite
> `docker-entrypoint.sh` with CRLF and the container entrypoint would fail with
> `#!/bin/sh\r: not found`.

## 7. If you fork this instead

```bash
git remote add upstream <original-url>
git fetch upstream
git rebase upstream/main
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `remote origin already exists` | `git remote set-url origin <url>` |
| `Permission denied (publickey)` | Run `ssh -T git@github.com`, add the key to your account |
| `Support for password authentication was removed` | Use a personal access token as the password, or switch to SSH |
| Push rejected (non-fast-forward) | `git pull --rebase origin main` then push again |
| CI fails only on Linux | Check filename casing: this repository must keep `Dockerfile`, `Makefile`, `README.md`, `CHANGELOG.md`, `LICENSE` and `tests/integration/globalSetup.ts` in exactly that case |
