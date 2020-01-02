chineseWordsCnt := $(shell find -iname "*zh_CN.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
englishWordsCnt := $(shell find -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

PHONY: init

.PHONY: english
.PHONY: chinese
.PHONY: stat

.PHONY: clean

init:
	gitbook install

english:
	rm -rf ./_book
	ln -sf ./1-introduction.md ./README.md
	ln -sf ./SUMMARY.en_US.md ./SUMMARY.md
	gitbook serve

chinese:
	rm -rf ./_book
	ln -sf ./1-introduction.zh_CN.md ./README.md
	ln -sf ./SUMMARY.zh_CN.md ./SUMMARY.md
	gitbook serve

stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
	@echo "English version, words: ${englishWordsCnt}"

clean:
	rm -rf _book
	#rm -rf ./node_modules
	rm -f ./README.md
	rm -f ./SUMMARY.md


