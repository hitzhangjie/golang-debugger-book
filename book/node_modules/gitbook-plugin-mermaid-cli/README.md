Render flowcharts in markdown with mermaid.cli.

[![version](https://img.shields.io/npm/v/gitbook-plugin-mermaid-cli.svg)](https://www.npmjs.com/package/gitbook-plugin-mermaid-cli)
[![download](https://img.shields.io/npm/dm/gitbook-plugin-mermaid-cli.svg)](https://www.npmjs.com/package/gitbook-plugin-mermaid-cli)


## Features
* Based on mermaid.cli/puppeteer, generate svg with base64 encode at compile time, no external css and js required.
* Same API like gitbook-plugin-mermaid/Typora
* Support ebook(pdf/mobi/epub) exporting

## How Does it work

```
1. Your mermaid string quote with mermaid
2. Puppeteer/Chrome Runtime
3. SVG(XML)
4. <img src='data:image/svg+xml;base64,xxxx'>
```


## Pre Installation
Puppeteer is a tool to control Chrome via javascript, and mermaid.cli is a wrapper for mermaid on top of Chrome runtime.The installation of puppeteer may be hard on private network, so I created a plugin to skip download the Chrome.

You need to install the Chrome anywhere(yum, brew, or install.exe). Chrome 68+ is preferred.
If you're running on CentOS6, latest Chrome is [not supported](https://www.centos.org/forums/viewtopic.php?t=53768).

## Install

in the book.json:

config your chrome exec file

On Mac/Linux

```json
{
  "plugins": ["mermaid-cli"],
  "pluginsConfig": {
    "mermaid-cli": {
      "chromeDir": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "chromeArgs": []
    }
  }
}
```

On Windows

```json
{
  "plugins": ["mermaid-cli"],
  "pluginsConfig": {
    "mermaid-cli": {
      "chromeDir": "C:\\xxx\\Google Chrome\\chrome.exe",
      "chromeArgs": []
    }
  }
}
```

> If you are running as root, you may pass `"chromeArgs": ["--no-sandbox"]` to fix the error.
> If you are running on Windows, make sure to add escape character like `C:\\xx\\xx.exe`.

then

```sh
# see https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#environment-variables
# on Mac/Linux
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# on Windows(PowerShell)
# $Env:PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = "true"

# then install plugin
gitbook install
# run the gitbook
gitbook serve
```

Now we can use a local Chrome Runtime without download the slowly large file from npm.

> If "Error: spawn E2BIG", please run `gitbook install` again.


### How to use it?
> It's the same API as [JozoVilcek/piranna's gitbook-plugin-mermaid](https://github.com/piranna/gitbook-plugin-mermaid)


There are two options how can be graph put into the gitbook.
To use ~~embedded~~ graph, put in your book block as:
```
{% mermaid %}
graph TD;
  A-->B;
  A-->C;
  B-->D;
  C-->D;
{% endmermaid %}
```

or

    ```mermaid
    graph TD;
      A-->B;
      A-->C;
      B-->D;
      C-->D;
    ```

Plugin will pick up block body and replace it with generated base64 svg diagram.
To load graph ~~from file~~, put in your book block as:
```
{% mermaid src="./diagram.mermaid" %}
{% endmermaid %}
```
If not absolute, plugin will resolve path given in `src` attribute relative to the current book page,
load its content and generate svg diagram.

## TODO
* remove unnecessary style from svg