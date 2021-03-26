#!/bin/sh

deploy=https://github.com/hitzhangjie/debugger101.io
tmpdir=debugger101.io

# If a command fails then the deploy stops
set -e

printf "\033[0;32mDeploying updates to GitHub...\033[0m\n"

# build the book
cd book
rm -rf ./_book
ln -sf ./1-introduction.zh_CN.md ./README.md
ln -sf ./SUMMARY.zh_CN.md ./SUMMARY.md
cd -

gitbook build book $tmpdir

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
