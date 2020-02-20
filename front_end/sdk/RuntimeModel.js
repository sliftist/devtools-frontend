/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import * as Common from '../common/common.js';
import * as Host from '../host/host.js';
import * as ProtocolModule from '../protocol/protocol.js';

import {DebuggerModel, FunctionDetails} from './DebuggerModel.js';  // eslint-disable-line no-unused-vars
import {HeapProfilerModel} from './HeapProfilerModel.js';
import {RemoteFunction, RemoteObject,
        RemoteObjectImpl,  // eslint-disable-line no-unused-vars
        RemoteObjectProperty, ScopeRef, ScopeRemoteObject,} from './RemoteObject.js';  // eslint-disable-line no-unused-vars
import {Capability, SDKModel, Target, Type} from './SDKModel.js';  // eslint-disable-line no-unused-vars

function setBreakOnStart(enabled, optionalExecutionContext) {
  SDK.domDebuggerManager._eventListenerBreakpoints.filter(x => x._instrumentationName === "scriptFirstStatement")[0].setEnabled(enabled);
  if(optionalExecutionContext) {
    let agent = optionalExecutionContext.debuggerModel._agent._target._modelByConstructor.get(SDK.DOMDebuggerModel)._agent;
    if(agent.addInstrumentationBreakpoint) {
      if(enabled) {
        agent.addInstrumentationBreakpoint("scriptFirstStatement");
      } else {
        agent.removeInstrumentationBreakpoint("scriptFirstStatement");
      }
    }
  }
}

function runCodeInTarget(executionContext, args, fnc) {
  let executionContextId = executionContext.id;
  return executionContext.runtimeModel._agent.invoke_callFunctionOn({
    executionContextId,
    functionDeclaration: fnc.toString(),
    arguments: args,
    silent: false,
    returnByValue: true
  });
}

// We need to patch all WebAssembly functions, so we can know what WebAssembly module is currently running,
//  and what the original WebAssembly source was. We also parse that source here.
// This code is injected into the browser, as it maybe too performance intensive to stream the WebAssembly source
//  back to devtools.
function webAssemblyInjected() {
  async function recordModule(binary, module) {
    if(!(binary instanceof Uint8Array)) {
      binary = new Uint8Array(binary);
    }
    let curBuffer;
    let curIndex;
    function parseNum(size, isSigned = false, bigEndian = false) {
        let num = parseNumBase(curBuffer, curIndex, size, isSigned, bigEndian);
        curIndex += size;
        return num;
    }
    function parseNumBase(buffer, index, size, isSigned, bigEndian) {
        let values = buffer.slice(index, index + size);
        if (!bigEndian) {
            values.reverse();
        }
        let value = 0;
        let magnitude = 1;
        for (let i = 0; i < values.length; i++) {
            let curValue = values[i] * magnitude;
            magnitude = magnitude << 8;
            let negative = false;
            if (i === values.length - 1 && isSigned) {
                negative = !!(curValue & 0x80);
            }
            value += curValue;
            if (negative) {
                value = -((magnitude) - value);
            }
        }
        return value;
    }
    function parseCString() {
        let str = "";
        while (curIndex < curBuffer.length) {
            let byte = curBuffer[curIndex++];
            if (byte === 0)
                break;
            str += String.fromCharCode(byte);
        }
        return str;
    }
    function parseCSequence() {
        let cstrs = [];
        while (true) {
            let cstr = parseCString();
            if (cstr === "")
                break;
            cstrs.push(cstr);
        }
        return cstrs;
    }
    function parseLeb128(signed = false) {
        let obj = leb128Parse(curIndex, curBuffer);
        curIndex += obj.bytes.length;
        if (signed) {
            let negativePoint = 1 << (7 * obj.bytes.length - 1);
            if (obj.value >= negativePoint) {
                obj.value = obj.value - 2 * negativePoint;
            }
        }
        return obj.value;
    }
    function getNameValueSections(sections) {
        let nameValueSections = {};
        for (let section of sections) {
            let { sectionId, contents } = section;
            if (sectionId === 0) {
                let length = contents[0];
                let name = String.fromCharCode.apply(null, new Uint8Array(contents.slice(1, 1 + length))); //getString(i, file);
                let value = contents.slice(1 + length);
                nameValueSections[name] = value;
            }
        }
        return nameValueSections;
    }
    function getDwarfSections(file, baseOffsetInSource) {
        curBuffer = file;
        curIndex = 0;
        let sections = [];
        while (curIndex < curBuffer.length) {
            let offsetInSource = baseOffsetInSource;
            let sectionLength = parseNum(4, undefined, true);
            let currentEnd = curIndex + sectionLength;
            let version = parseNum(2, undefined, true);
            let header_length = parseNum(4, undefined, true);
            let mininum_instruction_length = parseNum(1);
            let maximum_operations_per_instruction = parseNum(1);
            let default_is_stmt = parseNum(1);
            if (mininum_instruction_length !== 1) {
                throw new Error(`mininum_instruction_lengths !== 1 are not supported ${mininum_instruction_length}`);
            }
            let line_base = parseNum(1, true);
            let line_range = parseNum(1);
            let opcode_base = parseNum(1);
            let standard_opcode_lengths = [];
            for (let i = 0; i < opcode_base - 1; i++) {
                standard_opcode_lengths.push(parseNum(1));
            }
            let include_directories = parseCSequence();
            let file_names = [];
            while (true) {
                let file_name = parseCString();
                if (file_name === "")
                    break;
                let directory_index = parseLeb128();
                let last_modified_time = parseLeb128();
                let file_length = parseLeb128();
                file_names.push({
                    file_name,
                    directory_index,
                    last_modified_time,
                    file_length
                });
            }
            let instructions = curBuffer.slice(curIndex, currentEnd);
            curIndex = currentEnd;
            let section = {
                offsetInSource: offsetInSource,
                version,
                mininum_instruction_length,
                maximum_operations_per_instruction,
                default_is_stmt,
                line_base,
                line_range,
                opcode_base,
                standard_opcode_lengths,
                include_directories,
                file_names,
                fullFilePaths: file_names.map(x => {
                    let dir;
                    if (x.directory_index === 0) {
                        // "The index is 0 if the file was found in the current directory of the compilation"
                        dir = "./";
                    }
                    else {
                        dir = include_directories[x.directory_index - 1] + "/";
                    }
                    return dir + x.file_name;
                }),
                instructions
            };
            sections.push(section);
            curIndex = currentEnd;
        }
        return sections;
    }
    function pad(str, count, char = "0") {
        str = str + "";
        while (str.length < count) {
            str = char + str;
        }
        return str;
    }
    function leb128Parse(index, buffer) {
        let bytes = [];
        while (index < buffer.length) {
            let byte = buffer[index++];
            bytes.push(byte);
            if (!(byte & 0x80)) {
                break;
            }
        }
        let value = Number.parseInt(bytes.reverse().map(x => pad(x.toString(2), 8).slice(1)).join(""), 2);
        return {
            value,
            bytes,
        };
    }
    function getSections(file) {
        let sections = [];
        sections.push({
            sectionId: -1,
            offset: 0,
            contents: file.slice(0, 8)
        });
        let i = 8;
        while (i < file.length) {
            let sectionId = file[i];
            i++;
            let { value, bytes } = leb128Parse(i, file);
            let num = value;
            i += bytes.length;
            let baseOffsetStart = i;
            let contents = file.slice(i, i + num);
            sections.push({
                sectionId,
                offset: baseOffsetStart,
                contents
            });
            i += num;
        }
        return sections;
    }
    function getDwarfAbbrevs(
        filePaths, debug_str, debug_abbrev, debug_info
    ) {
        // #region Implementation
        let debugStrings = [];
        function parseCStringAt(offset) {
            let pos = offset;
            let buffer = debug_str;
            let str = "";
            while (pos < buffer.length) {
                let ch = buffer[pos++];
                if (ch === 0)
                    break;
                str += String.fromCharCode(ch);
            }
            return str;
        }
        {
            curIndex = 0;
            curBuffer = debug_str;
            while (curIndex < curBuffer.length) {
                debugStrings.push(parseCString());
            }
        }
        function getDwTagName(tag) {
            const tags = { [0x01]: "DW_TAG_array_type", [0x02]: "DW_TAG_class_type", [0x03]: "DW_TAG_entry_point", [0x04]: "DW_TAG_enumeration_type", [0x05]: "DW_TAG_formal_parameter", [0x08]: "DW_TAG_imported_declaration", [0x0a]: "DW_TAG_label", [0x0b]: "DW_TAG_lexical_block", [0x0d]: "DW_TAG_member", [0x0f]: "DW_TAG_pointer_type", [0x10]: "DW_TAG_reference_type", [0x11]: "DW_TAG_compile_unit", [0x12]: "DW_TAG_string_type", [0x13]: "DW_TAG_structure_type", [0x15]: "DW_TAG_subroutine_type", [0x16]: "DW_TAG_typedef", [0x17]: "DW_TAG_union_type", [0x18]: "DW_TAG_unspecified_parameters", [0x19]: "DW_TAG_variant", [0x1a]: "DW_TAG_common_block", [0x1b]: "DW_TAG_common_inclusion", [0x1c]: "DW_TAG_inheritance", [0x1d]: "DW_TAG_inlined_subroutine", [0x1e]: "DW_TAG_module", [0x1f]: "DW_TAG_ptr_to_member_type", [0x20]: "DW_TAG_set_type", [0x21]: "DW_TAG_subrange_type", [0x22]: "DW_TAG_with_stmt", [0x23]: "DW_TAG_access_declaration", [0x24]: "DW_TAG_base_type", [0x25]: "DW_TAG_catch_block", [0x26]: "DW_TAG_const_type", [0x27]: "DW_TAG_constant", [0x28]: "DW_TAG_enumerator", [0x29]: "DW_TAG_file_type", [0x2a]: "DW_TAG_friend", [0x2b]: "DW_TAG_namelist", [0x2c]: "DW_TAG_namelist_item", [0x2d]: "DW_TAG_packed_type", [0x2e]: "DW_TAG_subprogram", [0x2f]: "DW_TAG_template_type_parameter", [0x30]: "DW_TAG_template_value_parameter", [0x31]: "DW_TAG_thrown_type", [0x32]: "DW_TAG_try_block", [0x33]: "DW_TAG_variant_part", [0x34]: "DW_TAG_variable", [0x35]: "DW_TAG_volatile_type", [0x36]: "DW_TAG_dwarf_procedure", [0x37]: "DW_TAG_restrict_type", [0x38]: "DW_TAG_interface_type", [0x39]: "DW_TAG_namespace", [0x3a]: "DW_TAG_imported_module", [0x3b]: "DW_TAG_unspecified_type", [0x3c]: "DW_TAG_partial_unit", [0x3d]: "DW_TAG_imported_unit", [0x3f]: "DW_TAG_condition", [0x40]: "DW_TAG_shared_type", [0x41]: "DW_TAG_type_unit", [0x42]: "DW_TAG_rvalue_reference_type", [0x43]: "DW_TAG_template_alias", };
            if (tag in tags) {
                return tags[tag];
            }
            if (tag >= 0x4080 && tag <= 0xffff) {
                return `DW_TAG_user_${tag}`;
            }
            return `DW_TAG_invalid_${tag}`;
        }
        function getDwForm(form, tagName) {
            function parseBlock(sizeSize) {
                let size = parseNum(sizeSize, false, true);
                let buffer = curBuffer.slice(curIndex, curIndex + size);
                curIndex += size;
                return buffer;
            }
            function parseVarBlock() {
                let size = parseLeb128();
                let buffer = curBuffer.slice(curIndex, curIndex + size);
                curIndex += size;
                return buffer;
            }
            function parseBytes(size) {
                let buffer = curBuffer.slice(curIndex, curIndex + size);
                curIndex += size;
                return buffer;
            }
            let forms = {
              [0x01]: { name: "DW_FORM_addr", parse: () => parseNum(4, false, true) },
              [0x03]: { name: "DW_FORM_block2", parse: () => parseBlock(2) },
              [0x04]: { name: "DW_FORM_block4", parse: () => parseBlock(4) },
              [0x05]: { name: "DW_FORM_data2", parse: () => parseNum(2, false, true) },
              [0x06]: { name: "DW_FORM_data4", parse: () => parseNum(4, false, true) },
              [0x07]: { name: "DW_FORM_data8", parse: () => parseBytes(8) },
              [0x08]: { name: "DW_FORM_string", parse: () => parseCString() },
              [0x09]: { name: "DW_FORM_block", parse: () => parseVarBlock() },
              [0x0a]: { name: "DW_FORM_block1", parse: () => parseBlock(1) },
              [0x0b]: { name: "DW_FORM_data1", parse: () => parseNum(1, false, true) },
              [0x0c]: { name: "DW_FORM_flag", parse: () => parseNum(1, false, true) },
              [0x0d]: { name: "DW_FORM_sdata", parse: () => parseVarBlock() },
              [0x0e]: { name: "DW_FORM_strp", parse: () => parseCStringAt(parseNum(4, false, true)) },
              [0x0f]: { name: "DW_FORM_udata", parse: () => parseLeb128() },
              [0x10]: { name: "DW_FORM_ref_addr", parse: () => parseNum(4, false, true) },
              [0x11]: { name: "DW_FORM_ref1", parse: () => parseNum(1, false, true) },
              [0x12]: { name: "DW_FORM_ref2", parse: () => parseNum(2, false, true) },
              [0x13]: { name: "DW_FORM_ref4", parse: () => parseNum(4, false, true) },
              [0x14]: { name: "DW_FORM_ref8", parse: () => parseBytes(8) },
              [0x15]: { name: "DW_FORM_ref_udata", parse: () => parseVarBlock() },
              [0x16]: { name: "DW_FORM_indirect", parse: () => getDwForm(parseLeb128(), tagName) },
              [0x17]: { name: "DW_FORM_sec_offset", parse: () => parseNum(4, false, true) },
              [0x18]: { name: "DW_FORM_exprloc", parse: () => parseVarBlock() },
              [0x19]: { name: "DW_FORM_flag_present", parse: () => true },
              [0x20]: { name: "DW_FORM_ref_sig8", parse: () => parseBytes(8) },
            };
            if (form in forms) {
                let formObj = forms[form];
                // If high is a constant, then it is an offset from DW_AT_low_pc
                if(tagName === "DW_AT_high_pc" && (formObj.name.startsWith("DW_FORM_data"))) {
                  let baseParse = formObj.parse;
                  formObj.parse = function(values) {
                      let result = baseParse.apply(this, arguments) + values.low_pc;
                      return result;
                  };
                }
                return formObj;
            }
            throw new Error(`Unsupported form type ${form}`);
        }
        const dwAttributeNameLookup = { [0x01]: "DW_AT_sibling",[0x02]: "DW_AT_location",[0x03]: "DW_AT_name",[0x09]: "DW_AT_ordering",[0x0b]: "DW_AT_byte_size",[0x0c]: "DW_AT_bit_offset",[0x0d]: "DW_AT_bit_size",[0x10]: "DW_AT_stmt_list",[0x11]: "DW_AT_low_pc",[0x12]: "DW_AT_high_pc",[0x13]: "DW_AT_language",[0x15]: "DW_AT_discr",[0x16]: "DW_AT_discr_value",[0x17]: "DW_AT_visibility",[0x18]: "DW_AT_import",[0x19]: "DW_AT_string_length",[0x1a]: "DW_AT_common_reference",[0x1b]: "DW_AT_comp_dir",[0x1c]: "DW_AT_const_value",[0x1d]: "DW_AT_containing_type",[0x1e]: "DW_AT_default_value",[0x20]: "DW_AT_inline",[0x21]: "DW_AT_is_optional",[0x22]: "DW_AT_lower_bound",[0x25]: "DW_AT_producer",[0x27]: "DW_AT_prototyped",[0x2a]: "DW_AT_return_addr",[0x2c]: "DW_AT_start_scope",[0x2e]: "DW_AT_stride_size",[0x2f]: "DW_AT_upper_bound",[0x31]: "DW_AT_abstract_origin",[0x32]: "DW_AT_accessibility",[0x33]: "DW_AT_address_class",[0x34]: "DW_AT_artificial",[0x35]: "DW_AT_base_types",[0x36]: "DW_AT_calling_convention",[0x37]: "DW_AT_count",[0x38]: "DW_AT_data_member_location",[0x39]: "DW_AT_decl_column",[0x3a]: "DW_AT_decl_file",[0x3b]: "DW_AT_decl_line",[0x3c]: "DW_AT_declaration",[0x3d]: "DW_AT_discr_list",[0x3e]: "DW_AT_encoding",[0x3f]: "DW_AT_external",[0x40]: "DW_AT_frame_base",[0x41]: "DW_AT_friend",[0x42]: "DW_AT_identifier_case",[0x44]: "DW_AT_namelist_item",[0x45]: "DW_AT_priority",[0x46]: "DW_AT_segment",[0x47]: "DW_AT_specification",[0x48]: "DW_AT_static_link",[0x49]: "DW_AT_type",[0x4a]: "DW_AT_use_location",[0x4b]: "DW_AT_variable_parameter",[0x4c]: "DW_AT_virtuality",[0x4d]: "DW_AT_vtable_elem_location",[0x4e]: "DW_AT_allocated",[0x4f]: "DW_AT_associated",[0x50]: "DW_AT_data_location",[0x51]: "DW_AT_byte_stride",[0x52]: "DW_AT_entry_pc",[0x53]: "DW_AT_use_UTF8",[0x54]: "DW_AT_extension",[0x55]: "DW_AT_ranges",[0x56]: "DW_AT_trampoline",[0x57]: "DW_AT_call_column",[0x58]: "DW_AT_call_file",[0x59]: "DW_AT_call_line",[0x5a]: "DW_AT_description",[0x5b]: "DW_AT_binary_scale",[0x5c]: "DW_AT_decimal_scale",[0x5d]: "DW_AT_small",[0x5e]: "DW_AT_decimal_sign",[0x5f]: "DW_AT_digit_count",[0x60]: "DW_AT_picture_string",[0x61]: "DW_AT_mutable",[0x62]: "DW_AT_threads_scaled",[0x63]: "DW_AT_explicit",[0x64]: "DW_AT_object_pointer",[0x65]: "DW_AT_endianity",[0x66]: "DW_AT_elemental",[0x67]: "DW_AT_pure",[0x68]: "DW_AT_recursive",[0x69]: "DW_AT_signature",[0x6a]: "DW_AT_main_subprogram",[0x6b]: "DW_AT_data_bit_offset",[0x6c]: "DW_AT_const_expr",[0x6d]: "DW_AT_enum_class",[0x6e]: "DW_AT_linkage_name",[0x6f]: "DW_AT_string_length_bit_size",[0x70]: "DW_AT_string_length_byte_size",[0x71]: "DW_AT_rank",[0x72]: "DW_AT_str_offsets_base",[0x73]: "DW_AT_addr_base",[0x74]: "DW_AT_rnglists_base",[0x76]: "DW_AT_dwo_name",[0x77]: "DW_AT_reference",[0x78]: "DW_AT_rvalue_reference",[0x79]: "DW_AT_macros",[0x7a]: "DW_AT_call_all_calls",[0x7b]: "DW_AT_call_all_source_calls",[0x7c]: "DW_AT_call_all_tail_calls",[0x7d]: "DW_AT_call_return_pc",[0x7e]: "DW_AT_call_value",[0x7f]: "DW_AT_call_origin",[0x80]: "DW_AT_call_parameter",[0x81]: "DW_AT_call_pc",[0x82]: "DW_AT_call_tail_call",[0x83]: "DW_AT_call_target",[0x84]: "DW_AT_call_target_clobbered",[0x85]: "DW_AT_call_data_location",[0x86]: "DW_AT_call_data_value",[0x87]: "DW_AT_noreturn",[0x88]: "DW_AT_alignment",[0x89]: "DW_AT_export_symbols",[0x8a]: "DW_AT_deleted",[0x8b]: "DW_AT_defaulted",[0x8c]: "DW_AT_loclists_base", };
        function getEncodingName(value) {
            if(value >= 0x80 && value <= 0xff) {
              return `user encoding 0x${value.toString(16)}`;
            }
            const lookup = { [0x01]: "DW_ATE_address", [0x02]: "DW_ATE_boolean", [0x03]: "DW_ATE_complex_float", [0x04]: "DW_ATE_float", [0x05]: "DW_ATE_signed", [0x06]: "DW_ATE_signed_char", [0x07]: "DW_ATE_unsigned", [0x08]: "DW_ATE_unsigned_char", [0x09]: "DW_ATE_imaginary_float", [0x0a]: "DW_ATE_packed_decimal", [0x0b]: "DW_ATE_numeric_string", [0x0c]: "DW_ATE_edited", [0x0d]: "DW_ATE_signed_fixed", [0x0e]: "DW_ATE_unsigned_fixed", [0x0f]: "DW_ATE_decimal_float", [0x10]: "DW_ATE_UTF", [0x11]: "DW_ATE_UCS", [0x12]: "DW_ATE_ASCII", };
            if(value in lookup) {
              return lookup[value].slice("DW_ATE_".length);
            }
            return `unknown encoding 0x${value.toString(16)}`;
        }
        let abbrevs = {};
        {
            curIndex = 0;
            curBuffer = debug_abbrev;
            while (true) {
                let code = parseLeb128();
                // After code is read, as the last code is 0
                if (curIndex === curBuffer.length)
                    break;
                let tag = parseLeb128();
                let hasChildren = !!curBuffer[curIndex++];
                // When we find null we go back up to the parent.
                let abbrev = { code, tag: getDwTagName(tag), attributes: [], hasChildren };
                while (true) {
                    let name = parseLeb128();
                    let form = parseLeb128();
                    if (name === 0 && form === 0) {
                        break;
                    }
                    if (!(name in dwAttributeNameLookup)) {
                        //throw new Error(`Unhandled attribute ${name.toString(16)}, for code ${code}`);
                    }
                    abbrev.attributes.push({
                        name: dwAttributeNameLookup[name] || ("0x" + name.toString(16)),
                        formType: form,
                        form: getDwForm(form, dwAttributeNameLookup[name] || String(name))
                    });
                }
                if (code in abbrevs) {
                    throw new Error(`Duplicate codes? ${code}`);
                }
                abbrevs[code] = abbrev;
            }
        }
        function instantiateAbbrev(abbrev) {
            let parsedAddress = curIndex - 1;
            let attributes = [];
            let values = {
              tagName: abbrev.tag
            };
            for (let att of abbrev.attributes) {
                let attValue = {
                    name: att.name,
                    formName: att.form.name,
                    formType: att.formType,
                    formValue: att.form.parse(values),
                    context: curBuffer.slice(curIndex, curIndex + 8),
                };
                values[attValue.name.slice("DW_AT_".length)] = attValue.formValue;
                if("encoding" in values) {
                  values.encodingName = getEncodingName(values.encoding);
                }
                attributes.push(attValue);
            }
            return {
                parsedAddress: parsedAddress,
                tag: abbrev.tag,
                hasChildren: abbrev.hasChildren,
                attributes,
                filePaths,
                values
            };
        }
        // #endregion Implementation
        curIndex = 0;
        curBuffer = debug_info;
        let unit_length = parseNum(4, false, true);
        let version = parseNum(2, false, true);
        let debug_abbrev_offset = parseNum(4, false, true);
        let addr_size = parseNum(1, false, true);
        //console.log({unit_length, version, debug_abbrev_offset, addr_size});
        //process.stdout.write("\n");
        let abbrevInsts = [];
        let curDepth = 0;
        let childrenStack = [];
        while (curIndex < curBuffer.length) {
            let code = parseLeb128();
            //console.log({code});
            // Hmm... if code === 0
            if (code === 0) {
                curDepth--;
                childrenStack.pop();
                //process.stdout.write("  NULL\n\n");
                continue;
            }
            // Attribute values
            if (!(code in abbrevs)) {
                console.error(`Unknown code ${code.toString(16)}`);
                break;
            }
            let info = abbrevs[code];
            let infoObj = instantiateAbbrev(info);
            if(childrenStack.length > 0) {
              let parent = childrenStack[childrenStack.length - 1];
              infoObj.values.parent = parent;
              parent.values.children.push(infoObj.values);
            }
            infoObj.values.depth = curDepth;
            abbrevInsts.push(infoObj);
            if(infoObj.hasChildren) {
              curDepth++;
              infoObj.values.children = [];
              childrenStack.push(infoObj);
            }
            //logAbbrevInst(infoObj);
        }

        let instByAddress = {};
        for(let inst of abbrevInsts) {
          instByAddress[inst.parsedAddress] = inst;
        }
        for(let inst of abbrevInsts) {
          if("type" in inst.values) {
            let address = inst.values.type;
            if(address in instByAddress) {
              inst.values.type_resolved = instByAddress[address].values;
            } else {
              inst.values.type_resolved = `Unresolved address ${address}`;
            }
          }
        }

        return abbrevInsts;
    }
    function parseDwarfSection(dwarfSection) {
        let { default_is_stmt, opcode_base, line_base, line_range, maximum_operations_per_instruction, mininum_instruction_length, standard_opcode_lengths } = dwarfSection;
        var defaultRegisters = {
            address: 0,
            op_index: 0,
            file: 1,
            line: 1,
            column: 0,
            is_stmt: default_is_stmt,
            basic_block: false,
            end_sequence: false,
            prologue_end: false,
            epilogue_begin: false,
            isa: 0,
            discriminator: 0,
        };
        var matrix = [];
        var curRegisters = { ...defaultRegisters };
        function applySpecialOpcode(opCode, noLineChange = false) {
            var adjusted_opcode = opCode - opcode_base;
            if (adjusted_opcode < 0) {
                throw new Error(`Special opcode is invalid, tried to use ${opCode}`);
            }
            var operation_advance = Math.floor(adjusted_opcode / line_range);
            var address_change = (mininum_instruction_length * Math.floor((curRegisters.op_index + operation_advance) / maximum_operations_per_instruction));
            //console.log({address_change, operation_advance});
            curRegisters.address += address_change;
            curRegisters.op_index = (curRegisters.op_index + operation_advance) % maximum_operations_per_instruction;
            if (!noLineChange) {
                curRegisters.line += line_base + (adjusted_opcode % line_range);
                //curRegisters.line = curRegisters.line % line_range;
                pushMatrix(opCode);
                curRegisters.basic_block = false;
                curRegisters.prologue_end = false;
                curRegisters.epilogue_begin = false;
                curRegisters.discriminator = 0;
            }
        }
        function pushMatrix(opCode) {
            //logEntry(curRegisters, opCode);
            let { file, ...remaining } = curRegisters;
            matrix.push({
                ...remaining,
                filePath: dwarfSection.fullFilePaths[file - 1]
            });
        }
        curIndex = 0;
        curBuffer = dwarfSection.instructions;
        // Starts with a byte? That is 0, and I'm not sure what it does...
        //parseNum(1);
        while (curIndex < curBuffer.length) {
            let opCode = parseNum(1);
            //console.log("before", {opCode, address: curRegisters.address});
            if (opCode == 0) {
                //console.log(`Unhandled extended opcode ${opCode}`);
                //return;
                // extended opcode
                let opCodeLength = parseLeb128();
                let opCodeBytes = curBuffer.slice(curIndex, curIndex + opCodeLength);
                if (opCodeBytes.length === 0) {
                    console.log(`done, or broken? Read ${curIndex}`);
                    // Done... or broken?
                    return matrix;
                }
                curIndex += opCodeLength;
                opCode = opCodeBytes[0];
                if (opCode === 1) {
                    curRegisters.end_sequence = true;
                    pushMatrix(opCode);
                    curRegisters = { ...defaultRegisters };
                }
                else if (opCode === 2) {
                    //console.log({opCode, opCodeBytes});
                    curRegisters.address = parseNumBase(opCodeBytes, 1, 4, false, true);
                }
                else if (opCode === 4) {
                    curRegisters.discriminator = leb128Parse(1, opCodeBytes).value;
                }
                else {
                    console.log({ opCode, opCodeBytes });
                    console.log(`Unhandled extended opcode ${opCode}`);
                    return matrix;
                }
            }
            else if (opCode < standard_opcode_lengths.length) {
                let opCodeLength = standard_opcode_lengths[opCode - 1];
                if (opCodeLength === 0) {
                    //throw new Error(`Length invalid? For opCode ${opCode}`);
                }
                if (opCode === 1) {
                    pushMatrix(opCode);
                    curRegisters.basic_block = false;
                    curRegisters.prologue_end = false;
                    curRegisters.epilogue_begin = false;
                    curRegisters.discriminator = 0;
                }
                else if (opCode === 2) {
                    let opCode = parseLeb128();
                    applySpecialOpcode(opCode * line_range + opcode_base, true);
                }
                else if (opCode === 3) {
                    curRegisters.line += parseLeb128(true);
                }
                else if (opCode === 4) {
                    // DW_LNS_set_file
                    curRegisters.file = parseLeb128();
                }
                else if (opCode === 5) {
                    curRegisters.column = parseLeb128();
                }
                else if (opCode === 6) {
                    curRegisters.is_stmt = curRegisters.is_stmt ? 0 : 1;
                }
                else if (opCode === 7) {
                    curRegisters.basic_block = true;
                }
                else if (opCode === 8) {
                    applySpecialOpcode(255, true);
                }
                else if (opCode === 9) {
                    curRegisters.address += parseNum(2, undefined, true);
                    curRegisters.op_index = 0;
                }
                else if (opCode === 10) {
                    curRegisters.prologue_end = true;
                }
                else if (opCode === 11) {
                    curRegisters.epilogue_begin = true;
                }
                else if (opCode === 12) {
                    curRegisters.isa = parseLeb128();
                }
                else {
                    console.log(`Unhandled opcode ${opCode}, length ${opCodeLength}`);
                    return matrix;
                }
            }
            else {
                applySpecialOpcode(opCode);
            }
            //console.log("after", {opCode, address: curRegisters.address});
        }
        return matrix;
    }

    function logRemaining() {
        let endIndex = Math.min(curIndex + 64, curBuffer.length);
        let outputText = "";
        outputText += "bytes left: " + String(curBuffer.length - curIndex) + ", bytes: ";
        for (let i = curIndex; i < endIndex; i++) {
          outputText += curBuffer[i].toString(16) + " ";
        }

        console.log(outputText);
    }
    function getExportNames(exportSection) {
        
        let exportedFunctions = {};
        curIndex = 0;
        curBuffer = exportSection.contents;
        let functionCount = parseLeb128();
        while (curIndex < curBuffer.length) {
            let nameLength = parseLeb128();
            let nameBytes = curBuffer.slice(curIndex, curIndex + nameLength);
            curIndex += nameLength;
            let name = Array.from(nameBytes).map(x => String.fromCharCode(x)).join("");
            let exportType = parseLeb128();
            let exportValue = parseLeb128();
            if (exportType === 0) {
                exportedFunctions[exportValue] = name;
            }
        }
        return exportedFunctions;
    }
    function getFunctionWasts(codeSection, exportSection) {
        function createParseFixedLength(name, n) {
            return function () {
                curIndex += n;
                return name;
            };
        }
        function createParseNLeb128s(name, n) {
            return function () {
                let nums = [];
                for (let i = 0; i < n; i++) {
                    nums.push(parseLeb128());
                }
                return `${name} ${nums.join(" ")}`;
            };
        }

        let instructionLengths = {
            // unreachable
            [0x00]: createParseFixedLength("unreachable", 0),
            // noop
            //[0x01]: createParseFixedLength(0),
            // block start
            [0x02]: createParseFixedLength("block", 1),
            [0x03]: createParseFixedLength("loop", 1),
            [0x0b]: createParseFixedLength("end", 0),
            [0x0c]: createParseFixedLength("br", 1),
            [0x0d]: createParseFixedLength("br_if", 1),
            [0x0f]: createParseFixedLength("return", 0),
            [0x10]: createParseNLeb128s("call", 1),
            [0x11]: createParseNLeb128s("call_indirect", 2),
            [0x1a]: createParseFixedLength("drop", 0),
            [0x1b]: createParseFixedLength("select", 0),
            [0x20]: createParseNLeb128s("get_local", 1),
            [0x21]: createParseNLeb128s("set_local", 1),
            [0x22]: createParseNLeb128s("tee_local", 1),
            [0x23]: createParseNLeb128s("get_global", 1),
            [0x24]: createParseNLeb128s("set_global", 1),
            // (The first argument is 2^x, the alignment bytes. If it matches the instruction kind, it is
            //  omitted from the WAST (so 2 for i32 is the not shown in the wast, and 3 for i64 isn't shown.
            //  I'm not sure about load8_s, etc...))
            [0x28]: createParseNLeb128s("i32.load", 2),
            [0x29]: createParseNLeb128s("i64.load", 2),
            [0x2A]: createParseNLeb128s("f32.load", 2),
            [0x2B]: createParseNLeb128s("f64.load", 2),
            [0x2C]: createParseNLeb128s("i32.load8_s", 2),
            [0x2D]: createParseNLeb128s("i32.load8_u", 2),
            [0x2E]: createParseNLeb128s("i32.load16_s", 2),
            [0x2F]: createParseNLeb128s("i32.load16_u", 2),
            [0x30]: createParseNLeb128s("i64.load8_s", 2),
            [0x31]: createParseNLeb128s("i64.load8_u", 2),
            [0x32]: createParseNLeb128s("i64.load16_s", 2),
            [0x33]: createParseNLeb128s("i64.load16_u", 2),
            [0x34]: createParseNLeb128s("i64.load32_s", 2),
            [0x35]: createParseNLeb128s("i64.load32_u", 2),
            [0x36]: createParseNLeb128s("i32.store", 2),
            [0x37]: createParseNLeb128s("i64.store", 2),
            [0x38]: createParseNLeb128s("f32.store", 2),
            [0x39]: createParseNLeb128s("f64.store", 2),
            [0x3A]: createParseNLeb128s("i32.store8", 2),
            [0x3B]: createParseNLeb128s("i32.store16", 2),
            [0x3C]: createParseNLeb128s("i64.store8", 2),
            [0x3D]: createParseNLeb128s("i64.store16", 2),
            [0x3E]: createParseNLeb128s("i64.store32", 2),
            [0x41]: createParseNLeb128s("i32.const", 1),
            [0x42]: createParseNLeb128s("i64.const", 1),
            [0x43]: createParseFixedLength("f32.const", 4),
            [0x44]: createParseFixedLength("f64.const", 8),
            [0x45]: createParseFixedLength("i32.eqz", 0),
            [0x46]: createParseFixedLength("i32.eq", 0),
            [0x47]: createParseFixedLength("i32.ne", 0),
            [0x48]: createParseFixedLength("i32.lt_s", 0),
            [0x49]: createParseFixedLength("i32.lt_u", 0),
            [0x4A]: createParseFixedLength("i32.gt_s", 0),
            [0x4B]: createParseFixedLength("i32.gt_u", 0),
            [0x4C]: createParseFixedLength("i32.le_s", 0),
            [0x4D]: createParseFixedLength("i32.le_u", 0),
            [0x4E]: createParseFixedLength("i32.ge_s", 0),
            [0x4F]: createParseFixedLength("i32.ge_u", 0),
            [0x50]: createParseFixedLength("i64.eqz", 0),
            [0x51]: createParseFixedLength("i64.eq", 0),
            [0x52]: createParseFixedLength("i64.ne", 0),
            [0x53]: createParseFixedLength("i64.lt_s", 0),
            [0x54]: createParseFixedLength("i64.lt_u", 0),
            [0x55]: createParseFixedLength("i64.gt_s", 0),
            [0x56]: createParseFixedLength("i64.gt_u", 0),
            [0x57]: createParseFixedLength("i64.le_s", 0),
            [0x58]: createParseFixedLength("i64.le_u", 0),
            [0x59]: createParseFixedLength("i64.ge_s", 0),
            [0x5A]: createParseFixedLength("i64.ge_u", 0),
            [0x5B]: createParseFixedLength("f32.eq", 0),
            [0x5C]: createParseFixedLength("f32.ne", 0),
            [0x5D]: createParseFixedLength("f32.lt", 0),
            [0x5E]: createParseFixedLength("f32.gt", 0),
            [0x5F]: createParseFixedLength("f32.le", 0),
            [0x60]: createParseFixedLength("f32.ge", 0),
            [0x61]: createParseFixedLength("f64.eq", 0),
            [0x62]: createParseFixedLength("f64.ne", 0),
            [0x63]: createParseFixedLength("f64.lt", 0),
            [0x64]: createParseFixedLength("f64.gt", 0),
            [0x65]: createParseFixedLength("f64.le", 0),
            [0x66]: createParseFixedLength("f64.ge", 0),
            [0x67]: createParseFixedLength("i32.clz", 0),
            [0x68]: createParseFixedLength("i32.ctz", 0),
            [0x69]: createParseFixedLength("i32.popcnt", 0),
            [0x6A]: createParseFixedLength("i32.add", 0),
            [0x6B]: createParseFixedLength("i32.sub", 0),
            [0x6C]: createParseFixedLength("i32.mul", 0),
            [0x6D]: createParseFixedLength("i32.div_s", 0),
            [0x6E]: createParseFixedLength("i32.div_u", 0),
            [0x6F]: createParseFixedLength("i32.rem_s", 0),
            [0x70]: createParseFixedLength("i32.rem_u", 0),
            [0x71]: createParseFixedLength("i32.and", 0),
            [0x72]: createParseFixedLength("i32.or", 0),
            [0x73]: createParseFixedLength("i32.xor", 0),
            [0x74]: createParseFixedLength("i32.shl", 0),
            [0x75]: createParseFixedLength("i32.shr_s", 0),
            [0x76]: createParseFixedLength("i32.shr_u", 0),
            [0x77]: createParseFixedLength("i32.rotl", 0),
            [0x78]: createParseFixedLength("i32.rotr", 0),
            [0x79]: createParseFixedLength("i64.clz", 0),
            [0x7A]: createParseFixedLength("i64.ctz", 0),
            [0x7B]: createParseFixedLength("i64.popcnt", 0),
            [0x7C]: createParseFixedLength("i64.add", 0),
            [0x7D]: createParseFixedLength("i64.sub", 0),
            [0x7E]: createParseFixedLength("i64.mul", 0),
            [0x7F]: createParseFixedLength("i64.div_s", 0),
            [0x80]: createParseFixedLength("i64.div_u", 0),
            [0x81]: createParseFixedLength("i64.rem_s", 0),
            [0x82]: createParseFixedLength("i64.rem_u", 0),
            [0x83]: createParseFixedLength("i64.and", 0),
            [0x84]: createParseFixedLength("i64.or", 0),
            [0x85]: createParseFixedLength("i64.xor", 0),
            [0x86]: createParseFixedLength("i64.shl", 0),
            [0x87]: createParseFixedLength("i64.shr_s", 0),
            [0x88]: createParseFixedLength("i64.shr_u", 0),
            [0x89]: createParseFixedLength("i64.rotl", 0),
            [0x8A]: createParseFixedLength("i64.rotr", 0),
            [0x8B]: createParseFixedLength("f32.abs", 0),
            [0x8C]: createParseFixedLength("f32.neg", 0),
            [0x8D]: createParseFixedLength("f32.ceil", 0),
            [0x8E]: createParseFixedLength("f32.floor", 0),
            [0x8F]: createParseFixedLength("f32.trunc", 0),
            [0x90]: createParseFixedLength("f32.nearest", 0),
            [0x91]: createParseFixedLength("f32.sqrt", 0),
            [0x92]: createParseFixedLength("f32.add", 0),
            [0x93]: createParseFixedLength("f32.sub", 0),
            [0x94]: createParseFixedLength("f32.mul", 0),
            [0x95]: createParseFixedLength("f32.div", 0),
            [0x96]: createParseFixedLength("f32.min", 0),
            [0x97]: createParseFixedLength("f32.max", 0),
            [0x98]: createParseFixedLength("f32.copysign", 0),
            [0x99]: createParseFixedLength("f64.abs", 0),
            [0x9A]: createParseFixedLength("f64.neg", 0),
            [0x9B]: createParseFixedLength("f64.ceil", 0),
            [0x9C]: createParseFixedLength("f64.floor", 0),
            [0x9D]: createParseFixedLength("f64.trunc", 0),
            [0x9E]: createParseFixedLength("f64.nearest", 0),
            [0x9F]: createParseFixedLength("f64.sqrt", 0),
            [0xA0]: createParseFixedLength("f64.add", 0),
            [0xA1]: createParseFixedLength("f64.sub", 0),
            [0xA2]: createParseFixedLength("f64.mul", 0),
            [0xA3]: createParseFixedLength("f64.div", 0),
            [0xA4]: createParseFixedLength("f64.min", 0),
            [0xA5]: createParseFixedLength("f64.max", 0),
            [0xA6]: createParseFixedLength("f64.copysign", 0),
            [0xA7]: createParseFixedLength("i32.wrap_i64", 0),
            [0xA8]: createParseFixedLength("i32.trunc_f32_s", 0),
            [0xA9]: createParseFixedLength("i32.trunc_f32_u", 0),
            [0xAA]: createParseFixedLength("i32.trunc_f64_s", 0),
            [0xAB]: createParseFixedLength("i32.trunc_f64_u", 0),
            [0xAC]: createParseFixedLength("i64.extend_i32_s", 0),
            [0xAD]: createParseFixedLength("i64.extend_i32_u", 0),
            [0xAE]: createParseFixedLength("i64.trunc_f32_s", 0),
            [0xAF]: createParseFixedLength("i64.trunc_f32_u", 0),
            [0xB0]: createParseFixedLength("i64.trunc_f64_s", 0),
            [0xB1]: createParseFixedLength("i64.trunc_f64_u", 0),
            [0xB2]: createParseFixedLength("f32.convert_i32_s", 0),
            [0xB3]: createParseFixedLength("f32.convert_i32_u", 0),
            [0xB4]: createParseFixedLength("f32.convert_i64_s", 0),
            [0xB5]: createParseFixedLength("f32.convert_i64_u", 0),
            [0xB6]: createParseFixedLength("f32.demote_f64", 0),
            [0xB7]: createParseFixedLength("f64.convert_i32_s", 0),
            [0xB8]: createParseFixedLength("f64.convert_i32_u", 0),
            [0xB9]: createParseFixedLength("f64.convert_i64_s", 0),
            [0xBA]: createParseFixedLength("f64.convert_i64_u", 0),
            [0xBB]: createParseFixedLength("f64.promote_f32", 0),
            [0xBC]: createParseFixedLength("i32.reinterpret_f32", 0),
            [0xBD]: createParseFixedLength("i64.reinterpret_f64", 0),
            [0xBE]: createParseFixedLength("f32.reinterpret_i32", 0),
            [0xBF]: createParseFixedLength("f64.reinterpret_i64", 0),
        };
        let isNotBranchingLookup = {
          [0x20]: ("get_local"),
          [0x21]: ("set_local"),
          [0x22]: ("tee_local"),
          [0x23]: ("get_global"),
          [0x24]: ("set_global"),
          [0x28]: ("i32.load"),
          [0x29]: ("i64.load"),
          [0x2A]: ("f32.load"),
          [0x2B]: ("f64.load"),
          [0x2C]: ("i32.load8_s"),
          [0x2D]: ("i32.load8_u"),
          [0x2E]: ("i32.load16_s"),
          [0x2F]: ("i32.load16_u"),
          [0x30]: ("i64.load8_s"),
          [0x31]: ("i64.load8_u"),
          [0x32]: ("i64.load16_s"),
          [0x33]: ("i64.load16_u"),
          [0x34]: ("i64.load32_s"),
          [0x35]: ("i64.load32_u"),
          [0x36]: ("i32.store"),
          [0x37]: ("i64.store"),
          [0x38]: ("f32.store"),
          [0x39]: ("f64.store"),
          [0x3A]: ("i32.store8"),
          [0x3B]: ("i32.store16"),
          [0x3C]: ("i64.store8"),
          [0x3D]: ("i64.store16"),
          [0x3E]: ("i64.store32"),
          [0x41]: ("i32.const"),
          [0x42]: ("i64.const"),
          [0x43]: ("f32.const"),
          [0x44]: ("f64.const"),
          [0x45]: ("i32.eqz"),
          [0x46]: ("i32.eq"),
          [0x47]: ("i32.ne"),
          [0x48]: ("i32.lt_s"),
          [0x49]: ("i32.lt_u"),
          [0x4A]: ("i32.gt_s"),
          [0x4B]: ("i32.gt_u"),
          [0x4C]: ("i32.le_s"),
          [0x4D]: ("i32.le_u"),
          [0x4E]: ("i32.ge_s"),
          [0x4F]: ("i32.ge_u"),
          [0x50]: ("i64.eqz"),
          [0x51]: ("i64.eq"),
          [0x52]: ("i64.ne"),
          [0x53]: ("i64.lt_s"),
          [0x54]: ("i64.lt_u"),
          [0x55]: ("i64.gt_s"),
          [0x56]: ("i64.gt_u"),
          [0x57]: ("i64.le_s"),
          [0x58]: ("i64.le_u"),
          [0x59]: ("i64.ge_s"),
          [0x5A]: ("i64.ge_u"),
          [0x5B]: ("f32.eq"),
          [0x5C]: ("f32.ne"),
          [0x5D]: ("f32.lt"),
          [0x5E]: ("f32.gt"),
          [0x5F]: ("f32.le"),
          [0x60]: ("f32.ge"),
          [0x61]: ("f64.eq"),
          [0x62]: ("f64.ne"),
          [0x63]: ("f64.lt"),
          [0x64]: ("f64.gt"),
          [0x65]: ("f64.le"),
          [0x66]: ("f64.ge"),
          [0x67]: ("i32.clz"),
          [0x68]: ("i32.ctz"),
          [0x69]: ("i32.popcnt"),
          [0x6A]: ("i32.add"),
          [0x6B]: ("i32.sub"),
          [0x6C]: ("i32.mul"),
          [0x6D]: ("i32.div_s"),
          [0x6E]: ("i32.div_u"),
          [0x6F]: ("i32.rem_s"),
          [0x70]: ("i32.rem_u"),
          [0x71]: ("i32.and"),
          [0x72]: ("i32.or"),
          [0x73]: ("i32.xor"),
          [0x74]: ("i32.shl"),
          [0x75]: ("i32.shr_s"),
          [0x76]: ("i32.shr_u"),
          [0x77]: ("i32.rotl"),
          [0x78]: ("i32.rotr"),
          [0x79]: ("i64.clz"),
          [0x7A]: ("i64.ctz"),
          [0x7B]: ("i64.popcnt"),
          [0x7C]: ("i64.add"),
          [0x7D]: ("i64.sub"),
          [0x7E]: ("i64.mul"),
          [0x7F]: ("i64.div_s"),
          [0x80]: ("i64.div_u"),
          [0x81]: ("i64.rem_s"),
          [0x82]: ("i64.rem_u"),
          [0x83]: ("i64.and"),
          [0x84]: ("i64.or"),
          [0x85]: ("i64.xor"),
          [0x86]: ("i64.shl"),
          [0x87]: ("i64.shr_s"),
          [0x88]: ("i64.shr_u"),
          [0x89]: ("i64.rotl"),
          [0x8A]: ("i64.rotr"),
          [0x8B]: ("f32.abs"),
          [0x8C]: ("f32.neg"),
          [0x8D]: ("f32.ceil"),
          [0x8E]: ("f32.floor"),
          [0x8F]: ("f32.trunc"),
          [0x90]: ("f32.nearest"),
          [0x91]: ("f32.sqrt"),
          [0x92]: ("f32.add"),
          [0x93]: ("f32.sub"),
          [0x94]: ("f32.mul"),
          [0x95]: ("f32.div"),
          [0x96]: ("f32.min"),
          [0x97]: ("f32.max"),
          [0x98]: ("f32.copysign"),
          [0x99]: ("f64.abs"),
          [0x9A]: ("f64.neg"),
          [0x9B]: ("f64.ceil"),
          [0x9C]: ("f64.floor"),
          [0x9D]: ("f64.trunc"),
          [0x9E]: ("f64.nearest"),
          [0x9F]: ("f64.sqrt"),
          [0xA0]: ("f64.add"),
          [0xA1]: ("f64.sub"),
          [0xA2]: ("f64.mul"),
          [0xA3]: ("f64.div"),
          [0xA4]: ("f64.min"),
          [0xA5]: ("f64.max"),
          [0xA6]: ("f64.copysign"),
          [0xA7]: ("i32.wrap_i64"),
          [0xA8]: ("i32.trunc_f32_s"),
          [0xA9]: ("i32.trunc_f32_u"),
          [0xAA]: ("i32.trunc_f64_s"),
          [0xAB]: ("i32.trunc_f64_u"),
          [0xAC]: ("i64.extend_i32_s"),
          [0xAD]: ("i64.extend_i32_u"),
          [0xAE]: ("i64.trunc_f32_s"),
          [0xAF]: ("i64.trunc_f32_u"),
          [0xB0]: ("i64.trunc_f64_s"),
          [0xB1]: ("i64.trunc_f64_u"),
          [0xB2]: ("f32.convert_i32_s"),
          [0xB3]: ("f32.convert_i32_u"),
          [0xB4]: ("f32.convert_i64_s"),
          [0xB5]: ("f32.convert_i64_u"),
          [0xB6]: ("f32.demote_f64"),
          [0xB7]: ("f64.convert_i32_s"),
          [0xB8]: ("f64.convert_i32_u"),
          [0xB9]: ("f64.convert_i64_s"),
          [0xBA]: ("f64.convert_i64_u"),
          [0xBB]: ("f64.promote_f32"),
          [0xBC]: ("i32.reinterpret_f32"),
          [0xBD]: ("i64.reinterpret_f64"),
          [0xBE]: ("f32.reinterpret_i32"),
          [0xBF]: ("f64.reinterpret_i64"),
      };
        let exportedFunctions = getExportNames(exportSection);
        curIndex = 0;
        curBuffer = codeSection.contents;
        let functionCount = parseLeb128();
        let wasts = [];
        let fncIndex = 0;
        let fncCount = 0;
        while (curIndex < curBuffer.length) {
            // Byte length of current expression
            let startIndex = curIndex;
            let len = parseLeb128();
            let endIndex = curIndex + len;
            let curFncIndex = ++fncIndex;
            let functionName = exportedFunctions[curFncIndex] || "???";
            if(curFncIndex in exportedFunctions) {
              fncCount++;
            }
            let declarationCount = parseLeb128();
            for (let i = 0; i < declarationCount; i++) {
                let countOfValue = parseLeb128();
                let valueType = parseLeb128();
            }
            let instructions = [];
            // Parse instructions
            while (curIndex < endIndex) {
                let wasmByteOffset = curIndex;
                let code = curBuffer[curIndex++];
                if (code === undefined) {
                    throw new Error(`Did not find return in function?`);
                }
                if (!(code in instructionLengths)) {
                    console.error(`!!! Unhandled instruction 0x${code.toString(16)} in ${functionName} (${fncCount}/${Object.keys(exportedFunctions).length}) at ${wasmByteOffset} of ${endIndex} out of ${curBuffer.length}`);
                    console.group();
                    console.error(`Prev instructions were`, instructions.slice(-10), wasts.slice(-10));
                    console.groupEnd();
                    curIndex--;
                    logRemaining();
                    break;
                }
                let wast = instructionLengths[code]();
                instructions.push(wast);
                wasts.push({
                    wasmByteOffset,
                    wast,
                    functionName,
                    functionIndex: fncIndex - 1,
                    instructionLength: curIndex - wasmByteOffset,
                    isNotBranching: isNotBranchingLookup[code] || false
                });
            }
            if (curIndex !== endIndex) {
                console.error(`!!! Invalid read, read to ${curIndex}, should have read to ${endIndex} (out of ${curBuffer.length})`);
            }
            curIndex = endIndex;
        }
        return wasts;
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


    module = await module;
    var wasmModules = window.wasmModules = window.wasmModules || [];

    var wasmStack = window.wasmStack = window.wasmStack || [];

    let fncs = [];

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
            dwarfErrorMessage: string;
            dwarfParsedMessage: string;
            codeOffset: number;
        }
    }*/
    let moduleObj;

    let exports = {};
    for(let key in module.instance.exports) {
      let baseValue = module.instance.exports[key];
      let value = baseValue;
      if(typeof baseValue === "function") {
        value = function() {
          wasmStack.push(moduleObj);
          try {
            return baseValue.apply(this, arguments);
          } finally {
            wasmStack.pop();
          }
        };
      }
      exports[key] = value;
    }

    module.instance = Object.freeze({ exports: Object.freeze(exports) });

    moduleObj = { binary, module, fncs };
    moduleObj.parseDwarf = () => { /* Step in to debug parsing function. */ debugger; doParsing();}

    let wasmModuleIndex = wasmModules.length;
    wasmModules.push(moduleObj);

    // TODO: Use debug_names to get data in a lazy fashion, to allow loading to be fast for very large files
    //  - But first, find a very large file that has a noticeable delay.
    doParsing();
    function doParsing() {
      try {
        let parseTime = Date.now();
        

        let sections = getSections(binary);

        let nameValueSections = getNameValueSections(sections);

        if(!(".debug_line" in nameValueSections)) {
          moduleObj.dwarfErrorTitle = "No DWARF debug info in WASM";
          moduleObj.dwarfErrorMessage = `Only found sections ${Object.keys(nameValueSections).map(x => `"${x}"`).join(", ")} in wasm, but no ".debug_line", which is required to give type information.`;
          return;
        }

        let codeSection = Object.values(sections).filter(x => x.sectionId === 10)[0];
        let exportSection = Object.values(sections).filter(x => x.sectionId === 7)[0];
        let dwarfSections = getDwarfSections(nameValueSections[".debug_line"], codeSection.offset);
        
        moduleObj.codeOffset = codeSection.offset;
        
        // TODO: Not all of these are strictly required... so add handling if some of them are missing.
        if(!(".debug_str" in nameValueSections)) {
          moduleObj.dwarfErrorTitle = "Incomplete DWARF debug info in WASM";
          moduleObj.dwarfErrorMessage = `Only found sections ${Object.keys(nameValueSections).map(x => `"${x}"`).join(", ")} in wasm, but no ".debug_str", which is required to give type information.`;
          return;
        }
        if(!(".debug_abbrev" in nameValueSections)) {
          moduleObj.dwarfErrorTitle = "Incomplete DWARF debug info in WASM";
          moduleObj.dwarfErrorMessage = `Only found sections ${Object.keys(nameValueSections).map(x => `"${x}"`).join(", ")} in wasm, but no ".debug_abbrev", which is required to give type information.`;
          return;
        }
        if(!(".debug_info" in nameValueSections)) {
          moduleObj.dwarfErrorTitle = "Incomplete DWARF debug info in WASM";
          moduleObj.dwarfErrorMessage = `Only found sections ${Object.keys(nameValueSections).map(x => `"${x}"`).join(", ")} in wasm, but no ".debug_info", which is required to give type information.`;
          return;
        }

        let dwarfLines = parseDwarfSection(dwarfSections[0]);
        moduleObj.originalDwarfLines = dwarfLines;
        
        let addressToLinesLookup = {};
        for(let dwarfInfo of dwarfLines) {
          addressToLinesLookup[dwarfInfo.address] = addressToLinesLookup[dwarfInfo.address] || [];
          addressToLinesLookup[dwarfInfo.address].push(dwarfInfo);
        }
        let addressToLines = [];
        for(let address in addressToLinesLookup) {
          addressToLines.push({
            address: +address,
            dwarfInfos: addressToLinesLookup[address]
          });
        }
        function lineColumnHash(address) {
          let index = binarySearch(addressToLines, { address }, x => x.address);
          if(index < 0) {
            index = ~index - 1;
          }
          let infos = addressToLines[index];
          if(!infos) return "";
          return infos.dwarfInfos.map(info => info.file + ":" + info.line).join("_");
        }



        moduleObj.dwarfLines = addressToLines;

        let dwarfAbbrevs = getDwarfAbbrevs(
          dwarfSections[0].fullFilePaths,
          nameValueSections[".debug_str"],
          nameValueSections[".debug_abbrev"],
          nameValueSections[".debug_info"]
        );
        moduleObj.dwarfAbbrevs = dwarfAbbrevs;
        let pendingFnc = {};
        function pushCurFnc() {
          fncs.push(pendingFnc);
          pendingFnc = {
            parameters: []
          };
        }
        pushCurFnc();
        fncs.shift();
        for(let i = 0; i < dwarfAbbrevs.length; i++) {
          let abbrev = dwarfAbbrevs[i];
          if(pendingFnc.name !== undefined && abbrev.tag !== "DW_TAG_formal_parameter") {
            pushCurFnc();
          }
          if(abbrev.tag === "DW_TAG_subprogram") {
            Object.assign(pendingFnc, abbrev.values);
            pendingFnc.file = abbrev.filePaths[abbrev.values.decl_file];
          } else if(abbrev.tag === "DW_TAG_formal_parameter") {
            pendingFnc.parameters.push(abbrev.values);
          }
        }
        if(pendingFnc.name !== undefined) {
          pushCurFnc();
        }

        fncs.sort((a, b) => (a.low_pc || 0) - (b.low_pc || 0));

        let functionWasts = moduleObj.functionWasts = getFunctionWasts(codeSection, exportSection);
        moduleObj.getNextBranchingOrDifferentLine = function(columnNumber) {
          debugger;
          let wasmByteOffset = columnNumber - moduleObj.codeOffset;

          let index = binarySearch(functionWasts, { wasmByteOffset: wasmByteOffset }, x => x.wasmByteOffset);
          let indexStart = index;
          if(index <= 0) {
            return undefined;
          }

          let addressStart = functionWasts[index].wasmByteOffset;
          binarySearch(addressToLines, { address: addressStart }, x => x.address);

          let linesStart = lineColumnHash(addressStart);
          if(!linesStart) throw new Error(`Cannot find lines for address ${addressStart} (column ${addressStart + moduleObj.codeOffset})`);

          // Go until the last, not the end, as we always need to to run until an instruction, not until after the instructions.
          while(index < functionWasts.length - 1) {
            // Is !not branching, then... it could branch. It may not, because a jump might not run, but we can't know that
            //  without running the line (basically...).
            let wast = functionWasts[index];
            if(!wast.isNotBranching) break;
            let curAddress = wast.wasmByteOffset;
            let linesCur = lineColumnHash(curAddress);
            if(!linesCur) throw new Error(`Cannot find lines for address ${curAddress} (column ${curAddress + moduleObj.codeOffset})`);

            if(linesStart !== linesCur) break;

            index++;
          }

          return functionWasts[index].wasmByteOffset + moduleObj.codeOffset;
        };

        parseTime = Date.now() - parseTime;

        let unit = dwarfAbbrevs[0].values;
        moduleObj.dwarfParsedMessage = `(parse time ${parseTime}ms) COMPILER ${unit.producer}  --- NAME ${unit.name}`;

        if(dwarfSections.length > 1) {
          moduleObj.dwarfStatus = "warn";
          moduleObj.dwarfParsedMessage = `(Found ${dwarfSections.length} dwarf sections, only the first was used) ` + moduleObj.dwarfParsedMessage;
        }
      } catch(e) {
        moduleObj.dwarfErrorTitle = "Parse Error";
        moduleObj.dwarfErrorMessage = e.stack;

        console.error(`Parse error. Run "window.wasmModules[${wasmModuleIndex}].parseDwarf()" to rerun. ${e.stack}`)
      }
    }

    return module;
  }

  {
    let baseFnc = WebAssembly.instantiate;
    WebAssembly.instantiate = function(binary) {
      return recordModule(binary, baseFnc.apply(this, arguments));
    };
  }
  {
    let baseFnc = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async function(response) {
      response = await response;
      let binary = await response.arrayBuffer();
      return recordModule(binary, baseFnc.apply(this, arguments));
    };
  }

  console.info("WebAssembly functions patched by WASM tools.");
}



/**
 * @unrestricted
 */
export class RuntimeModel extends SDKModel {
  /**
   * @param {!Target} target
   */
  constructor(target) {
    super(target);

    this._agent = target.runtimeAgent();
    this.target().registerRuntimeDispatcher(new RuntimeDispatcher(this));
    this._agent.enable();
    /** @type {!Map<number, !ExecutionContext>} */
    this._executionContextById = new Map();
    this._executionContextComparator = ExecutionContext.comparator;
    /** @type {?boolean} */
    this._hasSideEffectSupport = null;

    if (self.Common.settings.moduleSetting('customFormatters').get()) {
      this._agent.setCustomObjectFormatterEnabled(true);
    }

    self.Common.settings.moduleSetting('customFormatters')
        .addChangeListener(this._customFormattersStateChanged.bind(this));
  }

  /**
   * @param {!EvaluationResult} response
   * @return {boolean}
   */
  static isSideEffectFailure(response) {
    const exceptionDetails = !response[ProtocolModule.InspectorBackend.ProtocolError] && response.exceptionDetails;
    return !!(
        exceptionDetails && exceptionDetails.exception && exceptionDetails.exception.description &&
        exceptionDetails.exception.description.startsWith('EvalError: Possible side-effect in debug-evaluate'));
  }

  /**
   * @return {!DebuggerModel}
   */
  debuggerModel() {
    return /** @type {!DebuggerModel} */ (this.target().model(DebuggerModel));
  }

  /**
   * @return {!HeapProfilerModel}
   */
  heapProfilerModel() {
    return /** @type {!HeapProfilerModel} */ (this.target().model(HeapProfilerModel));
  }

  /**
   * @return {!Array.<!ExecutionContext>}
   */
  executionContexts() {
    return [...this._executionContextById.values()].sort(this.executionContextComparator());
  }

  /**
   * @param {function(!ExecutionContext,!ExecutionContext)} comparator
   */
  setExecutionContextComparator(comparator) {
    this._executionContextComparator = comparator;
  }

  /**
   * @return {function(!ExecutionContext,!ExecutionContext)} comparator
   */
  executionContextComparator() {
    return this._executionContextComparator;
  }

  /**
   * @return {?ExecutionContext}
   */
  defaultExecutionContext() {
    for (const context of this.executionContexts()) {
      if (context.isDefault) {
        return context;
      }
    }
    return null;
  }

  /**
   * @param {!Protocol.Runtime.ExecutionContextId} id
   * @return {?ExecutionContext}
   */
  executionContext(id) {
    return this._executionContextById.get(id) || null;
  }

  /**
   * @param {!Protocol.Runtime.ExecutionContextDescription} context
   */
  _executionContextCreated(context) {
    const data = context.auxData || {isDefault: true};
    const executionContext =
        new ExecutionContext(this, context.id, context.name, context.origin, data['isDefault'], data['frameId']);
    this._executionContextById.set(executionContext.id, executionContext);
    this.dispatchEventToListeners(Events.ExecutionContextCreated, executionContext);

    if(window.patchingForWasmSupport) {
      window.wasmPatchedLookup = window.wasmPatchedLookup || {};
      window.wasmPatchedLookup[executionContext.id] = true;
      (async () => {
        await runCodeInTarget(executionContext, [], webAssemblyInjected);
        setBreakOnStart(false, executionContext);
        executionContext.debuggerModel.resume();
      })();
    }
  }

  /**
   * @param {number} executionContextId
   */
  _executionContextDestroyed(executionContextId) {
    const executionContext = this._executionContextById.get(executionContextId);
    if (!executionContext) {
      return;
    }
    if(window.patchingForWasmSupport) {
      // Set breaking back on, as setting braek on start has to be asynchronous, so we can't turn it back on when the execution is created
      //  (before the execution gets to run). So we have to set it on destroyed, so on create it will already be set.
      setBreakOnStart(true, executionContext);
    }
    this.debuggerModel().executionContextDestroyed(executionContext);
    this._executionContextById.delete(executionContextId);
    this.dispatchEventToListeners(Events.ExecutionContextDestroyed, executionContext);
  }

  fireExecutionContextOrderChanged() {
    this.dispatchEventToListeners(Events.ExecutionContextOrderChanged, this);
  }

  _executionContextsCleared() {
    this.debuggerModel().globalObjectCleared();
    const contexts = this.executionContexts();
    this._executionContextById.clear();
    for (let i = 0; i < contexts.length; ++i) {
      this.dispatchEventToListeners(Events.ExecutionContextDestroyed, contexts[i]);
    }
  }

  /**
   * @param {!Protocol.Runtime.RemoteObject} payload
   * @return {!RemoteObject}
   */
  createRemoteObject(payload) {
    console.assert(typeof payload === 'object', 'Remote object payload should only be an object');
    return new RemoteObjectImpl(
        this, payload.objectId, payload.type, payload.subtype, payload.value, payload.unserializableValue,
        payload.description, payload.preview, payload.customPreview, payload.className);
  }

  /**
   * @param {!Protocol.Runtime.RemoteObject} payload
   * @param {!ScopeRef} scopeRef
   * @return {!RemoteObject}
   */
  createScopeRemoteObject(payload, scopeRef) {
    return new ScopeRemoteObject(
        this, payload.objectId, scopeRef, payload.type, payload.subtype, payload.value, payload.unserializableValue,
        payload.description, payload.preview);
  }

  /**
   * @param {number|string|boolean|undefined|bigint} value
   * @return {!RemoteObject}
   */
  createRemoteObjectFromPrimitiveValue(value) {
    const type = typeof value;
    let unserializableValue = undefined;
    const unserializableDescription = RemoteObject.unserializableDescription(value);
    if (unserializableDescription !== null) {
      unserializableValue = /** @type {!Protocol.Runtime.UnserializableValue} */ (unserializableDescription);
    }
    if (typeof unserializableValue !== 'undefined') {
      value = undefined;
    }
    return new RemoteObjectImpl(this, undefined, type, undefined, value, unserializableValue);
  }

  /**
   * @param {string} name
   * @param {number|string|boolean} value
   * @return {!RemoteObjectProperty}
   */
  createRemotePropertyFromPrimitiveValue(name, value) {
    return new RemoteObjectProperty(name, this.createRemoteObjectFromPrimitiveValue(value));
  }

  discardConsoleEntries() {
    this._agent.discardConsoleEntries();
  }

  /**
   * @param {string} objectGroupName
   */
  releaseObjectGroup(objectGroupName) {
    this._agent.releaseObjectGroup(objectGroupName);
  }

  /**
   * @param {!EvaluationResult} result
   */
  releaseEvaluationResult(result) {
    if (result.object) {
      result.object.release();
    }
    if (result.exceptionDetails && result.exceptionDetails.exception) {
      const exception = result.exceptionDetails.exception;
      const exceptionObject = this.createRemoteObject({type: exception.type, objectId: exception.objectId});
      exceptionObject.release();
    }
  }

  runIfWaitingForDebugger() {
    this._agent.runIfWaitingForDebugger();
  }

  /**
   * @param {!Common.EventTarget.EventTargetEvent} event
   */
  _customFormattersStateChanged(event) {
    const enabled = /** @type {boolean} */ (event.data);
    this._agent.setCustomObjectFormatterEnabled(enabled);
  }

  /**
   * @param {string} expression
   * @param {string} sourceURL
   * @param {boolean} persistScript
   * @param {number} executionContextId
   * @return {!Promise<?CompileScriptResult>}
   */
  async compileScript(expression, sourceURL, persistScript, executionContextId) {
    const response = await this._agent.invoke_compileScript({
      expression: expression,
      sourceURL: sourceURL,
      persistScript: persistScript,
      executionContextId: executionContextId,
    });

    if (response[ProtocolModule.InspectorBackend.ProtocolError]) {
      console.error(response[ProtocolModule.InspectorBackend.ProtocolError]);
      return null;
    }
    return {scriptId: response.scriptId, exceptionDetails: response.exceptionDetails};
  }

  /**
   * @param {!Protocol.Runtime.ScriptId} scriptId
   * @param {number} executionContextId
   * @param {string=} objectGroup
   * @param {boolean=} silent
   * @param {boolean=} includeCommandLineAPI
   * @param {boolean=} returnByValue
   * @param {boolean=} generatePreview
   * @param {boolean=} awaitPromise
   * @return {!Promise<!EvaluationResult>}
   */
  async runScript(
      scriptId, executionContextId, objectGroup, silent, includeCommandLineAPI, returnByValue, generatePreview,
      awaitPromise) {
    const response = await this._agent.invoke_runScript({
      scriptId,
      executionContextId,
      objectGroup,
      silent,
      includeCommandLineAPI,
      returnByValue,
      generatePreview,
      awaitPromise,
    });

    const error = response[ProtocolModule.InspectorBackend.ProtocolError];
    if (error) {
      console.error(error);
      return {error: error};
    }
    return {object: this.createRemoteObject(response.result), exceptionDetails: response.exceptionDetails};
  }

  /**
   * @param {!RemoteObject} prototype
   * @return {!Promise<!QueryObjectResult>}
   */
  async queryObjects(prototype) {
    if (!prototype.objectId) {
      return {error: 'Prototype should be an Object.'};
    }
    const response = await this._agent.invoke_queryObjects(
        {prototypeObjectId: /** @type {string} */ (prototype.objectId), objectGroup: 'console'});
    const error = response[ProtocolModule.InspectorBackend.ProtocolError];
    if (error) {
      console.error(error);
      return {error: error};
    }
    return {objects: this.createRemoteObject(response.objects)};
  }

  /**
   * @return {!Promise<string>}
   */
  async isolateId() {
    return (await this._agent.getIsolateId()) || this.target().id();
  }

  /**
   * @return {!Promise<?{usedSize: number, totalSize: number}>}
   */
  async heapUsage() {
    const result = await this._agent.invoke_getHeapUsage({});
    return result[ProtocolModule.InspectorBackend.ProtocolError] ? null : result;
  }

  /**
   * @param {!Protocol.Runtime.RemoteObject} payload
   * @param {!Object=} hints
   */
  _inspectRequested(payload, hints) {
    const object = this.createRemoteObject(payload);

    if (hints.copyToClipboard) {
      this._copyRequested(object);
      return;
    }

    if (hints.queryObjects) {
      this._queryObjectsRequested(object);
      return;
    }

    if (object.isNode()) {
      Common.Revealer.reveal(object).then(object.release.bind(object));
      return;
    }

    if (object.type === 'function') {
      RemoteFunction.objectAsFunction(object).targetFunctionDetails().then(didGetDetails);
      return;
    }

    /**
     * @param {?FunctionDetails} response
     */
    function didGetDetails(response) {
      object.release();
      if (!response || !response.location) {
        return;
      }
      Common.Revealer.reveal(response.location);
    }
    object.release();
  }

  /**
   * @param {!RemoteObject} object
   */
  _copyRequested(object) {
    if (!object.objectId) {
      Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(
          object.unserializableValue() || /** @type {string} */ (object.value));
      return;
    }
    object.callFunctionJSON(toStringForClipboard, [{value: object.subtype}])
        .then(Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText.bind(
            Host.InspectorFrontendHost.InspectorFrontendHostInstance));

    /**
     * @param {string} subtype
     * @this {Object}
     * @suppressReceiverCheck
     */
    function toStringForClipboard(subtype) {
      if (subtype === 'node') {
        return this.outerHTML;
      }
      if (subtype && typeof this === 'undefined') {
        return subtype + '';
      }
      try {
        return JSON.stringify(this, null, '  ');
      } catch (e) {
        return '' + this;
      }
    }
  }

  /**
   * @param {!RemoteObject} object
   */
  async _queryObjectsRequested(object) {
    const result = await this.queryObjects(object);
    object.release();
    if (result.error) {
      self.Common.console.error(result.error);
      return;
    }
    this.dispatchEventToListeners(Events.QueryObjectRequested, {objects: result.objects});
  }

  /**
   * @param {!Protocol.Runtime.ExceptionDetails} exceptionDetails
   * @return {string}
   */
  static simpleTextFromException(exceptionDetails) {
    let text = exceptionDetails.text;
    if (exceptionDetails.exception && exceptionDetails.exception.description) {
      let description = exceptionDetails.exception.description;
      if (description.indexOf('\n') !== -1) {
        description = description.substring(0, description.indexOf('\n'));
      }
      text += ' ' + description;
    }
    return text;
  }

  /**
   * @param {number} timestamp
   * @param {!Protocol.Runtime.ExceptionDetails} exceptionDetails
   */
  exceptionThrown(timestamp, exceptionDetails) {
    const exceptionWithTimestamp = {timestamp: timestamp, details: exceptionDetails};
    this.dispatchEventToListeners(Events.ExceptionThrown, exceptionWithTimestamp);
  }

  /**
   * @param {number} exceptionId
   */
  _exceptionRevoked(exceptionId) {
    this.dispatchEventToListeners(Events.ExceptionRevoked, exceptionId);
  }

  /**
   * @param {string} type
   * @param {!Array.<!Protocol.Runtime.RemoteObject>} args
   * @param {number} executionContextId
   * @param {number} timestamp
   * @param {!Protocol.Runtime.StackTrace=} stackTrace
   * @param {string=} context
   */
  _consoleAPICalled(type, args, executionContextId, timestamp, stackTrace, context) {
    const consoleAPICall = {
      type: type,
      args: args,
      executionContextId: executionContextId,
      timestamp: timestamp,
      stackTrace: stackTrace,
      context: context,
    };
    this.dispatchEventToListeners(Events.ConsoleAPICalled, consoleAPICall);
  }

  /**
   * @param {!Protocol.Runtime.ScriptId} scriptId
   * @return {number}
   */
  executionContextIdForScriptId(scriptId) {
    const script = this.debuggerModel().scriptForId(scriptId);
    return script ? script.executionContextId : 0;
  }

  /**
   * @param {!Protocol.Runtime.StackTrace} stackTrace
   * @return {number}
   */
  executionContextForStackTrace(stackTrace) {
    while (stackTrace && !stackTrace.callFrames.length) {
      stackTrace = stackTrace.parent;
    }
    if (!stackTrace || !stackTrace.callFrames.length) {
      return 0;
    }
    return this.executionContextIdForScriptId(stackTrace.callFrames[0].scriptId);
  }

  /**
   * @return {?boolean}
   */
  hasSideEffectSupport() {
    return this._hasSideEffectSupport;
  }

  /**
   * @return {!Promise<boolean>}
   */
  async checkSideEffectSupport() {
    const testContext = this.executionContexts().peekLast();
    if (!testContext) {
      return false;
    }
    // Check for a positive throwOnSideEffect response without triggering side effects.
    const response = await this._agent.invoke_evaluate({
      expression: _sideEffectTestExpression,
      contextId: testContext.id,
      throwOnSideEffect: true,
    });

    this._hasSideEffectSupport = RuntimeModel.isSideEffectFailure(response);
    return this._hasSideEffectSupport;
  }

  /**
   * @return {!Promise}
   */
  terminateExecution() {
    return this._agent.invoke_terminateExecution({});
  }
}
RuntimeModel.setBreakOnStart = setBreakOnStart;


/**
 * This expression:
 * - IMPORTANT: must not actually cause user-visible or JS-visible side-effects.
 * - Must throw when evaluated with `throwOnSideEffect: true`.
 * - Must be valid when run from any ExecutionContext that supports `throwOnSideEffect`.
 * @const
 * @type {string}
 */
const _sideEffectTestExpression = '(async function(){ await 1; })()';

/** @enum {symbol} */
export const Events = {
  ExecutionContextCreated: Symbol('ExecutionContextCreated'),
  ExecutionContextDestroyed: Symbol('ExecutionContextDestroyed'),
  ExecutionContextChanged: Symbol('ExecutionContextChanged'),
  ExecutionContextOrderChanged: Symbol('ExecutionContextOrderChanged'),
  ExceptionThrown: Symbol('ExceptionThrown'),
  ExceptionRevoked: Symbol('ExceptionRevoked'),
  ConsoleAPICalled: Symbol('ConsoleAPICalled'),
  QueryObjectRequested: Symbol('QueryObjectRequested'),
};

/**
 * @extends {Protocol.RuntimeDispatcher}
 * @unrestricted
 */
class RuntimeDispatcher {
  /**
   * @param {!RuntimeModel} runtimeModel
   */
  constructor(runtimeModel) {
    this._runtimeModel = runtimeModel;
  }

  /**
   * @override
   * @param {!Protocol.Runtime.ExecutionContextDescription} context
   */
  executionContextCreated(context) {
    this._runtimeModel._executionContextCreated(context);
  }

  /**
   * @override
   * @param {!Protocol.Runtime.ExecutionContextId} executionContextId
   */
  executionContextDestroyed(executionContextId) {
    this._runtimeModel._executionContextDestroyed(executionContextId);
  }

  /**
   * @override
   */
  executionContextsCleared() {
    this._runtimeModel._executionContextsCleared();
  }

  /**
   * @override
   * @param {number} timestamp
   * @param {!Protocol.Runtime.ExceptionDetails} exceptionDetails
   */
  exceptionThrown(timestamp, exceptionDetails) {
    this._runtimeModel.exceptionThrown(timestamp, exceptionDetails);
  }

  /**
   * @override
   * @param {string} reason
   * @param {number} exceptionId
   */
  exceptionRevoked(reason, exceptionId) {
    this._runtimeModel._exceptionRevoked(exceptionId);
  }

  /**
   * @override
   * @param {string} type
   * @param {!Array.<!Protocol.Runtime.RemoteObject>} args
   * @param {number} executionContextId
   * @param {number} timestamp
   * @param {!Protocol.Runtime.StackTrace=} stackTrace
   * @param {string=} context
   */
  consoleAPICalled(type, args, executionContextId, timestamp, stackTrace, context) {
    this._runtimeModel._consoleAPICalled(type, args, executionContextId, timestamp, stackTrace, context);
  }

  /**
   * @override
   * @param {!Protocol.Runtime.RemoteObject} payload
   * @param {!Object=} hints
   */
  inspectRequested(payload, hints) {
    this._runtimeModel._inspectRequested(payload, hints);
  }
}

/**
 * @unrestricted
 */
export class ExecutionContext {
  /**
   * @param {!RuntimeModel} runtimeModel
   * @param {number} id
   * @param {string} name
   * @param {string} origin
   * @param {boolean} isDefault
   * @param {string=} frameId
   */
  constructor(runtimeModel, id, name, origin, isDefault, frameId) {
    this.id = id;
    this.name = name;
    this.origin = origin;
    this.isDefault = isDefault;
    this.runtimeModel = runtimeModel;
    this.debuggerModel = runtimeModel.debuggerModel();
    this.frameId = frameId;
    this._setLabel('');
  }

  /**
   * @return {!Target}
   */
  target() {
    return this.runtimeModel.target();
  }

  /**
   * @param {!ExecutionContext} a
   * @param {!ExecutionContext} b
   * @return {number}
   */
  static comparator(a, b) {
    /**
     * @param {!Target} target
     * @return {number}
     */
    function targetWeight(target) {
      if (!target.parentTarget()) {
        return 5;
      }
      if (target.type() === Type.Frame) {
        return 4;
      }
      if (target.type() === Type.ServiceWorker) {
        return 3;
      }
      if (target.type() === Type.Worker) {
        return 2;
      }
      return 1;
    }

    /**
     * @param {!Target} target
     * @return {!Array<!Target>}
     */
    function targetPath(target) {
      let currentTarget = target;
      const parents = [];
      while (currentTarget) {
        parents.push(currentTarget);
        currentTarget = currentTarget.parentTarget();
      }
      return parents.reverse();
    }

    const tagetsA = targetPath(a.target());
    const targetsB = targetPath(b.target());
    let targetA;
    let targetB;
    for (let i = 0;; i++) {
      if (!tagetsA[i] || !targetsB[i] || (tagetsA[i] !== targetsB[i])) {
        targetA = tagetsA[i];
        targetB = targetsB[i];
        break;
      }
    }
    if (!targetA && targetB) {
      return -1;
    }

    if (!targetB && targetA) {
      return 1;
    }

    if (targetA && targetB) {
      const weightDiff = targetWeight(targetA) - targetWeight(targetB);
      if (weightDiff) {
        return -weightDiff;
      }
      return targetA.id().localeCompare(targetB.id());
    }

    // Main world context should always go first.
    if (a.isDefault) {
      return -1;
    }
    if (b.isDefault) {
      return +1;
    }
    return a.name.localeCompare(b.name);
  }

  /**
   * @param {!EvaluationOptions} options
   * @param {boolean} userGesture
   * @param {boolean} awaitPromise
   * @return {!Promise<!EvaluationResult>}
   */
  evaluate(options, userGesture, awaitPromise) {
    // FIXME: It will be moved to separate ExecutionContext.
    if (this.debuggerModel.selectedCallFrame()) {
      return this.debuggerModel.evaluateOnSelectedCallFrame(options);
    }
    // Assume backends either support both throwOnSideEffect and timeout options or neither.
    const needsTerminationOptions = !!options.throwOnSideEffect || options.timeout !== undefined;
    if (!needsTerminationOptions || this.runtimeModel.hasSideEffectSupport()) {
      return this._evaluateGlobal(options, userGesture, awaitPromise);
    }

    /** @type {!EvaluationResult} */
    const unsupportedError = {error: 'Side-effect checks not supported by backend.'};
    if (this.runtimeModel.hasSideEffectSupport() === false) {
      return Promise.resolve(unsupportedError);
    }

    return this.runtimeModel.checkSideEffectSupport().then(() => {
      if (this.runtimeModel.hasSideEffectSupport()) {
        return this._evaluateGlobal(options, userGesture, awaitPromise);
      }
      return Promise.resolve(unsupportedError);
    });
  }

  /**
   * @param {string} objectGroup
   * @param {boolean} generatePreview
   * @return {!Promise<!EvaluationResult>}
   */
  globalObject(objectGroup, generatePreview) {
    return this._evaluateGlobal(
        {
          expression: 'this',
          objectGroup: objectGroup,
          includeCommandLineAPI: false,
          silent: true,
          returnByValue: false,
          generatePreview: generatePreview,
        },
        /* userGesture */ false, /* awaitPromise */ false);
  }

  /**
   * @param {!EvaluationOptions} options
   * @param {boolean} userGesture
   * @param {boolean} awaitPromise
   * @return {!Promise<!EvaluationResult>}
   */
  async _evaluateGlobal(options, userGesture, awaitPromise) {
    if (!options.expression) {
      // There is no expression, so the completion should happen against global properties.
      options.expression = 'this';
    }

    const response = await this.runtimeModel._agent.invoke_evaluate({
      expression: options.expression,
      objectGroup: options.objectGroup,
      includeCommandLineAPI: options.includeCommandLineAPI,
      silent: options.silent,
      contextId: this.id,
      returnByValue: options.returnByValue,
      generatePreview: options.generatePreview,
      userGesture: userGesture,
      awaitPromise: awaitPromise,
      throwOnSideEffect: options.throwOnSideEffect,
      timeout: options.timeout,
      disableBreaks: options.disableBreaks,
      replMode: options.replMode,
    });

    const error = response[ProtocolModule.InspectorBackend.ProtocolError];
    if (error) {
      console.error(error);
      return {error: error};
    }
    return {object: this.runtimeModel.createRemoteObject(response.result), exceptionDetails: response.exceptionDetails};
  }

  /**
   * @return {!Promise<?Array<string>>}
   */
  async globalLexicalScopeNames() {
    const response = await this.runtimeModel._agent.invoke_globalLexicalScopeNames({executionContextId: this.id});
    return response[ProtocolModule.InspectorBackend.ProtocolError] ? [] : response.names;
  }

  /**
   * @return {string}
   */
  label() {
    return this._label;
  }

  /**
   * @param {string} label
   */
  setLabel(label) {
    this._setLabel(label);
    this.runtimeModel.dispatchEventToListeners(Events.ExecutionContextChanged, this);
  }

  /**
   * @param {string} label
   */
  _setLabel(label) {
    if (label) {
      this._label = label;
      return;
    }
    if (this.name) {
      this._label = this.name;
      return;
    }
    const parsedUrl = Common.ParsedURL.ParsedURL.fromString(this.origin);
    this._label = parsedUrl ? parsedUrl.lastPathComponentWithFragment() : '';
  }
}

SDKModel.register(RuntimeModel, Capability.JS, true);

/** @typedef {{
 *    object: (!RemoteObject|undefined),
 *    exceptionDetails: (!Protocol.Runtime.ExceptionDetails|undefined),
 *    error: (!Protocol.Error|undefined)}
 *  }}
 */
export let EvaluationResult;

/** @typedef {{
 *    scriptId: (Protocol.Runtime.ScriptId|undefined),
 *    exceptionDetails: (!Protocol.Runtime.ExceptionDetails|undefined)
 *  }}
 */
export let CompileScriptResult;

/** @typedef {{
 *    expression: string,
 *    objectGroup: (string|undefined),
 *    includeCommandLineAPI: (boolean|undefined),
 *    silent: (boolean|undefined),
 *    returnByValue: (boolean|undefined),
 *    generatePreview: (boolean|undefined),
 *    throwOnSideEffect: (boolean|undefined),
 *    timeout: (number|undefined),
 *    disableBreaks: (boolean|undefined),
 *    replMode: (boolean|undefined)
 *  }}
 */
export let EvaluationOptions;

/** @typedef {{
 *    objects: (!RemoteObject|undefined),
 *    error: (!Protocol.Error|undefined)}
 *  }}
 */
export let QueryObjectResult;
