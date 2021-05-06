chineseWordsCnt := $(shell find book.zh -iname "*.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
englishWordsCnt := $(shell find book.en -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

.PHONY: english chinese stat clean

english:
	rm book.en/_book
	gitbook install book.en
	gitbook serve book.en

chinese:
	rm book.zh/_book
	gitbook install book.zh
	gitbook serve book.zh

stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
	@echo "English version, words: ${englishWordsCnt}"

clean:
	rm -rf book.zh/_book
	rm -rf book.en/_book
	#rm -rf ./node_modules

