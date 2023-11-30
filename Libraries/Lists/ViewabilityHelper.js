/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

import type {FrameMetricProps} from './VirtualizedListProps';

const invariant = require('invariant');

export type ViewToken = {
  item: any,
  key: string,
  index: ?number,
  isViewable: boolean,
  isInViewPort?: boolean,
  section?: any,
  ...
};

export type ViewabilityConfigCallbackPair = {
  viewabilityConfig: ViewabilityConfig,
  onViewableItemsChanged: (info: {
    viewableItems: Array<ViewToken>,
    changed: Array<ViewToken>,
    ...
  }) => void,
  onWindowItemsChanged?: (info: {
    viewableItems: Array<ViewToken>,
    changed: Array<ViewToken>,
    ...
  }) => void,
  ...
};

export type ViewabilityConfig = {|
  /**
   * Minimum amount of time (in milliseconds) that an item must be physically viewable before the
   * viewability callback will be fired. A high number means that scrolling through content without
   * stopping will not mark the content as viewable.
   */
  minimumViewTime?: number,

  /**
   * Percent of viewport that must be covered for a partially occluded item to count as
   * "viewable", 0-100. Fully visible items are always considered viewable. A value of 0 means
   * that a single pixel in the viewport makes the item viewable, and a value of 100 means that
   * an item must be either entirely visible or cover the entire viewport to count as viewable.
   */
  viewAreaCoveragePercentThreshold?: number,

  /**
   * Similar to `viewAreaPercentThreshold`, but considers the percent of the item that is visible,
   * rather than the fraction of the viewable area it covers.
   */
  itemVisiblePercentThreshold?: number,

  /**
   * Nothing is considered viewable until the user scrolls or `recordInteraction` is called after
   * render.
   */
  waitForInteraction?: boolean,

  windowOffset?: number | undefined,
|};

/**
 * A Utility class for calculating viewable items based on current metrics like scroll position and
 * layout.
 *
 * An item is said to be in a "viewable" state when any of the following
 * is true for longer than `minimumViewTime` milliseconds (after an interaction if `waitForInteraction`
 * is true):
 *
 * - Occupying >= `viewAreaCoveragePercentThreshold` of the view area XOR fraction of the item
 *   visible in the view area >= `itemVisiblePercentThreshold`.
 * - Entirely visible on screen
 */
class ViewabilityHelper {
  _config: ViewabilityConfig;
  _hasInteracted: boolean = false;
  _timers: Set<number> = new Set();
  _viewableIndices: Array<number> = [];
  _viewableItems: Map<string, ViewToken> = new Map();
  _windowItems: Map<string, ViewToken> = new Map();

  constructor(
    config: ViewabilityConfig = {viewAreaCoveragePercentThreshold: 0},
  ) {
    this._config = config;
  }

  /**
   * Cleanup, e.g. on unmount. Clears any pending timers.
   */
  dispose() {
    /* $FlowFixMe[incompatible-call] (>=0.63.0 site=react_native_fb) This
     * comment suppresses an error found when Flow v0.63 was deployed. To see
     * the error delete this comment and run Flow. */
    this._timers.forEach(clearTimeout);
  }

  /**
   * Determines which items are viewable based on the current metrics and config.
   */
  computeViewableItems(
    props: FrameMetricProps,
    scrollOffset: number,
    viewportHeight: number,
    getFrameMetrics: (
      index: number,
      props: FrameMetricProps,
    ) => ?{
      length: number,
      offset: number,
      ...
    },
    // Optional optimization to reduce the scan size
    renderRange?: {
      first: number,
      last: number,
      ...
    },
  ): Array<number> {
    const itemCount = props.getItemCount(props.data);
    const {itemVisiblePercentThreshold, viewAreaCoveragePercentThreshold} =
      this._config;
    const viewAreaMode = viewAreaCoveragePercentThreshold != null;
    const viewablePercentThreshold = viewAreaMode
      ? viewAreaCoveragePercentThreshold
      : itemVisiblePercentThreshold;
    invariant(
      viewablePercentThreshold != null &&
        (itemVisiblePercentThreshold != null) !==
          (viewAreaCoveragePercentThreshold != null),
      'Must set exactly one of itemVisiblePercentThreshold or viewAreaCoveragePercentThreshold',
    );
    const viewableIndices = [];
    if (itemCount === 0) {
      return viewableIndices;
    }
    let firstVisible = -1;
    const {first, last} = renderRange || {first: 0, last: itemCount - 1};
    if (last >= itemCount) {
      console.warn(
        'Invalid render range computing viewability ' +
          JSON.stringify({renderRange, itemCount}),
      );
      return [];
    }
    for (let idx = first; idx <= last; idx++) {
      const metrics = getFrameMetrics(idx, props);
      if (!metrics) {
        continue;
      }
      const top = metrics.offset - scrollOffset;
      const bottom = top + metrics.length;
      if (top < viewportHeight && bottom > 0) {
        firstVisible = idx;
        if (
          _isViewable(
            viewAreaMode,
            viewablePercentThreshold,
            top,
            bottom,
            viewportHeight,
            metrics.length,
          )
        ) {
          viewableIndices.push(idx);
        }
      } else if (firstVisible >= 0) {
        break;
      }
    }
    return viewableIndices;
  }

  /**
   * Figures out which items are viewable and how that has changed from before and calls
   * `onViewableItemsChanged` as appropriate.
   */
  onUpdate(
    props: FrameMetricProps,
    scrollOffset: number,
    viewportHeight: number,
    getFrameMetrics: (
      index: number,
      props: FrameMetricProps,
    ) => ?{
      length: number,
      offset: number,
      ...
    },
    createViewToken: (
      index: number,
      isViewable: boolean,
      props: FrameMetricProps,
    ) => ViewToken,
    onViewableItemsChanged: ({
      viewableItems: Array<ViewToken>,
      changed: Array<ViewToken>,
      ...
    }) => void,
    // Optional optimization to reduce the scan size
    renderRange?: {
      first: number,
      last: number,
      ...
    },
    onWindowItemsChanged?: ({
      viewableItems: Array<ViewToken>,
      changed: Array<ViewToken>,
      ...
    }) => void,
  ): void {
    const itemCount = props.getItemCount(props.data);
    if (
      (this._config.waitForInteraction && !this._hasInteracted) ||
      itemCount === 0 ||
      !getFrameMetrics(0, props)
    ) {
      return;
    }
    let viewableIndices: Array<number> = [];
    if (itemCount) {
      viewableIndices = this.computeViewableItems(
        props,
        scrollOffset,
        viewportHeight,
        getFrameMetrics,
        renderRange,
      );
    }
    if (
      this._viewableIndices.length === viewableIndices.length &&
      this._viewableIndices.every((v, ii) => v === viewableIndices[ii])
    ) {
      // We might get a lot of scroll events where visibility doesn't change and we don't want to do
      // extra work in those cases.
      return;
    }
    this._viewableIndices = viewableIndices;

    if (viewableIndices && viewableIndices.length > 0 && onWindowItemsChanged) {
      this._onUpdateCellsOnWindow(
        props,
        viewableIndices,
        onWindowItemsChanged,
        createViewToken,
      );
    }

    if (this._config.minimumViewTime) {
      const handle: TimeoutID = setTimeout(() => {
        /* $FlowFixMe[incompatible-call] (>=0.63.0 site=react_native_fb) This
         * comment suppresses an error found when Flow v0.63 was deployed. To
         * see the error delete this comment and run Flow. */
        this._timers.delete(handle);
        this._onUpdateSync(
          props,
          viewableIndices,
          onViewableItemsChanged,
          createViewToken,
        );
      }, this._config.minimumViewTime);
      /* $FlowFixMe[incompatible-call] (>=0.63.0 site=react_native_fb) This
       * comment suppresses an error found when Flow v0.63 was deployed. To see
       * the error delete this comment and run Flow. */
      this._timers.add(handle);
    } else {
      this._onUpdateSync(
        props,
        viewableIndices,
        onViewableItemsChanged,
        createViewToken,
      );
    }
  }

  /**
   * clean-up cached _viewableIndices to evaluate changed items on next update
   */
  resetViewableIndices() {
    this._viewableIndices = [];
  }

  /**
   * Records that an interaction has happened even if there has been no scroll.
   */
  recordInteraction() {
    this._hasInteracted = true;
  }

  _onUpdateSync(
    props: FrameMetricProps,
    viewableIndicesToCheck: Array<number>,
    onViewableItemsChanged: ({
      changed: Array<ViewToken>,
      viewableItems: Array<ViewToken>,
      ...
    }) => void,
    createViewToken: (
      index: number,
      isViewable: boolean,
      props: FrameMetricProps,
    ) => ViewToken,
  ) {
    // Filter out indices that have gone out of view since this call was scheduled.
    viewableIndicesToCheck = viewableIndicesToCheck.filter(ii =>
      this._viewableIndices.includes(ii),
    );
    const prevItems = this._viewableItems;
    const nextItems = new Map(
      viewableIndicesToCheck.map(ii => {
        const viewable = createViewToken(ii, true, props);
        return [viewable.key, viewable];
      }),
    );

    const changed = [];
    for (const [key, viewable] of nextItems) {
      if (!prevItems.has(key)) {
        changed.push(viewable);
      }
    }
    for (const [key, viewable] of prevItems) {
      if (!nextItems.has(key)) {
        changed.push({...viewable, isViewable: false});
      }
    }
    if (changed.length > 0) {
      this._viewableItems = nextItems;
      onViewableItemsChanged({
        viewableItems: Array.from(nextItems.values()),
        changed,
        viewabilityConfig: this._config,
      });
    }
  }

  _onUpdateCellsOnWindow(
    props: FrameMetricProps,
    viewableIndices: Array<number>,
    onWindowItemsChanged: ({
      changed: Array<ViewToken>,
      viewableItems: Array<ViewToken>,
      ...
    }) => void,
    createViewToken: (
      index: number,
      isViewable: boolean,
      props: FrameMetricProps,
    ) => ViewToken,
  ) {
    const windowOffset = this._config.windowOffset || 2;
    // Filter out indices that have gone out of view since this call was scheduled.
    viewableIndices = viewableIndices.filter(ii =>
      this._viewableIndices.includes(ii),
    );

    const viewableIndicesToCheck = [...viewableIndices];

    if (viewableIndicesToCheck.length > 0) {
      viewableIndicesToCheck.unshift(
        ...Array.from(
          {length: windowOffset},
          (value, index) => viewableIndicesToCheck[0] + (index - windowOffset),
        ),
      );

      viewableIndicesToCheck.push(
        ...Array.from(
          {length: windowOffset},
          (value, index) =>
            viewableIndicesToCheck[viewableIndicesToCheck.length - 1] +
            (index + 1),
        ),
      );
    }

    const prevItems = this._windowItems;
    const nextItems = new Map();
    viewableIndicesToCheck.forEach(ii => {
      if (ii >= 0 && ii < props.data.length) {
        const viewable = createViewToken(
          ii,
          viewableIndices.includes(ii),
          props,
        );
        nextItems.set(viewable.key, {...viewable, isInViewPort: true});
      }
    });

    const changed = [];
    for (const [key, viewable] of nextItems) {
      if (!prevItems.has(key)) {
        changed.push(viewable);
      }
    }
    for (const [key, viewable] of prevItems) {
      if (!nextItems.has(key)) {
        changed.push({...viewable, isViewable: false, isInViewPort: false});
      }
    }
    if (changed.length > 0) {
      this._windowItems = nextItems;
      onWindowItemsChanged({
        viewableItems: Array.from(nextItems.values()),
        changed,
        viewabilityConfig: this._config,
      });
    }
  }
}

function _isViewable(
  viewAreaMode: boolean,
  viewablePercentThreshold: number,
  top: number,
  bottom: number,
  viewportHeight: number,
  itemLength: number,
): boolean {
  if (_isEntirelyVisible(top, bottom, viewportHeight)) {
    return true;
  } else {
    const pixels = _getPixelsVisible(top, bottom, viewportHeight);
    const percent =
      100 * (viewAreaMode ? pixels / viewportHeight : pixels / itemLength);
    return percent >= viewablePercentThreshold;
  }
}

function _getPixelsVisible(
  top: number,
  bottom: number,
  viewportHeight: number,
): number {
  const visibleHeight = Math.min(bottom, viewportHeight) - Math.max(top, 0);
  return Math.max(0, visibleHeight);
}

function _isEntirelyVisible(
  top: number,
  bottom: number,
  viewportHeight: number,
): boolean {
  return top >= 0 && bottom <= viewportHeight && bottom > top;
}

module.exports = ViewabilityHelper;
