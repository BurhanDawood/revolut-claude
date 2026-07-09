#!/usr/bin/env bash
cd ~/revolut-claude || exit 1
# self-heal any stale git locks (match PUSH_NOW.bat behaviour)
[ -f .git/HEAD.lock ] && rm -f .git/HEAD.lock
[ -f .git/index.lock ] && rm -f .git/index.lock

# #235: stash any uncommitted edit-script changes BEFORE pulling. Previously
# the pull ran directly against whatever the edit script had already written,
# so a stale local checkout made git refuse to fast-forward ("local changes
# would be overwritten by merge") instead of pulling cleanly. Only pop if we
# actually stashed something — git stash is a safe no-op on a clean tree.
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  git stash push -m "push.sh auto-stash before pull" || { echo "STASH FAILED — resolve before pushing"; exit 1; }
  STASHED=1
fi

git pull origin main --no-edit || {
  echo "PULL FAILED — resolve before pushing"
  [ "$STASHED" = "1" ] && git stash pop
  exit 1
}

if [ "$STASHED" = "1" ]; then
  git stash pop || { echo "STASH POP CONFLICT — resolve manually (git status), then re-run push.sh"; exit 1; }
fi

git add -A
git commit -m "fix: incremental ship" || echo "(nothing to commit)"
git push origin main
echo "Done."
