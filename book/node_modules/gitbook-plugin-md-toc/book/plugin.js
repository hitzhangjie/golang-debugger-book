var selector;
var label;
var isVisibleByDefault;

require(["gitbook", "jQuery"], function(gitbook, $) {
    anchors.options = {
        placement: 'left'
    };

    gitbook.events.bind('start', function(e, config) {
        var configuration = config['intopic-toc'];
        selector = configuration.selector;
        isVisibleByDefault = configuration.visible;
        label = configuration.label;

        // Label can be language specific and could be specified via user configuration
        if (typeof label === 'object') {
            var language = gitbook.state.innerLanguage;

            if (language && label.hasOwnProperty(language)) {
                label = label[language];
            } else {
                label = '';
            }
        }

        // Hide navigation if a search is ative
        $bookSearchResults  = $('#book-search-results');

        var observer = new MutationObserver(() => {
            if ($bookSearchResults.hasClass('open')) {
                $('.intopic-toc').hide();
            }
            else {
                $('.intopic-toc').show();
            }
        });

        observer.observe($bookSearchResults[0], { attributes: true });        
    });

    gitbook.events.bind("page.change", function() {
        anchors.removeAll();
        anchors.add(selector);

        var isVisible = (isVisibleByDefault || gitbook.state.page.isTocVisible) && gitbook.state.page.isTocVisible != false;

        if (anchors.elements.length > 1 && isVisible) {
            var navigation = buildNavigation(anchors.elements);

            var section = document.body.querySelector('.page-wrapper');
            section.appendChild(navigation, section.firstChild);

            gumshoe.init({
                container: $(".book-body .body-inner")[0],
                offset: 20,
                scrollDelay: false,
                activeClass: 'selected'
            });
        }
    });
});

function buildNavigation(elements) {
    var navigation = document.createElement('nav');
    navigation.setAttribute('data-gumshoe-header', '');
    navigation.className = 'intopic-toc';

    var heading = document.createElement('h3');
    heading.innerText = label;
    navigation.appendChild(heading);

    var container = document.createElement('ol');
    container.setAttribute('data-gumshoe', '');
    navigation.appendChild(container);

    var headingLevel = "h1";
    for (var i = 0; i < elements.length; i++) {
        var text = elements[i].textContent;
        var href = elements[i].querySelector('.anchorjs-link').getAttribute('href');

        var item = document.createElement('li');

        if (i === 0) {
            item.classList.add('selected');
            headingLevel = elements[i].localName;
        }

        var level = elements[i].localName;
        var indent = (level.substring(1) - headingLevel.substring(1)) * 16;

        var div = document.createElement('div');
        div.style.marginLeft = indent + "px";

        var anchor = document.createElement('a');
        
        anchor.text = text;
        anchor.href = href;

        div.appendChild(anchor);

        item.appendChild(div);

        container.appendChild(item);
    }

    return navigation;
}
