// Copyright 2019 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as InputModule from './input.js';

self.Input = self.Input || {};
Input = Input || {};

/** @constructor */
Input.InputModel = InputModule.InputModel.InputModel;

/**
 * @implements {SDK.SDKModel.SDKModelObserver<!Input.InputModel>}
 * @constructor
 * @unrestricted
 */
Input.InputTimeline = InputModule.InputTimeline.InputTimeline;

/** @enum {symbol} */
Input.InputTimeline.State = InputModule.InputTimeline.State;

/**
 * @constructor
 */
Input.InputTimeline.TracingClient = InputModule.InputTimeline.TracingClient;

/**
 * @constructor
 */
Input.InputTimeline.ActionDelegate = InputModule.InputTimeline.ActionDelegate;

/** @typedef {{type: string, modifiers: number, timestamp: number}} */
Input.InputModel.EventData;
/** @typedef {{x: number, y: number, button: number, buttons: number, clickCount: number, deltaX: number, deltaY: number}} */
Input.InputModel.MouseEventData;
/** @typedef {{code: string, key: string}} */
Input.InputModel.KeyboardEventData;
