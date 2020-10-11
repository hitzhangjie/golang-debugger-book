var path = require('path');
var tester = require('gitbook-tester');
var assert = require('assert');
const content = "```mermaid\n" +
    "graph LR\n" +
    "\ta(getLoadBalancer)-->b\n" +
    "\tb(chooseServer)-->s\n" +
    "\ts(IRule)-->Server\n" +
    "```";
tester.builder()
    .withContent(content)
    .withBookJson({
        plugins: ['mermaid-cli'],
        pluginsConfig: {
            'mermaid-cli': {
                "chromeDir": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "chromeArgs": ["--no-sandbox"]
            }
        }
    })
    .withLocalPlugin(path.join(__dirname, '..'))
    .create()
    .then(function (result) {
        console.log(result[0].content)
    });
