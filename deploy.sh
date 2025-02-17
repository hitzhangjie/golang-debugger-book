#!/bin/bash -e

# repository to fetch book content
deploy=https://github.com/hitzhangjie/debugger101.io

# build the book for Chinese version
book="book.zh"

# create a temporary folder and be sure to delete them when exit
tmpdir=$(mktemp -d)
trap 'sudo rm -rf "$tmpdir"' EXIT
builddir=$(mktemp -d)
trap 'sudo rm -rf "$builddir"' EXIT

# build the book and publish to github
printf "\033[0;32mDeploying updates to GitHub...\033[0m\n"

git clone --depth 1 $deploy $tmpdir

# deploy by `gitbook-cli` image
docker run --name gitbook --rm      \
    -v ${PWD}:/root/gitbook         \
    -v $builddir:$builddir          \
    hitzhangjie/gitbook-cli:latest  \
    bash -c "cd $book && gitbook install && cd - && gitbook build $book $builddir"

# deploy by installed `gitbook-cli`
#gitbook build $book $builddir

# go to publishdir and commit
cp -rf $builddir/* $tmpdir/

# Commit changes.
cd $tmpdir
git add .
msg="rebuilding site $(date)"
if [ -n "$*" ]; then
        msg="$*"
fi
git commit -m "$msg"

# Push source and build repos.
git push -f -u origin master
cd -

