#!/usr/bin/env node
'use strict';

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const commander = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const pkg = require('./package.json');

const error = message => {
  console.log(chalk.red(`\n${message}\n`));
  process.exit(1);
};

const checkConfigFile = file => {
  if (!fs.existsSync(file)) {
    error(`Configuration file "${file}" doesn't exist`);
  }
};

commander.version(pkg.version).option('-t, --theme [theme]', 'Theme of the chart, could be default, forest, dark or neutral. Optional. Default: default', /^default|forest|dark|neutral$/, 'default').option('-w, --width [width]', 'Width of the page. Optional. Default: 800', /^\d+$/, '800').option('-H, --height [height]', 'Height of the page. Optional. Default: 600', /^\d+$/, '600').option('-i, --input <input>', 'Input mermaid file. Required.').option('-o, --output [output]', 'Output file. It should be either svg, png or pdf. Optional. Default: input + ".svg"').option('-b, --backgroundColor [backgroundColor]', 'Background color. Example: transparent, red, \'#F0F0F0\'. Optional. Default: white').option('-c, --configFile [configFile]', 'JSON configuration file for mermaid. Optional').option('-C, --cssFile [cssFile]', 'CSS file for the page. Optional').option('-p --puppeteerConfigFile [puppeteerConfigFile]', 'JSON configuration file for puppeteer. Optional').parse(process.argv);

let { theme, width, height, input, output, backgroundColor, configFile, cssFile, puppeteerConfigFile } = commander;

// check input file
if (!input) {
  error('Please specify input file: -i <input>');
}
if (!fs.existsSync(input)) {
  error(`Input file "${input}" doesn't exist`);
}

// check output file
if (!output) {
  output = input + '.svg';
}
if (!/\.(?:svg|png|pdf)$/.test(output)) {
  error(`Output file must end with ".svg", ".png" or ".pdf"`);
}
const outputDir = path.dirname(output);
if (!fs.existsSync(outputDir)) {
  error(`Output directory "${outputDir}/" doesn't exist`);
}

// check config files
let mermaidConfig = { theme };
if (configFile) {
  checkConfigFile(configFile);
  mermaidConfig = Object.assign(mermaidConfig, JSON.parse(fs.readFileSync(configFile, 'utf-8')));
}
let puppeteerConfig = {};
if (puppeteerConfigFile) {
  checkConfigFile(puppeteerConfigFile);
  puppeteerConfig = JSON.parse(fs.readFileSync(puppeteerConfigFile, 'utf-8'));
}

// check cssFile
let myCSS;
if (cssFile) {
  if (!fs.existsSync(cssFile)) {
    error(`CSS file "${cssFile}" doesn't exist`);
  }
  myCSS = fs.readFileSync(cssFile, 'utf-8');
}

// normalize args
width = parseInt(width);
height = parseInt(height);
backgroundColor = backgroundColor || 'white';

_asyncToGenerator(function* () {
  const browser = yield puppeteer.launch(puppeteerConfig);
  const page = yield browser.newPage();
  page.setViewport({ width, height });
  yield page.goto(`file://${path.join(__dirname, 'index.html')}`);
  yield page.evaluate(`document.body.style.background = '${backgroundColor}'`);
  const definition = fs.readFileSync(input, 'utf-8');

  yield page.$eval('#container', function (container, definition, mermaidConfig, myCSS) {
    container.innerHTML = definition;
    window.mermaid.initialize(mermaidConfig);

    if (myCSS) {
      const head = window.document.head || window.document.getElementsByTagName('head')[0];
      const style = document.createElement('style');
      style.type = 'text/css';
      if (style.styleSheet) {
        style.styleSheet.cssText = myCSS;
      } else {
        style.appendChild(document.createTextNode(myCSS));
      }
      head.appendChild(style);
    }

    window.mermaid.init(undefined, container);
  }, definition, mermaidConfig, myCSS);

  if (output.endsWith('svg')) {
    const svg = yield page.$eval('#container', function (container) {
      return container.innerHTML;
    });
    fs.writeFileSync(output, svg);
  } else if (output.endsWith('png')) {
    const clip = yield page.$eval('svg', function (svg) {
      const react = svg.getBoundingClientRect();
      return { x: react.left, y: react.top, width: react.width, height: react.height };
    });
    yield page.screenshot({ path: output, clip, omitBackground: backgroundColor === 'transparent' });
  } else {
    // pdf
    yield page.pdf({ path: output, printBackground: backgroundColor !== 'transparent' });
  }

  browser.close();
})();
