-include config.mk

BUILDTYPE ?= Release
PYTHON ?= python
DESTDIR ?=
SIGN ?=

# Default to verbose builds.
# To do quiet/pretty builds, run `make V=` to set V to an empty string,
# or set the V environment variable to an empty string.
V ?= 1

# BUILDTYPE=Debug builds both release and debug builds. If you want to compile
# just the debug build, run `make -C out BUILDTYPE=Debug` instead.
ifeq ($(BUILDTYPE),Release)
all: out/Makefile node
else
all: out/Makefile node node_g
endif

# The .PHONY is needed to ensure that we recursively use the out/Makefile
# to check for changes.
.PHONY: node node_g

node: config.gypi out/Makefile
	$(MAKE) -C out BUILDTYPE=Release V=$(V)
	ln -fs out/Release/node node

node_g: config.gypi out/Makefile
	$(MAKE) -C out BUILDTYPE=Debug V=$(V)
	ln -fs out/Debug/node node_g

config.gypi: configure
	./configure

out/Debug/node:
	$(MAKE) -C out BUILDTYPE=Debug V=$(V)

out/Makefile: common.gypi deps/uv/uv.gyp deps/http_parser/http_parser.gyp deps/zlib/zlib.gyp deps/v8/build/common.gypi deps/v8/tools/gyp/v8.gyp node.gyp config.gypi
	$(PYTHON) tools/gyp_node -f make

install: all
	$(PYTHON) tools/install.py $@ $(DESTDIR)

uninstall:
	$(PYTHON) tools/install.py $@ $(DESTDIR)

clean:
	-rm -rf out/Makefile node node_g out/$(BUILDTYPE)/node blog.html email.md
	-find out/ -name '*.o' -o -name '*.a' | xargs rm -rf
	-rm -rf node_modules

distclean:
	-rm -rf out
	-rm -f config.gypi
	-rm -f config.mk
	-rm -rf node node_g blog.html email.md
	-rm -rf node_modules

test: all
	$(PYTHON) tools/test.py --mode=release simple message
	PYTHONPATH=tools/closure_linter/ $(PYTHON) tools/closure_linter/closure_linter/gjslint.py --unix_mode --strict --nojsdoc -r lib/ -r src/ --exclude_files lib/punycode.js

test-http1: all
	$(PYTHON) tools/test.py --mode=release --use-http1 simple message

test-valgrind: all
	$(PYTHON) tools/test.py --mode=release --valgrind simple message

test/gc/node_modules/weak/build:
	@if [ ! -f node ]; then make all; fi
	./node deps/npm/node_modules/node-gyp/bin/node-gyp rebuild \
		--directory="$(shell pwd)/test/gc/node_modules/weak" \
		--nodedir="$(shell pwd)"

test-gc: all test/gc/node_modules/weak/build
	$(PYTHON) tools/test.py --mode=release gc

test-all: all test/gc/node_modules/weak/build
	$(PYTHON) tools/test.py --mode=debug,release
	make test-npm

test-all-http1: all
	$(PYTHON) tools/test.py --mode=debug,release --use-http1

test-all-valgrind: all
	$(PYTHON) tools/test.py --mode=debug,release --valgrind

test-release: all
	$(PYTHON) tools/test.py --mode=release

test-debug: all
	$(PYTHON) tools/test.py --mode=debug

test-message: all
	$(PYTHON) tools/test.py message

test-simple: all
	$(PYTHON) tools/test.py simple

test-pummel: all
	$(PYTHON) tools/test.py pummel

test-internet: all
	$(PYTHON) tools/test.py internet

test-npm: node
	./node deps/npm/test/run.js

test-npm-publish: node
	npm_package_config_publishtest=true ./node deps/npm/test/run.js

apidoc_sources = $(wildcard doc/api/*.markdown)
apidocs = $(addprefix out/,$(apidoc_sources:.markdown=.html)) \
          $(addprefix out/,$(apidoc_sources:.markdown=.json))

apidoc_dirs = out/doc out/doc/api/ out/doc/api/assets out/doc/about out/doc/community out/doc/download out/doc/logos out/doc/images

apiassets = $(subst api_assets,api/assets,$(addprefix out/,$(wildcard doc/api_assets/*)))

doc_images = $(addprefix out/,$(wildcard doc/images/* doc/*.jpg doc/*.png))

website_files = \
	out/doc/index.html    \
	out/doc/v0.4_announcement.html   \
	out/doc/cla.html      \
	out/doc/sh_main.js    \
	out/doc/sh_javascript.min.js \
	out/doc/sh_vim-dark.css \
	out/doc/sh.css \
	out/doc/favicon.ico   \
	out/doc/pipe.css \
	out/doc/about/index.html \
	out/doc/community/index.html \
	out/doc/download/index.html \
	out/doc/logos/index.html \
	out/doc/changelog.html \
	$(doc_images)

doc: $(apidoc_dirs) $(website_files) $(apiassets) $(apidocs) tools/doc/ blog node

blogclean:
	rm -rf out/blog

blog: doc/blog out/Release/node tools/blog
	out/Release/node tools/blog/generate.js doc/blog/ out/blog/ doc/blog.html doc/rss.xml

$(apidoc_dirs):
	mkdir -p $@

out/doc/api/assets/%: doc/api_assets/% out/doc/api/assets/
	cp $< $@

out/doc/changelog.html: ChangeLog doc/changelog-head.html doc/changelog-foot.html tools/build-changelog.sh node
	bash tools/build-changelog.sh

out/doc/%.html: doc/%.html node
	cat $< | sed -e 's|__VERSION__|'$(VERSION)'|g' > $@

out/doc/%: doc/%
	cp -r $< $@

out/doc/api/%.json: doc/api/%.markdown node
	out/Release/node tools/doc/generate.js --format=json $< > $@

out/doc/api/%.html: doc/api/%.markdown node
	out/Release/node tools/doc/generate.js --format=html --template=doc/template.html $< > $@

email.md: ChangeLog tools/email-footer.md
	bash tools/changelog-head.sh | sed 's|^\* #|* \\#|g' > $@
	cat tools/email-footer.md | sed -e 's|__VERSION__|'$(VERSION)'|g' >> $@

blog.html: email.md
	cat $< | ./node tools/doc/node_modules/.bin/marked > $@

blog-upload: blog
	rsync -r out/blog/ node@nodejs.org:~/web/nodejs.org/blog/

website-upload: doc
	rsync -r out/doc/ node@nodejs.org:~/web/nodejs.org/
	ssh node@nodejs.org '\
    rm -f ~/web/nodejs.org/dist/latest &&\
    ln -s $(VERSION) ~/web/nodejs.org/dist/latest &&\
    rm -f ~/web/nodejs.org/docs/latest &&\
    ln -s $(VERSION) ~/web/nodejs.org/docs/latest &&\
    rm -f ~/web/nodejs.org/dist/node-latest.tar.gz &&\
    ln -s $(VERSION)/node-$(VERSION).tar.gz ~/web/nodejs.org/dist/node-latest.tar.gz'

docopen: out/doc/api/all.html
	-google-chrome out/doc/api/all.html

docclean:
	-rm -rf out/doc

VERSION=v$(shell $(PYTHON) tools/getnodeversion.py)
RELEASE=$(shell $(PYTHON) tools/getnodeisrelease.py)
PLATFORM=$(shell uname | tr '[:upper:]' '[:lower:]')
ifeq ($(findstring x86_64,$(shell uname -m)),x86_64)
DESTCPU ?= x64
else
DESTCPU ?= ia32
endif
ifeq ($(DESTCPU),x64)
ARCH=x64
else
ARCH=x86
endif
TARNAME=node-$(VERSION)
TARBALL=$(TARNAME).tar.gz
BINARYNAME=$(TARNAME)-$(PLATFORM)-$(ARCH)
BINARYTAR=$(BINARYNAME).tar.gz
PKG=out/$(TARNAME).pkg
packagemaker=/Developer/Applications/Utilities/PackageMaker.app/Contents/MacOS/PackageMaker

dist: doc $(TARBALL) $(PKG)

PKGDIR=out/dist-osx

release-only:
	@if [ "$(shell git status --porcelain | egrep -v '^\?\? ')" = "" ]; then \
		exit 0 ; \
	else \
	  echo "" >&2 ; \
		echo "The git repository is not clean." >&2 ; \
		echo "Please commit changes before building release tarball." >&2 ; \
		echo "" >&2 ; \
		git status --porcelain | egrep -v '^\?\?' >&2 ; \
		echo "" >&2 ; \
		exit 1 ; \
	fi
	@if [ "$(RELEASE)" = "1" ]; then \
		exit 0; \
	else \
	  echo "" >&2 ; \
		echo "#NODE_VERSION_IS_RELEASE is set to $(RELEASE)." >&2 ; \
	  echo "Did you remember to update src/node_version.cc?" >&2 ; \
	  echo "" >&2 ; \
		exit 1 ; \
	fi

pkg: $(PKG)

$(PKG): release-only
	rm -rf $(PKGDIR)
	rm -rf out/deps out/Release
	./configure --prefix=$(PKGDIR)/32/usr/local --without-snapshot --dest-cpu=ia32
	$(MAKE) install V=$(V)
	rm -rf out/deps out/Release
	./configure --prefix=$(PKGDIR)/usr/local --without-snapshot --dest-cpu=x64
	$(MAKE) install V=$(V)
	SIGN="$(SIGN)" PKGDIR="$(PKGDIR)" bash tools/osx-codesign.sh
	lipo $(PKGDIR)/32/usr/local/bin/node \
		$(PKGDIR)/usr/local/bin/node \
		-output $(PKGDIR)/usr/local/bin/node-universal \
		-create
	mv $(PKGDIR)/usr/local/bin/node-universal $(PKGDIR)/usr/local/bin/node
	rm -rf $(PKGDIR)/32
	$(packagemaker) \
		--id "org.nodejs.Node" \
		--doc tools/osx-pkg.pmdoc \
		--out $(PKG)
	SIGN="$(SIGN)" PKG="$(PKG)" bash tools/osx-productsign.sh

$(TARBALL): release-only node doc
	git archive --format=tar --prefix=$(TARNAME)/ HEAD | tar xf -
	mkdir -p $(TARNAME)/doc/api
	cp doc/node.1 $(TARNAME)/doc/node.1
	cp -r out/doc/api/* $(TARNAME)/doc/api/
	rm -rf $(TARNAME)/deps/v8/test # too big
	rm -rf $(TARNAME)/doc/images # too big
	find $(TARNAME)/ -type l | xargs rm # annoying on windows
	tar -cf $(TARNAME).tar $(TARNAME)
	rm -rf $(TARNAME)
	gzip -f -9 $(TARNAME).tar

tar: $(TARBALL)

$(BINARYTAR): release-only
	rm -rf $(BINARYNAME)
	rm -rf out/deps out/Release
	./configure --prefix=/ --without-snapshot --dest-cpu=$(DESTCPU)
	$(MAKE) install DESTDIR=$(BINARYNAME) V=$(V) PORTABLE=1
	cp README.md $(BINARYNAME)
	cp LICENSE $(BINARYNAME)
	cp ChangeLog $(BINARYNAME)
	tar -cf $(BINARYNAME).tar $(BINARYNAME)
	rm -rf $(BINARYNAME)
	gzip -f -9 $(BINARYNAME).tar

binary: $(BINARYTAR)

dist-upload: $(TARBALL) $(PKG)
	ssh node@nodejs.org mkdir -p web/nodejs.org/dist/$(VERSION)
	scp $(TARBALL) node@nodejs.org:~/web/nodejs.org/dist/$(VERSION)/$(TARBALL)
	scp $(PKG) node@nodejs.org:~/web/nodejs.org/dist/$(VERSION)/$(TARNAME).pkg

bench:
	 benchmark/http_simple_bench.sh

bench-idle:
	./node benchmark/idle_server.js &
	sleep 1
	./node benchmark/idle_clients.js &

jslintfix:
	PYTHONPATH=tools/closure_linter/ $(PYTHON) tools/closure_linter/closure_linter/fixjsstyle.py --strict --nojsdoc -r lib/ -r src/ --exclude_files lib/punycode.js

jslint:
	PYTHONPATH=tools/closure_linter/ $(PYTHON) tools/closure_linter/closure_linter/gjslint.py --unix_mode --strict --nojsdoc -r lib/ -r src/ --exclude_files lib/punycode.js

cpplint:
	@$(PYTHON) tools/cpplint.py $(wildcard src/*.cc src/*.h src/*.c)

lint: jslint cpplint

.PHONY: lint cpplint jslint bench clean docopen docclean doc dist distclean check uninstall install install-includes install-bin all staticlib dynamiclib test test-all website-upload pkg blog blogclean tar binary release-only
