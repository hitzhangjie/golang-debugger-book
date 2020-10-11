const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mermaidCli = require("./mmdc-fixed");
const url = require('url');

function getTmp() {
    const filename = 'mermaid' + crypto.randomBytes(4).readUInt32LE(0);
    return path.join(os.tmpdir(), filename);
}

/**
 * serialize the object to file as json
 * @param jsonObj: the object to be serialised.
 * @param fileDir: where the file to be write.
 * @returns {*} the file
 */
function json2File(jsonObj, fileDir) {
    fs.writeFileSync(fileDir, JSON.stringify(jsonObj, null, 2));
    return fileDir;
}

/**
 *
 * @param book: Global book
 * @param svgFileDir: svgFileDir path
 * @returns {string}
 */
function svg2img(book, svgFileDir) {
    return new Promise((resolve, reject) => {
        if (book.generator === 'ebook') {
            // relevant path
            const dest = path.basename(svgFileDir);
            // Copy a file to the output folder
            book.output.copyFile(svgFileDir, dest).then(function () {
                resolve("<img src=\"" + path.join('/' + dest) + "\"/>");
            });
        } else {
            const text = fs.readFileSync(svgFileDir, 'utf8');
            resolve("<img src='data:image/svg+xml;base64," + new Buffer(text.trim()).toString('base64') + "'>");
        }
    })
}

/**
 *
 * @param {String}mmdString your mermaid string
 * @param book: book
 * @returns {Promise}
 * @private
 */
function _string2svgAsync(mmdString, book) {
    const strFile = getTmp();
    const chromeDir = book.config.get('pluginsConfig.mermaid-cli.chromeDir');
    const chromeArgs = book.config.get('pluginsConfig.mermaid-cli.chromeArgs');
    // not implicated yet.
    return new Promise((resolve, reject) => {
        fs.writeFile(strFile, mmdString, function (err) {
            if (err) {
                console.log(err);
                reject(err)
            }
            // see https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#puppeteerlaunchoptions
            const puppeteerArgs = {
                "headless": true,
                "executablePath": chromeDir
            };
            if (chromeArgs) {
                puppeteerArgs['args'] = chromeArgs;
            }
            // see https://github.com/mermaidjs/mermaid.cli#options
            const format = '.' + (book.generator === 'ebook' ? "png" : "svg");
            mermaidCli.runViaFunction({
                'input': strFile,
                'cssFile': path.join(__dirname, 'mermaid.css'),
                'output': strFile + format,
                'backgroundColor': '#ffffff',
                'puppeteerConfigFile': json2File(puppeteerArgs, strFile + ".json")
            },function (err, stdout, stderr) {
                const svgFile = strFile + format;
                svg2img(book, svgFile).then(function (img) {
                    fs.unlinkSync(strFile);
                    fs.unlinkSync(strFile + '.json');
                    fs.unlinkSync(svgFile);
                    resolve(img)
                });
            })
        });
    })
}

module.exports = {
    blocks: {
        mermaid: {
            process: function (block) {
                var body = block.body;
                var src = block.kwargs.src;
                if (src) {
                    var relativeSrcPath = url.resolve(this.ctx.file.path, src)
                    var absoluteSrcPath = decodeURI(path.resolve(this.book.root, relativeSrcPath))
                    body = fs.readFileSync(absoluteSrcPath, 'utf8')
                }
                return _string2svgAsync(body, this);
            }
        }
    }, hooks: {
        // from gitbook-plugin-mermaid-gb3
        'page:before': async function processMermaidBlockList(page, a) {
            const mermaidRegex = /^```mermaid((.*[\r\n]+)+?)?```$/im;
            var match;
            while ((match = mermaidRegex.exec(page.content))) {
                var rawBlock = match[0];
                var mermaidContent = match[1];
                const processed = "{% mermaid %}\n" + mermaidContent + "{% endmermaid %}\n"
                page.content = page.content.replace(rawBlock, processed);
            }
            return page;
        }
    }
};
