/**
 * @license
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const fs = require('fs');
const log = require('../../lighthouse-core/lib/log.js');
const stringify = require('json-stringify-safe');

function getFilenamePrefix(options) {
  const url = options.url;
  const hostname = url.match(/^.*?\/\/(.*?)(:?\/|$)/)[1];

  const date = options.date || new Date();
  const resolvedLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  const time = date.toLocaleTimeString(resolvedLocale, {hour12: false});
  const timeStampStr = date.toISOString().replace(/T.*/, '_' + time);

  const filenamePrefix = hostname + '_' + timeStampStr;
  // replace characters that are unfriendly to filenames
  return (filenamePrefix).replace(/[\/\?<>\\:\*\|":]/g, '-');
}

// Some trace events are particularly large, and not only consume a LOT of disk
// space, but also cause problems for the JSON stringifier. For simplicity, we exclude them
function filterForSize(traceEvents) {
  return traceEvents.filter(e => e.name !== 'LayoutTree');
}

// inject 'em in there'
function addMetrics(traceEvents, auditResults) {
  if (!auditResults) {
    return traceEvents;
  }

  var res = {};
  auditResults.forEach(audit => {
    res[audit.name] = audit;
  });

  const resFMP = res['first-meaningful-paint'];
  const resFMPext = resFMP.extendedInfo;
  const resSI = res['speed-index-metric'];
  const resSIext = resSI.extendedInfo;
  const resTTI = res['time-to-interactive'];
  const resTTIext = resTTI.extendedInfo;

  // monotonic clock ts from the trace.
  const navStart = resFMPext.value.timings.navStart;

  const timings = [{
    name: 'First Contentful Paint',
    traceEvtName: 'MarkFCP',
    value: resFMPext && (navStart + resFMPext.value.timings.fCP),
  }, {
    name: 'First Meaningful Paint',
    traceEvtName: 'MarkFMP',
    value: navStart + resFMP.rawValue,
  }, {
    name: 'Perceptual Speed Index',
    traceEvtName: 'MarkVC50',
    value: navStart + resSI.rawValue,
  }, {
    name: 'First Visual Change',
    traceEvtName: 'MarkVC1',
    value: resSIext && (navStart + resSIext.value.first),
  }, {
    name: 'Visually Complete 100%',
    traceEvtName: 'MarkVC100',
    value: resSIext && (navStart + resSIext.value.complete),
  }, {
    name: 'Time to Interactive',
    traceEvtName: 'MarkTTI',
    value: navStart + resTTI.rawValue,
  }, {
    name: 'Visually Complete 85%',
    traceEvtName: 'MarkVC85',
    value: resTTIext && (navStart + resTTIext.value.timings.visuallyReady),
  }, {
    name: 'Navigation Start',
    traceEvtName: 'MarkNavStart',
    value: navStart
  }];

  const filteredEvents = traceEvents.filter(e => {
    return e.name === 'TracingStartedInPage' || e.cat === 'blink.user_timing' || e.name === 'navigationStart';
  });

  // We'll masquerade our fake events as a combination of TracingStartedInPage & navigationStart
  // {"pid":89922,"tid":1295,"ts":77174383652,"ph":"I","cat":"disabled-by-default-devtools.timeline","name":"TracingStartedInPage","args":{"data":{"page":"0x2a34d8e01e08","sessionId":"89922.4"}},"tts":1076978,"s":"t"},
  // {"pid":89922, "tid":1295, "ts":134015115578, "ph":"R", "cat":"blink.user_timing", "name":"navigationStart", "args":{ "frame":"0x202a71ba1e20"},"tts":299930 }
  const refEvent = filteredEvents.filter(e => e.name === 'TracingStartedInPage')[0];
  const navigationStartEvt = filteredEvents.filter(e => {
    return e.name === 'navigationStart' && e.pid === refEvent.pid && e.tid === refEvent.tid;
  })[0];

  // We are constructing performance.measure trace events, which have a start and end as follows:
  // {"pid": 89922,"tid":1295,"ts":77176783452,"ph":"b","cat":"blink.user_timing","name":"innermeasure","args":{},"tts":1257886,"id":"0xe66c67"}
  // { "pid":89922,"tid":1295,"ts":77176882592, "ph":"e", "cat":"blink.user_timing", "name":"innermeasure", "args":{ },"tts":1257898, "id":"0xe66c67" }
  let counter = (Math.random() * 1000000) | 0;
  timings.forEach(timing => {
    if (!timing.value || timing.value === navStart) {
      return;
    }
    const eventBase = {
      name: timing.name,
      id: `0x${(counter++).toString(16)}`,
      cat: 'blink.user_timing',
    };
    const fakeMeasureStartEvent = Object.assign({}, navigationStartEvt, eventBase, {
      ts: Math.floor(navStart * 1000),
      ph: 'b'
    });
    const fakeMeasureEndEvent = Object.assign({}, navigationStartEvt, eventBase, {
      ts: Math.floor(timing.value * 1000),
      ph: 'e',
    });
    traceEvents.push(fakeMeasureStartEvent, fakeMeasureEndEvent);
  });
  return traceEvents;
}

function screenshotDump(options, screenshots) {
  return `
  <!doctype html>
  <title>screenshots ${getFilenamePrefix(options)}</title>
  <style>
html {
    overflow-x: scroll;
    overflow-y: hidden;
    height: 100%;
    background: linear-gradient(to left, #4CA1AF , #C4E0E5);
    background-attachment: fixed;
    padding: 10px;
}
body {
    white-space: nowrap;
    background: linear-gradient(to left, #4CA1AF , #C4E0E5);
    width: 100%;
    margin: 0;
}
img {
    margin: 4px;
}
</style>
  <body>
    <script>
      var shots = ${JSON.stringify(screenshots)};

  shots.forEach(s => {
    var i = document.createElement('img');
    i.src = s.datauri;
    i.title = s.timestamp;
    document.body.appendChild(i);
  });
  </script>
  `;
}

// Set to ignore because testing it would imply testing fs, which isn't strictly necessary.
/* istanbul ignore next */
function saveArtifacts(artifacts, filename) {
  const artifactsFilename = filename || 'artifacts.log';
  fs.writeFileSync(artifactsFilename, stringify(artifacts));
  log.log('artifacts file saved to disk', artifactsFilename);
}

/**
 * Filter traces and extract screenshots to prepare for saving.
 * @param {!Object} options
 * @param {!Artifacts} artifacts
 * @return {!Promise<!Array<{traceData: !Object, html: string}>>}
 */
function prepareAssets(options, artifacts, auditResults) {
  const passNames = Object.keys(artifacts.traces);
  const assets = [];

  return passNames.reduce((chain, passName) => {
    const trace = artifacts.traces[passName];

    return chain.then(_ => artifacts.requestScreenshots(trace))
      .then(screenshots => {
        const traceData = Object.assign({}, trace);
        traceData.traceEvents = filterForSize(traceData.traceEvents);
        traceData.traceEvents = addMetrics(traceData.traceEvents, auditResults);
        const html = screenshotDump(options, screenshots);

        assets.push({
          traceData,
          html
        });
      });
  }, Promise.resolve())
    .then(_ => assets);
}

/**
 * Writes trace(s) and associated screenshot(s) to disk.
 * @param {!Object} options
 * @param {!Artifacts} artifacts
 * @return {!Promise}
 */
function saveAssets(options, artifacts, auditResults) {
  return prepareAssets(options, artifacts, auditResults).then(assets => {
    assets.forEach((data, index) => {
      const filenamePrefix = getFilenamePrefix(options);
      const traceData = data.traceData;
      fs.writeFileSync(`${filenamePrefix}-${index}.trace.json`, stringify(traceData, null, 2));
      log.log('trace file saved to disk', filenamePrefix);

      fs.writeFileSync(`${filenamePrefix}-${index}.screenshots.html`, data.html);
      log.log('screenshots saved to disk', filenamePrefix);
    });
  });
}

module.exports = {
  saveArtifacts,
  saveAssets,
  getFilenamePrefix,
  prepareAssets
};
