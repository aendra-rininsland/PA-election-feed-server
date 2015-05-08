/**
 * PA Election Feed Parser
 * 2014 Ændrew Rininsland
 *
 * This builds a results object from PA XML local election feeds and pushes to S3.
 *
 * Configuration: It expects lftp to be installed or some variety of syncing mechanism
 * between PA and the machine it's being run on. I don't really know of a way
 * to parallelize this. Figure it out yourself. See pa_does_not_understand_the_concept_of_feeds.sh.
 */

'use strict';

// Requirements

var saw = require('saw');
var ElectionServer = require('./server.js');
var elections = new ElectionServer();
var fs = require('fs');
var libxmljs = require('libxmljs');

// Environment vars

// var resultsDirectory = typeof(process.env.RESULTS_DIRECTORY) !== 'undefined' ? process.env.RESULTS_DIRECTORY : '/2014/ReferendumResults/';
var resultsFilename =  typeof(process.env.RESULTS_FILENAME) !== 'undefined' ? process.env.RESULTS_FILENAME : 'results.json';
var resultsPath = typeof(process.env.RESULTS_PATH) !== 'undefined' ? process.env.RESULTS_PATH : '/home/ec2-user/election-map/pa-feeds/data/results';
var SOPFilename =  typeof(process.env.SOP_FILENAME) !== 'undefined' ? process.env.SOP_FILENAME : 'SOP.xml';
var referendumFilename =  typeof(process.env.REFERENDUM_FILENAME) !== 'undefined' ? process.env.REFERENDUM_FILENAME : 'referendum_running_totals.xml';
var feedType =  typeof(process.env.ELECTION_TYPE) !== 'undefined' ? process.env.ELECTION_TYPE : false;
var resultsFilenameString = (process.env.RESULTS_FILENAME_STRING || 'local_result');
var ftpUsername = (process.env.FTP_USERNAME || undefined);
var ftpPassword = (process.env.FTP_PASSWORD || undefined);
var ftpServer = (process.env.FTP_SERVER || undefined);
console.dir({
  resultsFilename: resultsFilename, 
  resultsPath: resultsPath, 
  SOPFilename: SOPFilename, 
  referendumFilename: referendumFilename, 
  feedType: feedType,
  resultsFilenameString: resultsFilenameString,
  ftpUsername: ftpUsername,
  ftpPassword: ftpPassword,
  ftpServer: ftpServer
});

// Global variables
var results = [];
var latestSOP = 0;
var latestRefRunTotal = 0;
var SOPfilenameIndex = 0;
var refFilenameIndex = 0;
var latestRunningTotalsFilename = '';
var latestSOPFilename = '';

// Run ftp job regularly...
var exec = require('exec-queue');

setInterval(function(){
  console.log('checking...');
  exec('lftp -e "mirror results ' + resultsPath + '; bye" ftp://' + ftpUsername + ':' + ftpPassword + '@' + ftpServer,
  function(error, stdout, stderr) {
    if (stdout) console.log(stdout);
    if (error !== null) console.log(error);
    if (stderr) console.log(stderr);
  });
}, 20000);


// Watch for changes pulled in via lftp
// Please pull request if you can accomplish the same in pure NodeJS.
saw('data/results/')
  .on('ready', function(files){
    files.forEach(function(file){
      var result, votingArea;

      // Local results
      if (file.path.toLowerCase().indexOf(resultsFilenameString.toLowerCase()) > -1) {
        console.log('Found result ' + file.path);
        result = elections.parseXMLString(fs.readFileSync('./data/results/' + file.path, 'utf-8'), feedType);
        if (result) {
          votingArea = Object.keys(result)[0];
          results.push(result);
        }
      }

      // Referendum running totals
      else if (file.path.indexOf('running_totals') > -1) {
        console.log('Parsing referendum running totals ' + file.path);
        var refFilenameIndex = parseInt(file.path.match(/.*?_running_totals_(\d+)\.xml/i)[1]);
        if (refFilenameIndex > latestRefRunTotal) {
          latestRefRunTotal = refFilenameIndex;
          latestRunningTotalsFilename = file.path;
        }
      }

      // State Of Parties
      else if (file.path.indexOf('SOP') > -1) {
        SOPfilenameIndex = parseInt(file.path.match(/SOP_(\d+)\.xml/i)[1]);
        if (SOPfilenameIndex > latestSOP) {
          latestSOP = SOPfilenameIndex;
          latestSOPFilename = file.path;
        }
      }
    });

    if (latestSOP) {
      console.log('Latest SOP: ' + latestSOP);
      elections.pushXMLtoS3(latestSOPFilename, SOPFilename);
    }

    if (latestRefRunTotal) {
      console.log('Latest Referendum RT' + latestRefRunTotal);
      elections.pushXMLtoS3(latestRunningTotalsFilename, referendumFilename);
    }

    if (results) {
      console.log('Publishing initial results to S3!');
      elections.pushJSONtoS3(results, resultsFilename);
      //setTimeout(elections.snapshotMap(), 5000);
    }
  })
  .on('add', function(file){
    var result, votingArea;

    console.log('File ' + file.path + ' changed.');

    // This is important to prevent pushXMLtoS3 from pushing incomplete XML files.
    setTimeout(function(){
      if (file.path.toLowerCase().indexOf(resultsFilenameString.toLowerCase()) > -1) {
        console.log('Found result ' + file.path);
        fs.readFile('./data/results/' + file.path, 'utf8', function (err,data) {
          if (err) {
            return console.log(err);
          }
          result = elections.parseXMLString(data, feedType);
          if (result) {
            votingArea = Object.keys(result)[0];
            if (resultsFilename.match(/_[^1]\.xml$/)) {
              results.forEach(function(v) {
                if (Object.keys(v)[0] === votingArea) {
                  v = result;
                }
              });
            } else {
              results.push(result);
            }
            
          }
          elections.pushJSONtoS3(results, resultsFilename);
          //setTimeout(elections.snapshotMap(), 5000);
        });

      } else if (file.path.indexOf('_SOP_') > -1) {
        SOPfilenameIndex = parseInt(file.path.match(/SOP_(\d+)\.xml/i)[1]);
        console.log('current SOP: ' + latestSOP);
        console.log('Incoming SOP: ' + SOPfilenameIndex);
        if (SOPfilenameIndex > latestSOP) {
          latestSOP = SOPfilenameIndex;
          latestSOPFilename = file.path;
          try {
            libxmljs.parseXmlString(fs.readFileSync('./data/results/' + latestSOPFilename), { noblanks: true }); // Ensure XML isn't broken.
            elections.pushXMLtoS3(latestSOPFilename, SOPFilename);
          } catch(err) {
            console.log('Invalid SOP XML. Disregarding for now...');
          }
        }
      } else if (file.path.indexOf('running_totals') > -1) {
        refFilenameIndex = file.path.match(/.*?running_totals_(\d+)\.xml/i)[1];
        if (refFilenameIndex > latestRefRunTotal) {
          latestRefRunTotal = refFilenameIndex;
          latestRunningTotalsFilename = file.path;
          try {
            libxmljs.parseXmlString(fs.readFileSync('./data/results/' + latestRunningTotalsFilename), { noblanks: true }); // Ensure XML isn't broken.
            elections.pushXMLtoS3(latestRunningTotalsFilename, referendumFilename);
          } catch(err) {
            console.log('Invalid Running Total XML. Disregarding for now...');
          }
        }
      }
    }, 5000);
  });
