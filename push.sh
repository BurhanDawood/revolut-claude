#!/usr/bin/env bash
cd ~/revolut-claude || exit 1
# self-heal any stale git locks (match PUSH_NOW.bat behaviour)
[ -f .git/HEAD.lock ] && rm -f .git/HEAD.lock
[ -f .git/index.lock ] && rm -f .git/index.lock
# pull-first so a push never rejects when the PC pushed in between
git pull origin main --no-edit || { echo "PULL FAILED — resolve before pushing"; exit 1; }
git add -A
git commit -m "fix: incremental ship" || echo "(nothing to commit)"
git push origin main
echo "Done."
