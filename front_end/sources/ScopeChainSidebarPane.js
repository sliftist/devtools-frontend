/*
 * Copyright (C) 2008 Apple Inc. All Rights Reserved.
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import * as Common from '../common/common.js';
import * as Components from '../components/components.js';
import * as ObjectUI from '../object_ui/object_ui.js';
import * as SDK from '../sdk/sdk.js';
import * as UI from '../ui/ui.js';

import {resolveScopeInObject, resolveThisObject} from './SourceMapNamesResolver.js';


printMessage("WASM Devtools patched");
function delayPromise(timeout) {
    return new Promise(resolve => {
        setTimeout(resolve, timeout);
    });
}
async function printMessage(text) {
    while (true) {
        var currentExecutionContext = window.UI && UI.context && UI.context.flavor(SDK.ExecutionContext);
        if (!currentExecutionContext) {
            await delayPromise(100);
            continue;
        }
        var message = SDK.consoleModel.addCommandMessage(currentExecutionContext, text);
        break;
    }
}

export class WasmTools extends UI.Widget.VBox {
    constructor() {
        super(true);
        this.registerRequiredCSS('sources/wasmTools.css');
        this.registerRequiredCSS('sources/scopeChainSidebarPane.css');

        this._linkifier = new Components.Linkifier();

        // We are patching some DOM nodes (our title) that we aren't supposed to touch, so we have to wait until they render.
        setTimeout(() => {
            this.update();
        });
    }

    flavorChanged(object) {
        this.update();
    }

    setTitleState(
        /** @type {"message"|"info"|"warn"|"success"|"error"} */
        type,
        title,
        message
    ) {
        if (this.titleInfoNode) {
            this.titleInfoNode.removeChildren();

            this.titleInfoNode.className = `wasm-title-state wasm-title-state--type-${type}`;
            if(window.refreshRequiredToApplyWasmPatch) {
                this._parentWidget._titleElement.classList.add("wasm-support-required");
            }
            if(window.refreshRequiredToApplyWasmPatch) {
                this._parentWidget._titleElement.classList.add("wasm-support-required");
            }
            this.titleInfoNode.appendChild(document.createTextNode(title));
            this._parentWidget._titleElement.title = message;
        }
    }

    update() {
        this.contentElement.removeChildren();
        if (this.titleInfoNode) {
            this.titleInfoNode.removeChildren();
            this._parentWidget._titleElement.title = "";
        };

        const callFrame = UI.context.flavor(SDK.DebuggerModel.CallFrame);

        if (!this.titleInfoNode && this._parentWidget && this._parentWidget._titleElement) {
            this.titleInfoNode = document.createElement("div");

            let oldTitleHolder = document.createElement("div");
            oldTitleHolder.className = "wasm-title-state-old";
            oldTitleHolder.append(...this._parentWidget._titleElement.childNodes);
            this._parentWidget._titleElement.removeChildren();

            this._parentWidget._titleElement.appendChild(oldTitleHolder);

            this._parentWidget._titleElement.appendChild(this.titleInfoNode);
            let titleAligner = document.createElement("div");
            titleAligner.className = "wasm-title-state-aligner";
            this._parentWidget._titleElement.appendChild(titleAligner);
        }

        if (!callFrame) {
            return this.setTitleState("message", "Not paused", "No frame detected, so assuming we are not paused.");
        }

        let scope = callFrame.scopeChain();
        let callFrameSource = callFrame.script;
        if(!scope) {
            return this.setTitleState("error", "Error", "No frame detected, so assuming we are not paused.");
        }
        if(!callFrameSource) {
            return this.setTitleState("error", "Error", "Frame has no script.");
        }
        let { sourceURL } = callFrameSource;
        let isWasm = isWasm(sourceURL);
        if(!isWasm) {
            return this.setTitleState("info", "Not wasm", `Looking for prefixed "wasm://" or "wasm-", but the current source url is "${sourceURL}"`);
        }

        let executionId = callFrame._script.executionContextId;
        window.wasmPatchedLookup = window.wasmPatchedLookup || {};
        if(!window.wasmPatchedLookup[executionId]) {
            window.patchingForWasmSupport = true;
            return this.setTitleState("warn", "Refresh to debug WASM", "Refresh of page required to apply patches to enable wasm support.");
        }


        //todonext
        // Can we actually move this out of the Scope sidebar, into it's own thing, color it differently, move it between Watch and Call Stack,
        //  - And then also make it greyed out when we are not using a wasm file, with title text explaining what file we are using,
        //    and what are checks for wasm files are.
        //  - Also make it greyed out if there isn't .debug_line dwarf info, or rather some other color, maybe yellow? With () text
        //    (and maybe also additional title text)
        //  - And stop it from fully expanding everything? But make sure the default expand state is somewhat nice,
        //      and that expand states persist and stuff...
        
        this.setTitleState("info", "Parsing arguments", `Using base file "${sourceURL}"`);
        
        let title = "arguments";
        let subtitle = undefined;

        const titleElement = createElementWithClass('div', 'scope-chain-sidebar-pane-section-header');
        titleElement.createChild('div', 'scope-chain-sidebar-pane-section-subtitle').textContent = subtitle;
        titleElement.createChild('div', 'scope-chain-sidebar-pane-section-title').textContent = title;

        let time = Date.now();

        let rawDebugObj = generateWasmDebugObj(callFrame);
        if (rawDebugObj) {
            ((async () => {
                let obj = await rawDebugObj;
                if(obj.explicitError) {
                    this.setTitleState(obj.explicitError.type, obj.explicitError.title, obj.explicitError.message);
                    return undefined;
                }
                if(obj.thrownError) {
                    this.setTitleState("error", "Exception", obj.thrownError.stack);
                    return undefined;
                }

                Promise.resolve().then(() => {
                    section.objectTreeElement().expand();
                });

                let remoteObject = createRemoteObject(obj.result);
                let emptyPlaceholder = Common.UIString('Loading...');
                const section = new ObjectUI.ObjectPropertiesSection(
                    new Sources.SourceMapNamesResolver.RemoteObject(
                        {
                            object() { return remoteObject },
                            callFrame() { return callFrame },
                            startLocation() { return undefined },
                            endLocation() { return undefined },
                            type() { return undefined },
                        }
                    ),
                    titleElement,
                    this._linkifier,
                    emptyPlaceholder,
                    true,
                    []
                );

                section.expand();

                section.element.classList.add('scope-chain-sidebar-pane-section');
                this.contentElement.appendChild(section.element);

                time = Date.now() - time;
                this.setTitleState(obj.statusOverride || "success", "", `(render took ${time}ms) ` + obj.message);
            })());
        }
    }
}

function createRemoteObject(
    object
) {
    if (
        typeof object === "number"
        || typeof object === "bigint"
        || typeof object === "boolean"
        || typeof object === "undefined"
        || typeof object === "Symbol"
        || typeof object === "string"
        || object === null
    ) {
        let type = typeof object;
        return {
            type,
            description: String(object),
            subtype: undefined,
            customPreview() { /* A JSONML string? */ return undefined; },
            hasChildren: false,
            preview: undefined,
            getAllProperties() { return { internalProperties: [], properties: [] } },

            arrayLength() { return 0; }
        };
    } else {

        async function getAllProperties(generatePreview) {
            let objectResolved = object;
            if (typeof object === "function") {
                objectResolved = objectResolved();
            }
            objectResolved = await objectResolved;
            if (objectResolved && typeof objectResolved === "object") {
                for (let key of Object.keys(objectResolved)) {
                    objectResolved[key] = await objectResolved[key];
                }
            }

            let properties = [];
            for (let key in objectResolved) {
                if (key === "OBJECT_DISPLAY_NAME") continue;
                properties.push({
                    name: key,
                    value: createRemoteObject(objectResolved[key]),
                    isAccessorProperty() { return false },
                    enumerable: true,
                });
            }
            if(properties.length === 0) {
                properties.push({
                    name: "DEVTOOLS_CHILDREN_EMPTY",
                    value: createRemoteObject(undefined),
                    isAccessorProperty() { return false }
                });
            }
            return {
                // An internal proprty with a name of "[[Entries]]" is expanded by default?
                internalProperties: [],
                properties: properties,
            };
        }

        let description = object.OBJECT_DISPLAY_NAME || "Object";

        return {
            forceExpand: true,

            // Type doesn't matter, it just needs to not match a few special cases.
            type: "Object",
            // TODO: Preview of child objects?
            description: description,
            subtype: undefined,
            customPreview() { /* A JSONML string? */ return undefined; },
            preview: undefined,
            hasChildren: true,
            arrayLength() { return 0 },
            getAllProperties: getAllProperties,
            getOwnProperties: getAllProperties,
        };
    }
}

async function evaluateAtPath(scope, path, fncArguments, fncDeclaration) {
    if (!scope) return undefined;
    let obj = scope.object();
    for (let i = 0; i < path.length; i++) {
        let propObj = await obj.getAllProperties();
        let prop = propObj.properties.filter(x => x.name === path[i])[0];
        if (!prop) {
            return undefined;
        }
        obj = prop.value;
    }

    // frame.debuggerModel.target().debuggerAgent()
    let result = await scope.object()._runtimeAgent.invoke_callFunctionOn({
        objectId: obj._objectId,
        functionDeclaration: fncDeclaration.toString(),
        arguments: fncArguments,
        silent: true,
        returnByValue: true
    });
    if("result" in result) {
        return result.result.value;
    }
    if(Protocol.Error in result) {
        return result[Protocol.Error];
    }
    console.log(result);
    return result.error;
}

async function generateWasmDebugObj(frame) {
    let scopeChain = frame.scopeChain();

    if (scopeChain.length === 0) {
        return {
            explicitError: { type: "error", title: "No scope", message: `The scope chain was empty, which we rely on to display information` }
        };
    }

    let callStack = frame.debuggerModel.callFrames.map(x => ({
        functionName: x.functionName,
        scriptId: x._script.scriptId,
        //guessedFunctionName: (/func \$([^\(]+) \(/g.exec(x._script._source || "") || {})[1] || "",
        guessedFunctionName: (x._payload.functionName.match(/[^\(]+/g) || {})[0],
        lineNumber: x._location.lineNumber,
        columnNumber: x._location.columnNumber,
        sourceURL: x._script.sourceURL,
    }));
    let curCallstackIndex = frame.debuggerModel.callFrames.indexOf(frame);

    let local = scopeChain.filter(x => x._type === "local")[0];
    let global = scopeChain.filter(x => x._type === "global")[0];

    // We need to do the work in the js environment, so we don't need to copy the wasm memory (which could easily be hundreds of megabytes),
    //  into our environment, every time we want to display the callstack...
    await evaluateAtPath(local, [], [], function () { return window.callstackLocal = this || window.callstackLocal; });
    await evaluateAtPath(global, [], [], function () { return window.callstackGlobal = this || window.callstackGlobal; });

    /** @type {
            { thrownError: { message: string; stack: string; } }
            | { explicitError: { type: "message"|"info"|"warn"|"success"|"error"; title: string; message: string; } }
            | { result: unknown; message: string; statusOverride?: string; }
        }
    */
    let parsedObj = await evaluateAtPath(global, [], [
        SDK.RemoteObject.toCallArgument(JSON.stringify(callStack)),
        SDK.RemoteObject.toCallArgument(curCallstackIndex)
    ], function (callStackJson, curCallstackIndex) {
        /** @type {{ functionName: string; scriptId: string; guessedFunctionName: string; lineNumber: number; columnNumber: number; }[]} */
        let callStack = JSON.parse(callStackJson);

        /** @type {{memory: Uint8Array; globals: { [name: string]: number }}} */
        let globalObj = window.callstackGlobal;
        /** @type {{locals: { [name: string]: number }}} */
        let localObj = window.callstackLocal;

        /** @type {{ binary: Uint8Array; module: { instance: unknown; module: unknown; } }[]} */
        let wasmModules = window.wasmModules;

        /** @type {
            {
                binary: Uint8Array;
                module: { instance: unknown; module: unknown; };
                fncs: {
                    name: string;
                    file: string;
                    line: number;
                    endLine: number;
                    instStart: number;
                    instEnd: number;
                    parameters: {}[];
                }[];
                dwarfErrorTitle: string;
                dwarfStatus: string;
                dwarfErrorMessage: string;
                dwarfParsedMessage: string;
                codeOffset: number;
            }[]
        }*/
        let wasmStack = window.wasmStack;

        if (!wasmStack) { return { explicitError: { type: "error", title: "Not patched, refresh page", message: `window.wasmStack not found. TRY REFRESHING WITH DEV TOOLS OPEN. Our patch function should have created this, so maybe our patching failed.` } }; }
        if (!globalObj) { return { explicitError: { type: "error", title: "Not patched, refresh page", message: `window.callstackGlobal not found. TRY REFRESHING WITH DEV TOOLS OPEN. ur patch function should have created this, so maybe our patching failed.` } }; }
        if (!localObj) { return { explicitError: { type: "error", title: "Not patched, refresh page", message: `window.callstackLocal not found. TRY REFRESHING WITH DEV TOOLS OPEN. ur patch function should have created this, so maybe our patching failed.` } }; }
        if (!wasmModules) { return { explicitError: { type: "error", title: "Not patched, refresh page", message: `window.wasmModules not found. TRY REFRESHING WITH DEV TOOLS OPEN. ur patch function should have created this, so maybe our patching failed.` } }; }

        let curWasm = wasmStack.slice(-1)[0];
        if (!curWasm) {
            return { explicitError: { type: "error", title: "Wasm stack empty", message: `window.wasmStack was empty. If we are in a WebAssembly function this should have been populated. Our patching must have failed.` } };
        }
        if(curWasm.dwarfErrorTitle) {
            return { explicitError: { type: "error", title: curWasm.dwarfErrorTitle, message: curWasm.dwarfErrorMessage } };
        }
        if (curWasm.fncs.length <= 0) {
            return { explicitError: { type: "warn", title: "Function not found", message: `No functions were found inside the dwarf file. This is odd...` } };
        }

        let curStack = callStack[curCallstackIndex];

        function run() {
            let curFnc;
            {
                curStack.scriptId
                if (curStack.lineNumber !== 0
                    //|| curFnc.fncs.some(x => x.name === curStack.guessedFunctionName)
                    ) {
                    // TODO: This means there is no sourcemap, so... this is a line number in the generated WAST file (for the specific function).
                    //  This is decipherable, but... very annoying. Surely this has to be a way to get the underlying byte offset?
                    if (curStack.guessedFunctionName) {
                        let fnc = curWasm.fncs.filter(x => x.name === curStack.guessedFunctionName)[0];
                        if (!fnc) {
                            return { explicitError: { type: "warn", title: "Function not found", message: `Assumed we are in a WAST file for function ${curStack.guessedFunctionName}, but we can't find that function. Found functions ${JSON.stringify(curWasm.fncs.map(x => x.name))}. File ${curStack.sourceURL}` } };
                        }
                        curFnc = fnc;
                    } else {
                        return { explicitError: { type: "warn", title: "Function name not found", message: `Stack shows a line number !== 0, and we can figure out the function name. This is not supported (we can't figure out what wasm instruction we are running). File ${curStack.sourceURL}` } };
                    }
                } else {
                    let index = binarySearch(curWasm.fncs, { low_pc: curStack.columnNumber - curWasm.codeOffset}, x => x.low_pc || 0);
                    if (index < 0) {
                        index = ~index - 1;
                    }
                    curFnc = curWasm.fncs[index];
                    if(!curFnc) {
                        return { explicitError: { type: "warn", title: "Function not found", message: `Looked for wasm byte offset ${curStack.columnNumber - curWasm.codeOffset}. File ${curStack.sourceURL}` } };
                    }
                }
            }


            // TODO: When chrome eventually supports giving us i64 values (as bigints) then we will have to start
            //  supporting writing bigints to memory. But that might take years, so we'll just wait...
            //  (we still need 8 bytes for 64 bit floating pointer numbers though, as chrome supports those...)
            function getExpandedValue(type, valueOrDataView, pos, isMaybeAnArray) {
                let value = valueOrDataView;
                if (typeof value === "object") {
                    if (value.byteOffset !== 0) {
                        throw new Error(`Value should be a DataView starting the beginning of the code, so our pointers are direct reads without changing the offset. Data view started at ${value.byteOffset}`);
                    }
                }
                if (type.tagName === "DW_TAG_base_type") {
                    let typeName = type.name;

                    if (typeof value === "object") {

                        let buffer = value.buffer;
                        let end = pos + type.byte_size;
                        if (end > buffer.length) {
                            return `Invalid value, accessing ending at 0x${(end - type.byte_size).toString(16)} to 0x${end.toString(16)}, buffer end of 0x${buffer.length.toString(16)}`;
                        }

                        if (type.encodingName === "signed_char" && isMaybeAnArray) {
                            let maxToRead = Math.min(100, value.byteLength - pos);
                            let bytes = [];
                            let hasNull = false;
                            for (let i = 0; i < maxToRead; i++) {
                                let b = value.getUint8(pos + i);
                                if (b === 0) {
                                    hasNull = true;
                                    break;
                                }
                                bytes.push(b);
                            }
                            value = new TextDecoder().decode(new Uint8Array(bytes));
                            if (!hasNull) {
                                value += " (NO NULL)";
                            }
                        }
                        else if (type.encodingName === "float") {
                            if (type.byte_size === 8) {
                                value = value.getFloat64(pos, true);
                            } else if (type.byte_size === 4) {
                                value = value.getFloat32(pos, true);
                            } else {
                                return `Unsupported floating point byte size of ${type.byte_size}`;
                            }
                        } else {
                            if (type.byte_size === 8) {
                                if (type.encodingName.includes("signed")) {
                                    value = value.getBigInt64(pos, true);
                                } else {
                                    value = value.getBigUint64(pos, true);
                                }
                            } else if (type.byte_size === 4) {
                                if (type.encodingName.includes("signed")) {
                                    value = value.getInt32(pos, true);
                                } else {
                                    value = value.getUint32(pos, true);
                                }
                            } else if (type.byte_size === 2) {
                                if (type.encodingName.includes("signed")) {
                                    value = value.getInt16(pos, true);
                                } else {
                                    value = value.getUint16(pos, true);
                                }
                            } else if (type.byte_size === 1) {
                                if (type.encodingName.includes("signed")) {
                                    value = value.getInt8(pos, true);
                                } else {
                                    value = value.getUint8(pos, true);
                                }
                            } else {
                                return `Unsupported integer byte size of ${type.byte_size}`;
                            }
                        }
                    }

                    if(isMaybeAnArray) {
                        typeName += "*";
                    }

                    let result = `(${typeName}) ${value}`;

                    if(isMaybeAnArray) {
                        result += ` (0x${pos.toString(16)})`;
                    }
                    return result;
                    //return `${value}, ${type.encodingName}, ${type.byte_size}, ${type.name}`;
                } else if (type.tagName === "DW_TAG_structure_type") {
                    if (typeof value !== "object") {
                        // Ugh... root level, we should be wrapped with a pointer, but for some reason the dwarf info for
                        //  a struct by value and a struct by pointer are the same (and both by pointer).
                        return getExpandedValue({
                            tagName: "DW_TAG_pointer_type",
                            type_resolved: type
                        }, value, pos);
                    }

                    let obj = {};
                    obj.OBJECT_DISPLAY_NAME = type.name;
                    // 4 means reference type (as opposed to being a value)
                    if (type.calling_convention === 4) {
                        obj.OBJECT_DISPLAY_NAME = "&" + obj.OBJECT_DISPLAY_NAME;
                    }
                    obj.OBJECT_DISPLAY_NAME += ` (0x${pos.toString(16)})`;

                    for (let childType of (type.children || [])) {
                        let buffer = value.buffer;
                        let childPos = pos + childType.data_member_location;
                        if (childPos >= buffer.byteLength) {
                            obj[childType.name] = `Invalid struct pointer, accessing 0x${childPos.toString(16)}, max of 0x${buffer.byteLength.toString(16)}`;
                        } else {
                            obj[childType.name] = getExpandedValue(
                                childType.type_resolved,
                                value,
                                childPos
                            );
                        }
                    }
                    return obj;

                } else if (type.tagName === "DW_TAG_pointer_type") {
                    // Hey, it's a pointer. We dereference pointers, right??? Pointers are never just arrays, right??? Ugh... C++ is broken.
                    //  At least have type arrays, that are erased as compile time but indicate it isn't just a pointer...
                    // What do structs look like?

                    // Assuming 32 bit here...
                    if (typeof value === "object") {
                        value = value.getUint32(pos, true);
                    }

                    let buffer = new DataView(globalObj.memory.buffer, 0);
                    if (value >= buffer.byteLength) {
                        let errMsg = `Invalid pointer, accessing 0x${value.toString(16)}, max of 0x${buffer.byteLength.toString(16)}`;
                        return errMsg;
                    }
                    return getExpandedValue(type.type_resolved, buffer, value, true);
                } else if (
                    // Just unwrap anything we don't understand
                    "type_resolved" in type
                ) {
                    return getExpandedValue(type.type_resolved, valueOrDataView, pos, isMaybeAnArray);
                }

                return `unhandled tag ${type.tagName} (value ${value})`;
            }

            let argsLookup = {};
            for (let i = 0; i < curFnc.parameters.length; i++) {
                let param = curFnc.parameters[i];
                let value = localObj.locals[`arg#${i}`];
                let name = param.name;

                if (name in argsLookup) {
                    let index = 1;
                    while ((name + index).toString() in argsLookup) {
                        index++;
                    }
                    name = name + index;
                }

                argsLookup[name] = getExpandedValue(param.type_resolved, value, 0);
            }
            console.log("fnc", curFnc, localObj, argsLookup);
            window.wasmLastFnc = curFnc;
            return { result: argsLookup, message: curWasm.dwarfParsedMessage, statusOverride: curWasm.dwarfStatus };
        }

        window.wasmRunLastParse = () => {
            debugger;
            run();
        };

        try {
            return run();
        } catch (e) {
            console.log("error", e);
            return { thrownError: { message: e.message, stack: e.stack } };
        }


        function binarySearch(list, value, map) {
            let comparer = (a, b) => map(a) - map(b);
            let minIndex = 0;
            let maxIndex = list.length;
            while (minIndex < maxIndex) {
                let fingerIndex = ~~((maxIndex + minIndex) / 2);
                //if (fingerIndex >= list.length) return ~fingerIndex;
                let finger = list[fingerIndex];
                let comparisonValue = comparer(value, finger);
                if (comparisonValue < 0) {
                    maxIndex = fingerIndex;
                }
                else if (comparisonValue > 0) {
                    minIndex = fingerIndex + 1;
                }
                else {
                    return fingerIndex;
                }
            }
            return ~minIndex;
        }
    });

    return parsedObj;
}

function isWasm(url) {
    return url.startsWith("wasm://") || url.startsWith("wasm-");
}



/**
 * @implements {UI.ContextFlavorListener.ContextFlavorListener}
 * @unrestricted
 */
export class ScopeChainSidebarPaneBase extends UI.Widget.VBox {
  constructor() {
    super(true);
    this.registerRequiredCSS('sources/scopeChainSidebarPane.css');
    this._treeOutline = new ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeOutline();
    this._treeOutline.registerRequiredCSS('sources/scopeChainSidebarPane.css');
    this._treeOutline.setShowSelectionOnKeyboardFocus(/* show */ true);
    this._expandController =
        new ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeExpandController(this._treeOutline);
    this._linkifier = new Components.Linkifier.Linkifier();
    this._infoElement = createElement('div');
    this._infoElement.className = 'gray-info-message';
    this._infoElement.textContent = ls`Not paused`;
    this._infoElement.tabIndex = -1;
    this._update();
  }

  /**
   * @override
   * @param {?Object} object
   */
  flavorChanged(object) {
    this._update();
  }

  /**
   * @override
   */
  focus() {
    if (this.hasFocus()) {
      return;
    }

    if (self.UI.context.flavor(SDK.DebuggerModel.DebuggerPausedDetails)) {
      this._treeOutline.forceSelect();
    }
  }

  _getScopeChain(callFrame) {
    return [];
  }

  _update() {
    const callFrame = self.UI.context.flavor(SDK.DebuggerModel.CallFrame);
    const details = self.UI.context.flavor(SDK.DebuggerModel.DebuggerPausedDetails);
    this._linkifier.reset();
    resolveThisObject(callFrame).then(this._innerUpdate.bind(this, details, callFrame));
  }

  /**
   * @param {?SDK.DebuggerModel.DebuggerPausedDetails} details
   * @param {?SDK.DebuggerModel.CallFrame} callFrame
   * @param {?SDK.RemoteObject.RemoteObject} thisObject
   */
  _innerUpdate(details, callFrame, thisObject) {
    this._treeOutline.removeChildren();
    this.contentElement.removeChildren();

    if (!details || !callFrame) {
      this.contentElement.appendChild(this._infoElement);
      return;
    }

    this.contentElement.appendChild(this._treeOutline.element);
    let foundLocalScope = false;
    const scopeChain = this._getScopeChain(callFrame);
    if (scopeChain) {
      for (let i = 0; i < scopeChain.length; ++i) {
        const scope = scopeChain[i];
        const extraProperties = this._extraPropertiesForScope(scope, details, callFrame, thisObject, i === 0);

        if (scope.type() === Protocol.Debugger.ScopeType.Local) {
          foundLocalScope = true;
        }

        const section = this._createScopeSectionTreeElement(scope, extraProperties);
        if (scope.type() === Protocol.Debugger.ScopeType.Global) {
          section.collapse();
        } else if (!foundLocalScope || scope.type() === Protocol.Debugger.ScopeType.Local) {
          section.expand();
        }

        this._treeOutline.appendChild(section);
        if (i === 0) {
          section.select(/* omitFocus */ true);
        }
      }
    }
    this._sidebarPaneUpdatedForTest();
  }

  /**
   * @param {!SDK.DebuggerModel.Scope} scope
   * @param {!Array.<!SDK.RemoteObject.RemoteObjectProperty>} extraProperties
   * @return {!ObjectUI.ObjectPropertiesSection.RootElement}
   */
  _createScopeSectionTreeElement(scope, extraProperties) {
    let emptyPlaceholder = null;
    if (scope.type() === Protocol.Debugger.ScopeType.Local || Protocol.Debugger.ScopeType.Closure) {
      emptyPlaceholder = ls`No variables`;
    }

    let title = scope.typeName();
    if (scope.type() === Protocol.Debugger.ScopeType.Closure) {
      const scopeName = scope.name();
      if (scopeName) {
        title = ls`Closure (${UI.UIUtils.beautifyFunctionName(scopeName)})`;
      } else {
        title = ls`Closure`;
      }
    }
    let subtitle = scope.description();
    if (!title || title === subtitle) {
      subtitle = undefined;
    }

    const titleElement = createElementWithClass('div', 'scope-chain-sidebar-pane-section-header tree-element-title');
    titleElement.createChild('div', 'scope-chain-sidebar-pane-section-subtitle').textContent = subtitle;
    titleElement.createChild('div', 'scope-chain-sidebar-pane-section-title').textContent = title;

    const section = new ObjectUI.ObjectPropertiesSection.RootElement(
        resolveScopeInObject(scope), this._linkifier, emptyPlaceholder,
        /* ignoreHasOwnProperty */ true, extraProperties);
    section.title = titleElement;
    section.listItemElement.classList.add('scope-chain-sidebar-pane-section');
    this._expandController.watchSection(title + (subtitle ? ':' + subtitle : ''), section);

    return section;
  }

  /**
   * @param {!SDK.DebuggerModel.Scope} scope
   * @param {?SDK.DebuggerModel.DebuggerPausedDetails} details
   * @param {?SDK.DebuggerModel.CallFrame} callFrame
   * @param {?SDK.RemoteObject.RemoteObject} thisObject
   * @param {boolean} isFirstScope
   * @return {!Array.<!SDK.RemoteObject.RemoteObjectProperty>}
   */
  _extraPropertiesForScope(scope, details, callFrame, thisObject, isFirstScope) {
    if (scope.type() !== Protocol.Debugger.ScopeType.Local) {
      return [];
    }

    const extraProperties = [];
    if (thisObject) {
      extraProperties.push(new SDK.RemoteObject.RemoteObjectProperty('this', thisObject));
    }
    if (isFirstScope) {
      const exception = details.exception();
      if (exception) {
        extraProperties.push(new SDK.RemoteObject.RemoteObjectProperty(
            Common.UIString.UIString('Exception'), exception, undefined, undefined, undefined, undefined, undefined,
            /* synthetic */ true));
      }
      const returnValue = callFrame.returnValue();
      if (returnValue) {
        extraProperties.push(new SDK.RemoteObject.RemoteObjectProperty(
            Common.UIString.UIString('Return value'), returnValue, undefined, undefined, undefined, undefined,
            undefined,
            /* synthetic */ true, callFrame.setReturnValue.bind(callFrame)));
      }
    }

    return extraProperties;
  }

  _sidebarPaneUpdatedForTest() {
  }
}

/**
 * @unrestricted
 */
export class SourceScopeChainSidebarPane extends ScopeChainSidebarPaneBase {
  constructor() {
    super();
  }
  /**
   * @override
   */
  _getScopeChain(callFrame) {
    return callFrame.sourceScopeChain;
  }
}

/**
 * @unrestricted
 */
export class ScopeChainSidebarPane extends ScopeChainSidebarPaneBase {
  /**
   * @override
   */
  _getScopeChain(callFrame) {
    return callFrame.scopeChain();
  }
}


export const pathSymbol = Symbol('path');
