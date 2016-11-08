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


function getNavStartEvt(traceEvents, url) {
  const traceData = traceEvents;
  // find the didStartProvisionalLoad evt with our intended URL
  const loadStarted = traceData.find(e => e.name === 'RenderFrameImpl::didStartProvisionalLoad' && e.args.url.startsWith(url));
  const navigationStart = traceData.filter(e => e.name === 'navigationStart' && e.ts <= loadStarted.ts).slice(-1)[0];
  return navigationStart;
}


function getMetricEvents(traceEvents, auditResults, options) {
  const newEvents = [];
  if (!auditResults) {
    return newEvents;
  }

  var res = {};
  auditResults.forEach(audit => {
    res[audit.name] = audit;
  });
  console.log(JSON.stringify(options, null, 2));
  const navigationStartEvt = getNavStartEvt(traceEvents, options.initialUrl);

  const resFMP = res['first-meaningful-paint'];
  const resFMPext = resFMP.extendedInfo;
  const resSI = res['speed-index-metric'];
  const resSIext = resSI.extendedInfo;
  const resTTI = res['time-to-interactive'];


  console.error('whats with the', resFMPext.value.timings.navStart, JSON.stringify(navigationStartEvt, null, 2));


  // monotonic clock ts from the trace.
  const navStart = navigationStartEvt.ts / 1000; // resFMPext.value.timings.navStart;

  console.error('whats with the', resFMPext.value.timings.navStart, navigationStartEvt.ts / 1000, JSON.stringify(navigationStartEvt, null, 2));

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
    name: 'Visually Complete',
    traceEvtName: 'MarkVC100',
    value: resSIext && (navStart + resSIext.value.complete),
  }, {
    name: 'Time to Interactive',
    traceEvtName: 'MarkTTI',
    value: navStart + resTTI.rawValue,
  }, {
    name: 'Navigation Start',
    traceEvtName: 'MarkNavStart',
    value: navStart
  }];


  // We are constructing performance.measure trace events, which have a start and end as follows:
  // {"pid": 89922,"tid":1295,"ts":77176783452,"ph":"b","cat":"blink.user_timing","name":"innermeasure","args":{},"tts":1257886,"id":"0xe66c67"}
  // { "pid":89922,"tid":1295,"ts":77176882592, "ph":"e", "cat":"blink.user_timing", "name":"innermeasure", "args":{ },"tts":1257898, "id":"0xe66c67" }
  let counter = (Math.random() * 1000000) | 0;
  timings.forEach(timing => {
    if (!timing.value || timing.value === navStart) {
      return;
    }
    const eventBase = {
      name: `(LH) ${timing.name}`,
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
    newEvents.push(fakeMeasureStartEvent, fakeMeasureEndEvent);
  });
  return newEvents;
}

module.exports = getMetricEvents;
