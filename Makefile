chineseWordsCnt := $(shell find book.zh -iname "*.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
englishWordsCnt := $(shell find book.en -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

.PHONY: english chinese stat clean

PWD := $(shell pwd -P)

english:
	rm book.en/_book
	gitbook install book.en
	gitbook serve book.en

chinese:
	rm book.zh/_book
	#gitbook install book.zh
	#gitbook serve book.zh
	docker run --rm -v ${PWD}/book.zh:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
	docker run --rm -v ${PWD}/book.zh:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .


stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
	@echo "English version, words: ${englishWordsCnt}"

clean:
	rm -rf book.zh/_book
	rm -rf book.en/_book
	#rm -rf ./node_modules

