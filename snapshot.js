/**
 * Testing PhantomJS -- see server.js
 */

/*global phantom*/
'use strict';

var page = require('webpage').create();
page.viewportSize = {
  width: 1600,
  height: 1200
};
page.settings.localToRemoteUrlAccessEnabled = true;

page.open('http://nuk-tnl-editorial-prod-staticassets.s3.amazonaws.com/2014/maps/scottish-referendum-map-dev/index.html', function() {
  window.setTimeout(function () {
    console.log("Getting element clipRect...");
    var clipRect = page.evaluate(function (s) {
      var cr = document.querySelector(s).getBoundingClientRect();
      return cr;
    }, '#map');

    page.clipRect = {
      top:    clipRect.top + 315,
      left:   clipRect.left + 257,
      width:  335,
      height: 560
    };
    console.log("Rendering to file...");
    page.render('map.png');
    phantom.exit();
  }, 10000);
});
