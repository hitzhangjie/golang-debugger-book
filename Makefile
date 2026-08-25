chineseWordsCnt := $(shell find book -iname "*.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
#englishWordsCnt := $(shell find book.en -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

deploy := https://github.com/hitzhangjie/debugger101.io
tmpdir := /tmp/debugger101.io
book := book

.PHONY: english chinese .ensure-gitbook stat clean deploy

PWD := $(shell pwd -P)

# leading dot: hidden from `make <tab>` completion
.ensure-gitbook:
	@if ! which gitbook >/dev/null 2>&1; then \
		echo "gitbook not found, installing github.com/hitzhangjie/gitbook..."; \
		go install github.com/hitzhangjie/gitbook@latest; \
	fi

chinese: .ensure-gitbook
	rm -rf book/_book
	gitbook serve book
# docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
# docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .

stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
#	@echo "English version, words: ${englishWordsCnt}"

# pdfchinese:
# 	@echo "Warn: must do it mannually so far for lack of proper docker image,"
# 	@echo "- install 'calibre' first (see https://calibre-ebook.com/download),"
# 	@echo "- make sure 'ebook-convert' could be found in envvar 'PATH',"
# 	@echo "  take macOS for example:"
# 	@echo "  run 'sudo ln -s /Applications/calibre.app/Contents/MacOS/ebook-convert /usr/bin'."
# 	@echo "- run 'gitbook pdf <book> <book.pdf>'"
# 	@echo ""

clean:
	rm -rf book/_book
#	#rm -rf book.en/_book
#	#rm -rf ./node_modules
