#!/bin/sh

deploy=https://github.com/hitzhangjie/debugger101.io
tmpdir=debugger101.io

# If a command fails then the deploy stops
set -e

printf "\033[0;32mDeploying updates to GitHub...\033[0m\n"

# build the book
book="book.zh"

gitbook build $book $tmpdir

# Go To Public folder
cd $tmpdir

# Add changes to git.
git add .

# Commit changes.
msg="rebuilding site $(date)"
if [ -n "$*" ]; then
        msg="$*"
fi
git commit -m "$msg"

# Push source and build repos.
git push -f -u origin master

cd -
