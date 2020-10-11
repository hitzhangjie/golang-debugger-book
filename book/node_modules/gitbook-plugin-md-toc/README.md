# GitBook plugin: InTopic TOC

![Build Status](https://api.travis-ci.org/zanfab/gitbook-plugin-intopic-toc.svg)
[![npm version](https://img.shields.io/npm/v/gitbook-plugin-intopic-toc/latest.svg)](https://www.npmjs.com/package/gitbook-plugin-intopic-toc)

This GitBook plugin adds an inline table of contents (TOC) to each page based on configurable selectors. Inline TOC can be enabled or disabled by default or on individual pages. TOC is placed on the right side and moves to top for smaller devices automatically.

Inline TOC stays at the top of the page when scrolling using a sticky effect. Current position is highlighted by a scrollspy effect.

![Inline TOC in desktop and mobile mode](https://user-images.githubusercontent.com/44210522/50728477-ab322680-112a-11e9-92da-4de20e17758d.png)

Plugin uses [gumshoe](https://github.com/cferdinandi/gumshoe) and [anchorjs](https://github.com/bryanbraun/anchorjs) to implement functionality.

## Installation

### Step #1 - Update book.json file

1. In you gitbook's book.json file, add `intopic-toc` to plugins list.
2. In pluginsConfig, configure the plugin so it does fit your needs. A custom setup is not mandatory.

**Sample `book.json` file for gitbook version 2.0.0+**

```json
{
  "plugins": [
    "intopic-toc"
  ]
}
```

**Sample `book.json` file for gitbook version 2.0.0+ and custom heading**

```json
{
  "plugins": [
    "intopic-toc"
  ],
  "pluginsConfig": {
    "intopic-toc": {
      "label": "Navigation"
    }
  }
}
```

**Sample `book.json` file for gitbook version 2.0.0+  and multilingual headings**

```json
{
  "plugins": [
    "intopic-toc"
  ],
  "pluginsConfig": {
    "intopic-toc": {
      "label": {
        "de": "In diesem Artikel",
        "en": "In this article"
      }
    }
  }
}
```

Note: Above snippets can be used as complete `book.json` file, if one of these matches your requirements and your book doesn't have one yet.

### Step #2 - gitbook commands

1. Run `gitbook install`. It will automatically install `intopic-toc` gitbook plugin for your book. This is needed only once.
2. Build your book (`gitbook build`) or serve (`gitbook serve`) as usual.

## Usage

For basic usage, the only thing you have to do is install the plugin. For advanced scenarios see following configuration sample.

```json
{
  "plugins": [
    "intopic-toc"
  ],
  "pluginsConfig": {
    "intopic-toc": {
      "selector": ".markdown-section h2",
      "visible": true,
      "label": {
        "de": "In diesem Artikel",
        "en": "In this article"
      },
    }
  }
}
```

| Property | Description                                                  | Default value        |
| -------- | ------------------------------------------------------------ | -------------------- |
| selector | Selector used to find elements to put anchors on             | .markdown-section h2 |
| visible  | Defines whether to show the navigation on every page         | true                 |
| label    | Label which is used as heading for the navigation. Could be a single string or an object for multilingual setups | In this article      |

If `visible` parameter set to true and you want to hide the TOC on a single page, add the front matter item `isTocVisible: false` to the top of the Markdown file like this:

```markdown
---
isTocVisible: false
---
# My awesome documentation

Lorem ipsum dolor sit amet, consetetur sadipscing elitr, ...
```

The specific front matter `isTocVisible` overrides the `visible` parameter from global configuration.

## Troubleshooting

If inline TOC does not look as expected, check if your `book.json` is valid according to this documentation.

## Changelog

01/07/2019 - Used [gumshoe scrollspy script](https://github.com/cferdinandi/gumshoe)  for a better experience

01/05/2019 - Initial Release
