#!/bin/sh

deploy=https://github.com/hitzhangjie/debugger101.io
tmpdir=/tmp/debugger101.io
rm -rf $tmpdir

# If a command fails then the deploy stops
set -e

printf "\033[0;32mDeploying updates to GitHub...\033[0m\n"

# build the book
book="book.zh"

git clone $deploy $tmpdir

#docker run --name gitbook --rm \
#    -v ${PWD}:/root/gitbook \
#    -v $tmpdir:$tmpdir \
#    hitzhangjie/gitbook-cli:latest \
#    gitbook build $book tmpdir

gitbook build $book tmpdir
cp -r tmpdir/* $tmpdir/
rm -rf tmpdir

# go to publishdir and commit
cd $tmpdir

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

rm -rf $tmpdir
