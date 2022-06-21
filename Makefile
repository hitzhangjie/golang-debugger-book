chineseWordsCnt := $(shell find book.zh -iname "*.md" -print0 | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)
englishWordsCnt := $(shell find book.en -iname "*.md" -print0 | grep -z -v zh_CN | grep -z -v _book | grep -z -v node_modules |  wc -m --files0-from - | tail -n 1 | cut -f1)

deploy := https://github.com/hitzhangjie/debugger101.io
tmpdir := /tmp/debugger101.io
book := book.zh

.PHONY: english chinese stat clean deploy

PWD := $(shell pwd -P)

english:
	rm -rf book.en/_book
	#gitbook install book.en
	#gitbook serve book.en
#	docker run --name gitbook --rm -v ${PWD}/book.en:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
	docker run --name gitbook --rm -v ${PWD}/book.en:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .


chinese:
	rm -rf book.zh/_book
	#gitbook install book.zh
	#gitbook serve book.zh
	docker run --name gitbook --rm -v ${PWD}/book.zh:/root/gitbook hitzhangjie/gitbook-cli:latest gitbook install .
	docker run --name gitbook --rm -v ${PWD}/book.zh:/root/gitbook -p 4000:4000 -p 35729:35729 hitzhangjie/gitbook-cli:latest gitbook serve .


stat:
	@echo "Chinese version, words: ${chineseWordsCnt}"
	@echo "English version, words: ${englishWordsCnt}"

clean:
	rm -rf book.zh/_book
	rm -rf book.en/_book
	#rm -rf ./node_modules

deploy:
	# ./deploy.sh
	rm -rf ${tmpdir}
	echo "deploying updates to GitHub..."
	git clone ${deploy} ${tmpdir}
	docker run --name gitbook --rm -v ${PWD}:/root/gitbook -v ${tmpdir}:${tmpdir} hitzhangjie/gitbook-cli:latest gitbook build ${book} tmpdir
	cp -r tmpdir/* ${tmpdir}/
	rm -rf tmpdir
	cd ${tmpdir}
	git add .
	git commit -m "rebuilding site"
	git push -f -u origin master
	rm -rf ${tmpdir}

