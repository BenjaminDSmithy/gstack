#!/bin/bash
# heal-eol.sh — rewrite LF-pinned bash scripts that an older CRLF checkout left CRLF.
#
# Why: .gitattributes pins every bash script (and the hook shims) to LF, and the
# hook parse gate in ./setup refuses a CRLF bash file, because bash keeps the \r
# on every line at run time. An install checked out on Windows with
# core.autocrlf=true BEFORE those rules existed still holds CRLF working copies,
# and `git pull` never rewrites a file whose blob did not change. Without this,
# such an install would be refused by its own next ./setup after upgrading.
#
# What it touches, and only that: a tracked file whose index copy is LF, whose
# attribute says eol=lf, whose working copy is CRLF, whose first line is a
# bash/sh shebang (the files the gate would refuse — a handful, not the tree),
# that is not flagged assume-unchanged or skip-worktree (`git diff` cannot see
# edits behind either flag), and that carries no content change
# (`git diff --quiet`, which compares after normalisation).
#
# How: the bytes a fresh checkout would write come from
# `git cat-file --filters`, go to a temp file beside the original (carrying its
# mode), and replace it with one `mv`. Nothing is deleted first, no
# checkout runs, no hook fires, and a failure leaves the original exactly as it
# was and says so. Best effort: no git, not a work tree, or nothing to heal is
# a silent exit 0; the hook parse gate still judges the tree afterwards.
# Usage: heal-eol.sh <repo-root>
#
# POSIXLY_CORRECT or POSIX_PEDANTIC, or `posix` in an exported SHELLOPTS,
# starts bash in POSIX mode, where bash 3.2 rejects the process substitution
# that feeds the loop below: the heal died on a syntax error, setup carried
# on, and the gate then refused the CRLF copy this script exists to rewrite.
# Turning the mode off covers all three for this script's own parse; unlike
# the gate, it parses no other file.
set +o posix
set -u
root="${1:-}"
if [ -z "$root" ]; then
  printf 'usage: heal-eol.sh <repo-root>\n' >&2
  exit 2
fi
command -v git >/dev/null 2>&1 || exit 0
git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
# `ls-files` names paths relative to $root, but an index path (`:0:<path>`)
# and `--path` are read from the top of the work tree. They differ when gstack
# sits in a subdirectory of another repository (a vendored install): without
# the prefix, a same-named file at the project's top would be written over
# gstack's, or the lookup would fail and the CRLF copy would stay.
prefix=$(git -C "$root" rev-parse --show-prefix 2>/dev/null) || exit 0
# Paths come from git and go back to git: never let one widen into a glob.
export GIT_LITERAL_PATHSPECS=1
# Byte-wise matching: under a UTF-8 locale bash 3.2 collates [a-z] over
# uppercase letters too, which would read every ordinary `H` tag as flagged.
export LC_ALL=C

healed=0
tmp=''
# An interrupted rewrite must not leave a temp copy behind: the gate would
# sweep it as one more bash script.
trap 'rm -f "$tmp"' EXIT
trap 'rm -f "$tmp"; exit 130' INT TERM
while IFS= read -r -d '' entry; do
  # `<index eol> <worktree eol> <attr>\t<path>`
  info=${entry%%$'\t'*}
  path=${entry#*$'\t'}
  case "$info" in
    *i/lf*w/crlf*eol=lf*) ;;
    *) continue ;;
  esac
  file="$root/$path"
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  first=''
  IFS= read -r first < "$file" 2>/dev/null || true
  first=${first%$'\r'}
  case "$first" in
    '#!/bin/bash'* | '#!/usr/bin/env bash'* | '#!/bin/sh'* | '#!/usr/bin/env sh'*) ;;
    *) continue ;;
  esac
  # A lowercase tag is assume-unchanged, `S` is skip-worktree. Spelled out
  # rather than as a range, so no locale can widen it.
  tag=$(git -C "$root" ls-files -v -- "$path" 2>/dev/null)
  case "${tag%% *}" in
    [abcdefghijklmnopqrstuvwxyz] | S) continue ;;
  esac
  git -C "$root" diff --quiet -- "$path" 2>/dev/null || continue
  tmp="$file.heal-eol.$$"
  # The temp copy starts as `cp -p` of the original, so it has the original's
  # mode; the redirect then rewrites its bytes and keeps that mode. A new file
  # would get setup's `umask 077` instead, and a healed 0755 script would come
  # out 0700, unreadable to every other user of a shared install. A read-only
  # original copies as read-only, so the owner-write bit is lifted for the
  # rewrite and put back before the swap.
  ro=0
  if cp -p "$file" "$tmp" 2>/dev/null; then
    if [ ! -w "$tmp" ]; then
      ro=1
      chmod u+w "$tmp" 2>/dev/null
    fi
    if git -C "$root" cat-file --filters --path="$prefix$path" ":0:$prefix$path" > "$tmp" 2>/dev/null && [ -s "$tmp" ] &&
      { [ "$ro" -eq 0 ] || chmod u-w "$tmp"; } && mv -f "$tmp" "$file"; then
      printf 'heal-eol: rewrote %s with LF line endings\n' "$path" >&2
      healed=$((healed + 1))
      continue
    fi
  fi
  rm -f "$tmp"
  printf 'heal-eol: could not rewrite %s; left it as it was\n' "$path" >&2
done < <(git -C "$root" ls-files --eol -z 2>/dev/null)

# The rewritten files now match the index; refresh its stat data so git does
# not report them as modified. Best effort: a held index.lock only delays that.
[ "$healed" -gt 0 ] && git -C "$root" update-index -q --refresh >/dev/null 2>&1
exit 0
