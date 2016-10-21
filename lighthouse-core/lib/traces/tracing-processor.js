/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

if (typeof global.window === 'undefined') {
  global.window = global;
}

// The ideal input response latency, the time between the input task and the
// first frame of the response.
const BASE_RESPONSE_LATENCY = 16;

// we need gl-matrix for traceviewer
// since it has internal forks for isNode and they get mixed up during
// browserify, we require them locally here and global-ize them.

// from catapult/tracing/tracing/base/math.html
const glMatrixModule = require('gl-matrix');
Object.keys(glMatrixModule).forEach(exportName => {
  global[exportName] = glMatrixModule[exportName];
});
global.mannwhitneyu = {};
global.HTMLImportsLoader = {};
global.HTMLImportsLoader.hrefToAbsolutePath = function(path) {
  if (path === '/gl-matrix-min.js') {
    return '../../../lib/empty-stub.js';
  }
  if (path === '/mannwhitneyu.js') {
    return '../../../lib/empty-stub.js';
  }
};

require('../../third_party/traceviewer-js/');
const traceviewer = global.tr;

class TraceProcessor {

  /**
   * Calculate duration at specified percentiles for given population of
   * durations.
   * If one of the durations overlaps the end of the window, the full
   * duration should be in the duration array, but the length not included
   * within the window should be given as `clippedLength`. For instance, if a
   * 50ms duration occurs 10ms before the end of the window, `50` should be in
   * the `durations` array, and `clippedLength` should be set to 40.
   * @see https://docs.google.com/document/d/18gvP-CBA2BiBpi3Rz1I1ISciKGhniTSZ9TY0XCnXS7E/preview
   * @param {!Array<number>} durations Array of durations, sorted in ascending order.
   * @param {number} totalTime Total time (in ms) of interval containing durations.
   * @param {!Array<number>} percentiles Array of percentiles of interest, in ascending order.
   * @param {number=} clippedLength Optional length clipped from a duration overlapping end of window. Default of 0.
   * @return {!Array<{percentile: number, time: number}>}
   * @private
   */
  static _riskPercentiles(durations, totalTime, percentiles, clippedLength) {
    clippedLength = clippedLength || 0;

    let busyTime = 0;
    for (let i = 0; i < durations.length; i++) {
      busyTime += durations[i];
    }
    busyTime -= clippedLength;

    // Start with idle time already complete.
    let completedTime = totalTime - busyTime;
    let duration = 0;
    let cdfTime = completedTime;
    const results = [];

    let durationIndex = -1;
    let remainingCount = durations.length + 1;
    if (clippedLength > 0) {
      // If there was a clipped duration, one less in count since one hasn't started yet.
      remainingCount--;
    }

    // Find percentiles of interest, in order.
    for (const percentile of percentiles) {
      // Loop over durations, calculating a CDF value for each until it is above
      // the target percentile.
      const percentileTime = percentile * totalTime;
      while (cdfTime < percentileTime && durationIndex < durations.length - 1) {
        completedTime += duration;
        remainingCount -= (duration < 0 ? -1 : 1);

        if (clippedLength > 0 && clippedLength < durations[durationIndex + 1]) {
          duration = -clippedLength;
          clippedLength = 0;
        } else {
          durationIndex++;
          duration = durations[durationIndex];
        }

        // Calculate value of CDF (multiplied by totalTime) for the end of this duration.
        cdfTime = completedTime + Math.abs(duration) * remainingCount;
      }

      // Negative results are within idle time (0ms wait by definition), so clamp at zero.
      results.push({
        percentile,
        time: Math.max(0, (percentileTime - completedTime) / remainingCount) + BASE_RESPONSE_LATENCY
      });
    }

    return results;
  }

  /**
   * Calculates the maximum queueing time (in ms) of high priority tasks for
   * selected percentiles within a window of the main thread.
   * @see https://docs.google.com/document/d/18gvP-CBA2BiBpi3Rz1I1ISciKGhniTSZ9TY0XCnXS7E/preview
   * @param {{traceEvents: !Array<!Object>}} trace
   * @param {number=} startTime Optional start time (in ms) of range of interest. Defaults to trace start.
   * @param {number=} endTime Optional end time (in ms) of range of interest. Defaults to trace end.
   * @param {!Array<number>=} percentiles Optional array of percentiles to compute. Defaults to [0.5, 0.75, 0.9, 0.99, 1].
   * @return {!Array<{percentile: number, time: number}>}
   */
  static getRiskToResponsiveness(trace, startTime, endTime, percentiles) {
    const events = trace.traceEvents.sort((a, b) => a.ts - b.ts).filter(e => e.ts !== 0);
    const tsBase = events[0].ts;
    const lastEvent = events[events.length - 1];

    // Range of responsiveness we care about. Default to bounds of model.
    startTime = startTime === undefined ? 0 : startTime;
    endTime = endTime === undefined ? (lastEvent.ts - tsBase) / 1000 : endTime;
    const totalTime = endTime - startTime;
    if (percentiles) {
      percentiles.sort((a, b) => a - b);
    } else {
      percentiles = [0.5, 0.75, 0.9, 0.99, 1];
    }

    // Find the main thread via the first TracingStartedInPage event in the trace
    const startEvent = trace.traceEvents.find(event => {
      return event.name === 'TracingStartedInPage';
    });

    const topLevelTasks = trace.traceEvents.filter(evt => {
      return evt.pid === startEvent.pid && evt.tid === startEvent.tid &&
          evt.name === 'MessageLoop::RunTask';
    });

    // Find durations of all slices in range of interest.
    const durations = [];
    let clippedLength = 0;
    topLevelTasks.forEach(event => {
      const eventStart = (event.ts - tsBase) / 1000;
      const eventDuration = (event.dur || 0) / 1000;
      const eventEnd = eventStart + eventDuration;

      // Discard events outside range.
      if (eventEnd <= startTime || eventStart >= endTime) {
        return;
      }

      // Clip any at edges of range.
      let adjEventStart = eventStart;
      let duration = eventDuration;
      if (adjEventStart < startTime) {
        // Any part of task before window can be discarded.
        adjEventStart = startTime;
        duration = eventEnd - adjEventStart;
      }
      if (eventEnd > endTime) {
        // Any part of task after window must be clipped but accounted for.
        clippedLength = duration - (endTime - adjEventStart);
      }

      durations.push(duration);
    });
    durations.sort((a, b) => a - b);

    // Actual calculation of percentiles done in _riskPercentiles.
    return TraceProcessor._riskPercentiles(durations, totalTime, percentiles, clippedLength);
  }

  /**
   * Uses traceviewer's statistics package to create a log-normal distribution.
   * Specified by providing the median value, at which the score will be 0.5,
   * and the falloff, the initial point of diminishing returns where any
   * improvement in value will yield increasingly smaller gains in score. Both
   * values should be in the same units (e.g. milliseconds). See
   *   https://www.desmos.com/calculator/tx1wcjk8ch
   * for an interactive view of the relationship between these parameters and
   * the typical parameterization (location and shape) of the log-normal
   * distribution.
   * @param {number} median
   * @param {number} falloff
   * @return {!Statistics.LogNormalDistribution}
   */
  static getLogNormalDistribution(median, falloff) {
    const location = Math.log(median);

    // The "falloff" value specified the location of the smaller of the positive
    // roots of the third derivative of the log-normal CDF. Calculate the shape
    // parameter in terms of that value and the median.
    const logRatio = Math.log(falloff / median);
    const shape = 0.5 * Math.sqrt(1 - 3 * logRatio -
        Math.sqrt((logRatio - 3) * (logRatio - 3) - 8));

    return new traceviewer.b.Statistics.LogNormalDistribution(location, shape);
  }
}

module.exports = TraceProcessor;
