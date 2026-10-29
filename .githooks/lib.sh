#!/usr/bin/env bash
# Shared part of the git hooks. Enabled automatically on every `npm install`
# (package.json `prepare`), or manually with `npm run setup-hooks`
# (= git config core.hooksPath .githooks). Emergency bypass: `git commit --no-verify`.

# Node >= 22 is required (for the `npm test` glob); the agent shell / nvm default node
# may be older, so /usr/bin/node is the first candidate.
pick_node() {
    local cand major
    for cand in /usr/bin/node "$(command -v node 2>/dev/null)" "$HOME/.local/share/launchers-launcher/node/bin/node"; do
        [ -n "$cand" ] && [ -x "$cand" ] || continue
        major=$("$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
        if [ "$major" -ge 22 ]; then
            printf '%s\n' "$cand"
            return 0
        fi
    done
    return 1
}

run_tests() {
    local node
    if ! node=$(pick_node); then
        echo "[hook] no Node >= 22 — the tests are skipped" >&2
        return 0
    fi
    "$node" --test --require ./test/helpers/setup.js "$@"
}
