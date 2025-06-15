chineseWordsCnt := $(shell find book -iname "*.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
#englishWordsCnt := $(shell find book.en -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

deploy := https://github.com/hitzhangjie/debugger101.io
tmpdir := /tmp/debugger101.io
book := book

.PHONY: english chinese stat clean deploy

PWD := $(shell pwd -P)

# english:
# 	rm -rf book.en/_book
# 	#gitbook install book.en
# 	#gitbook serve book.en
# 	docker run --name gitbook --rm -v ${PWD}/book.en:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
# 	docker run --name gitbook --rm -v ${PWD}/book.en:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .

chinese:
	rm -rf book/_book
#	#gitbook install book
#	#gitbook serve book
	docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
	docker run --name gitbook --rm -v ${PWD}/book:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .

# pdfchinese:
# 	@echo "Warn: must do it mannually so far for lack of proper docker image,"
# 	@echo "- install 'calibre' first (see https://calibre-ebook.com/download),"
# 	@echo "- make sure 'ebook-convert' could be found in envvar 'PATH',"
# 	@echo "  take macOS for example:"
# 	@echo "  run 'sudo ln -s /Applications/calibre.app/Contents/MacOS/ebook-convert /usr/bin'."
# 	@echo "- run 'gitbook pdf <book> <book.pdf>'"
# 	@echo ""

stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
#	@echo "English version, words: ${englishWordsCnt}"

clean:
	rm -rf book/_book
#	#rm -rf book.en/_book
#	#rm -rf ./node_modules

deploy:
	./deploy.sh