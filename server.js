/**
 * PA Election Feed Parser -- Server actions
 * 2014 Ændrew Rininsland
 *
 * This builds a results object from PA XML local election feeds and pushes to S3.
 *
 * Configuration: It expects lftp to be installed or some variety of syncing mechanism
 * between PA and the machine it's being run on. I don't really know of a way
 * to parallelize this. Figure it out yourself. See pa_does_not_understand_the_concept_of_feeds.sh.
 *
 * Also, I'm shit at OO JavaScript and there's probably a nicer way of accomplishing the following,
 * without resorting to needing a "new" keyword in app.js.
 */

'use strict';

module.exports = function() {
  var fs = require('fs');
  var knox = require('knox');
  var libxmljs = require('libxmljs');
  var results = {};
  var resultsDirectory = typeof(process.env.RESULTS_DIRECTORY) !== 'undefined' ? process.env.RESULTS_DIRECTORY : '/2014/ReferendumResults/';
  var resultsFilename =  typeof(process.env.RESULTS_FILENAME) !== 'undefined' ? process.env.RESULTS_FILENAME : 'results.json';
  // var SOPFilename =  typeof(process.env.SOP_FILENAME) !== 'undefined' ? process.env.SOP_FILENAME : 'SOP.xml';
  // var ReferendumFilename =  typeof(process.env.REFERENDUM_FILENAME) !== 'undefined' ? process.env.SOP_FILENAME : 'referendum_running_totals.xml';
  // var feedType =  typeof(process.env.ELECTIONTYPE) !== 'undefined' ? process.env.ELECTIONTYPE : 'local';

  var client = knox.createClient({
    key: process.env.AWS_KEY,
    secret: process.env.AWS_SECRET,
    bucket: process.env.AWS_BUCKET
  });

  /** Websocket Output **/
  var io = require('socket.io').listen(9321);
  io.sockets.setMaxListeners(500);
  io.set('origins', '*');

  var events = require('events');
  var eventEmitter = new events.EventEmitter();
  eventEmitter.setMaxListeners(0);

  io.sockets.on('connection', function (socket) {
    eventEmitter.on('resultsUpdated', function(){
      socket.emit('requestUpdate');
    });
  });


  console.log('PA Server initialised.');

  return {
    pushJSONtoS3:  function(jsonObject, remoteFilename) {
      console.dir(jsonObject);
      try {
        var filename = (remoteFilename ? remoteFilename : resultsFilename);
        var output = JSON.stringify(jsonObject);
        var bucketPath = resultsDirectory + filename;
        var req = client.put(bucketPath, {
          'Content-Length': output.length,
          'Content-Type': 'application/json',
          'x-amz-acl': 'public-read'
        });
        req.on('response', function(res){
          if (200 === res.statusCode) {
            console.log('saved json to %s', req.url);
          }
        });
        req.end(output);

        // Update websockets...
        eventEmitter.emit('resultsUpdated');
        return true;
      } catch(e) {
        console.log('Problem pushing to S3...');
        console.dir(e);
        return false;
      }
    },

    pushXMLtoS3: function(localFilename, remoteFilename) {
      try {
        var filename = (remoteFilename ? remoteFilename : localFilename);
        var output = fs.readFileSync('./data/results/' + localFilename);
        var bucketPath = resultsDirectory + filename;
        var req = client.put(bucketPath, {
          'Content-Length': output.length,
          'Content-Type': 'application/xml',
          'x-amz-acl': 'public-read'
        });
        req.on('response', function(res){
          if (200 === res.statusCode) {
            console.log('saved XML to %s', req.url);
          }
        });
        req.end(output);

        // Update websockets...
        eventEmitter.emit('resultsUpdated');

        return true;

      } catch(e) {
        console.log('Problem pushing to S3...');
        console.dir(e);
        return false;
      }
    },

    parseXMLString: function(xmlString, feedType){
      feedType = typeof feedType !== 'undefined' ? feedType : 'local';
      var xmldoc, 
          council, 
          changesNodes, 
          newCouncilNodes, 
          region, 
          winningParty, 
          sittingParty, 
          gainOrHold,
          changes,
          newCouncil,
          results;

      if (feedType === 'local') {
        console.log('Parsing a local result...');
        try {
          xmldoc = libxmljs.parseXmlString(xmlString, { noblanks: true });
          council = xmldoc.get('//Council');
          changesNodes = xmldoc.get('//Changes').childNodes();
          newCouncilNodes = xmldoc.get('//NewCouncil').childNodes();
          region = council.attr('name').value();
          winningParty = council.attr('winningParty').value();
          sittingParty = council.attr('sittingParty').value();
          gainOrHold = council.attr('gainOrHold').value();
          changes = {};
          newCouncil = {};
          results = {};

          changesNodes.forEach(function(party){
            changes[party.attr('name').value()] = party.attr('change').value();
          });

          newCouncilNodes.forEach(function(party){
            newCouncil[party.attr('name').value()] = party.attr('seats').value();
          });

          console.log('Updating ' + region);
          results[region] = {
            'winningParty' : winningParty,
            'sittingParty' : sittingParty,
            'gainOrHold' : gainOrHold,
            'changes' : changes,
            'newCouncil' : newCouncil
          };

          return results;

        } catch(err) {
          console.log('It could not parse this "feed".');
          console.log('Ignoring! The XML is:');
          console.log(xmlString);
          console.dir(err);
        }
      } else if (feedType === 'referendum') {
        console.log('Parsing a referendum result...');
        try {
          xmldoc = libxmljs.parseXmlString(xmlString, { noblanks: true });
          var votingArea = xmldoc.get('//VotingArea').attr('name').value();
          var proposition = xmldoc.get('//Proposition');
          var answers = proposition.childNodes();
          results = {};
          results[votingArea] = [];

          answers.forEach(function(v){
            var result = {};
            result.winning = v.attr('winning').value();
            result.text = v.attr('text').value();
            result.shortText = v.attr('shortText').value();
            result.votes = v.attr('votes').value();
            result.percentage = v.attr('percentageShare').value();
            results[votingArea].push(result);
          });

          return results;

        } catch(err) {
          console.log('It could not parse this "feed".');
          console.log('Ignoring! The XML is:');
          console.log(xmlString);
          console.dir(err);
        }
      } else { // default to general election
        console.log('Parsing a national election result...');
        try {
          xmldoc = libxmljs.parseXmlString(xmlString, { noblanks: true });
          var constit = xmldoc.get('//Election').get('//Constituency');
          var resultsNodes = constit.childNodes();
          var constitName = constit.attr('name').value();
          winningParty = constit.attr('winningParty').value();
          sittingParty = constit.attr('sittingParty').value();
          gainOrHold = constit.attr('gainOrHold').value();
          var outcome = {};
          results = {};

          resultsNodes.forEach(function(candidate){
            var partyNode = candidate.get('//Party');
            var partyName = partyNode.attr('abbreviation').value();
            outcome[partyName] = {
              firstName: candidate.attr('firstName').value(),
              lastName: candidate.attr('surname').value(),
              votes: partyNode.attr('votes').value(),
              percentageShare: partyNode.attr('percentageShare').value(),
              percentageShareChange: partyNode.attr('percentageShareChange') ? partyNode.attr('percentageShareChange').value() : 'n/a'
            };
          });


          console.log('Updating ' + constitName);
          results[constitName] = {
            'winningParty' : winningParty,
            'sittingParty' : sittingParty,
            'gainOrHold' : gainOrHold,
            'results' : outcome,
          };

          return results;

        } catch(err) {
          console.log('It could not parse this "feed".');
          console.log('Ignoring! The XML is:');
          console.log(xmlString);
          console.dir(err);
        }
      }
    },

    snapshotMap: function(){
      console.log('taking snapshot');
      var phantom = require('phantom');
      phantom.create(function (ph) {
        ph.createPage(function (page) {
          page.set('viewportSize', {
            width: 1600,
            height: 1200
          });
          page.set('settings.localToRemoteUrlAccessEnabled', true);
          page.open('http://nuk-tnl-editorial-prod-staticassets.s3.amazonaws.com/2014/maps/scottish-referendum-map/index.html', function() {
            setTimeout(function () {
              page.evaluate(function (selector) {
                  var cr = document.querySelector(selector).getBoundingClientRect();
                  return cr;
                },
                function (result) {
                  page.set('clipRect', {
                    top:    result.top + 315,
                    left:   result.left + 257,
                    width:  335,
                    height: 560
                  });

                  console.log('Rendering to file...');
                  page.render('map.png', function(){
                    // Push to S3
                    try {
                      var filename = 'map.png';
                      var output = fs.readFileSync('./map.png');
                      var bucketPath = resultsDirectory + filename;
                      var req = client.put(bucketPath, {
                        'Content-Length': output.length,
                        'Content-Type': 'image/png',
                        'x-amz-acl': 'public-read'
                      });
                      req.on('response', function(res){
                        if (200 === res.statusCode) {
                          console.log('saved updated map image to %s', req.url);
                        }
                      });
                      req.end(output);
                      return true;
                    } catch(e) {
                      console.log('Problem pushing updated map to S3...');
                      console.dir(e);
                      return false;
                    }

                    ph.exit();
                  });
                },
                '#map'
              );
            }, 5000);
          });
        });
      });
    }
  }; // end return
};
