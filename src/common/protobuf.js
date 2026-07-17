/**
 * @file protobuf.js
 * @description 极简 Protobuf 二进制扫描、反序列化及 Apple WLOC 坐标修改算法
 */

import { logger } from "./adapter.js";

/**
 * 从二进制 Buffer 的指定偏移量读取 Varint 可变长整型
 * @param {Uint8Array|Array} buffer 数据源
 * @param {number} offset 偏移位置
 * @returns {[number, number]} [解码出来的数值, 下一个字节的偏移位置]
 */
export function readVarint(buffer, offset) {
  let result = 0;
  let shift = 1;
  let bitLength = 0;

  for (; offset < buffer.length; ) {
    const byte = buffer[offset++];
    
    // 取低 7 位进行位移累加
    if (bitLength < 56) {
      result += (byte & 0x7F) * shift;
    }
    
    // 若最高位 (MSB) 为 0，说明 Varint 解析结束
    if (!(byte & 0x80)) {
      return [result, offset];
    }
    
    shift *= 128;
    bitLength += 7;
    
    if (bitLength >= 70) {
      throw new Error("Varint parsing error: value too long.");
    }
  }
  throw new Error("Varint parsing error: truncated data.");
}

/**
 * 将整型数值编码为 Varint 可变长整型的字节数组
 * @param {number} value 要编码的数值
 * @returns {number[]} 编码后的字节数组
 */
export function writeVarint(value) {
  let temp = Math.floor(value);
  
  // 处理正数
  if (temp >= 0) {
    const bytes = [];
    while (temp >= 128) {
      bytes.push((temp % 128) | 0x80);
      temp = Math.floor(temp / 128);
    }
    bytes.push(temp);
    return bytes;
  }

  // 处理负数 (iOS/Javascript 64位补码处理)
  const complement = [0, 0, 0, 0, 0, 0, 0, 0];
  let positivePart = -temp;
  for (let i = 0; i < 8; i++) {
    complement[i] = positivePart & 0xFF;
    positivePart = Math.floor(positivePart / 256);
  }
  
  let carry = 1;
  for (let i = 0; i < 8; i++) {
    const val = (255 & ~complement[i]) + carry;
    complement[i] = val & 0xFF;
    carry = val >> 8;
  }

  const bytes = [];
  for (let i = 0; i < 10; i++) {
    let byteVal = 0;
    for (let r = 0; r < 7; r++) {
      const bitIndex = 7 * i + r;
      if (bitIndex < 64) {
        byteVal |= ((complement[bitIndex >> 3] >> (bitIndex & 7)) & 1) << r;
      }
    }
    if (i < 9) {
      byteVal |= 0x80;
    }
    bytes.push(byteVal);
  }
  return bytes;
}

/**
 * 展平嵌套的二维字节数组为一维 Uint8Array
 * @param {Array} arrays 字节数组列表
 * @returns {number[]} 展平后的一维数组
 */
function flattenBytes(arrays) {
  const result = [];
  for (let i = 0; i < arrays.length; i++) {
    for (let j = 0; j < arrays[i].length; j++) {
      result.push(arrays[i][j] & 0xFF);
    }
  }
  return result;
}

/**
 * 线性扫描 Protobuf 二进制数据，将其分解为字段项数组
 * @param {Uint8Array|Array} buffer 原始 Protobuf 二进制数据
 * @returns {Array<{fieldNo: number, wireType: number, value: Uint8Array|number, raw: Uint8Array}>} 字段列表
 */
export function scanProtobufFields(buffer) {
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const startOffset = offset;
    const [tag, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;

    const fieldNo = Math.floor(tag / 8);
    const wireType = tag & 0x07;

    if (fieldNo === 0) {
      throw new Error(`Invalid protobuf field number 0 at offset ${startOffset}`);
    }

    let fieldValue;
    if (wireType === 0) { // Varint
      const [val, next] = readVarint(buffer, offset);
      fieldValue = val;
      offset = next;
    } else if (wireType === 1) { // 64-bit
      fieldValue = buffer.slice(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) { // Length-delimited (String / SubMessage / Bytes)
      const [len, next] = readVarint(buffer, offset);
      offset = next;
      fieldValue = buffer.slice(offset, offset + len);
      offset += len;
    } else if (wireType === 5) { // 32-bit
      fieldValue = buffer.slice(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType} at offset ${startOffset}`);
    }

    fields.push({
      fieldNo,
      wireType,
      value: fieldValue,
      raw: buffer.slice(startOffset, offset)
    });
  }
  return fields;
}

/**
 * 重新打包单个 Protobuf 字段为二进制数组
 * @param {number} fieldNo 字段编号
 * @param {number} wireType 字段线类型
 * @param {number|Uint8Array|Array} value 字段数值
 * @returns {number[]} 重新组装后的字节数组
 */
export function encodeProtobufField(fieldNo, wireType, value) {
  const tagBytes = writeVarint((fieldNo << 3) | wireType);

  if (wireType === 0) { // Varint
    return flattenBytes([tagBytes, writeVarint(value)]);
  }
  if (wireType === 1 || wireType === 5) { // 64-bit / 32-bit
    return flattenBytes([tagBytes, value]);
  }
  if (wireType === 2) { // Length-delimited
    return flattenBytes([tagBytes, writeVarint(value.length), value]);
  }
  throw new Error(`Cannot encode wire type ${wireType}`);
}

/**
 * 对基站定位的地理坐标字段 (Field 1 和 Field 2) 进行篡改
 * @param {Uint8Array} buffer 包含坐标的子报文
 * @param {object} targetLocation 目标虚拟坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
function patchCoordinates(buffer, targetLocation, stats) {
  const fields = scanProtobufFields(buffer);
  let hasLat = false;
  let hasLon = false;

  for (const field of fields) {
    if (field.fieldNo === 1 && field.wireType === 0) hasLat = true; // 纬度字段
    if (field.fieldNo === 2 && field.wireType === 0) hasLon = true; // 经度字段
  }

  // 如果不包含经度或纬度字段，说明并不是有效的坐标消息，不进行处理
  if (!hasLat || !hasLon) {
    return buffer;
  }

  const patchedRawFields = [];
  for (const field of fields) {
    if (field.fieldNo === 1 && field.wireType === 0) {
      // 写入修改后的高精度纬度 (经纬度用乘以 10^8 的数值存储)
      patchedRawFields.push(encodeProtobufField(1, 0, Math.round(1e8 * targetLocation.latitude)));
    } else if (field.fieldNo === 2 && field.wireType === 0) {
      // 写入修改后的高精度经度
      patchedRawFields.push(encodeProtobufField(2, 0, Math.round(1e8 * targetLocation.longitude)));
    } else if (field.fieldNo === 3 && field.wireType === 0) {
      // 写入修改后的水平定位精度
      patchedRawFields.push(encodeProtobufField(3, 0, targetLocation.accuracy));
    } else {
      patchedRawFields.push(field.raw);
    }
  }

  stats.locations++;
  return flattenBytes(patchedRawFields);
}

/**
 * 递归扫描 Wi-Fi 定位列表 (Field 2)，执行坐标替换
 * @param {Uint8Array} buffer WiFi子报文
 * @param {object} targetLocation 目标虚拟坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
function patchWiFiPayloads(buffer, targetLocation, stats) {
  const fields = scanProtobufFields(buffer);
  let isWiFiStruct = false;

  // WLOC 报文中，Wi-Fi 消息通常包含一个格式合规的 MAC 地址字段 (Field 1, 格式形如 xx:xx:xx:xx:xx:xx)
  for (const field of fields) {
    if (field.fieldNo === 1 && field.wireType === 2) {
      const macStr = Array.from(field.value).map(b => String.fromCharCode(b & 0xFF)).join("");
      isWiFiStruct = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(macStr);
    }
  }

  if (!isWiFiStruct) return buffer;

  let isPatched = false;
  const patchedRawFields = [];

  for (const field of fields) {
    // Field 2 是对应的地理坐标子消息 (包含经纬度)
    if (field.fieldNo === 2 && field.wireType === 2) {
      try {
        const originalBytes = field.value;
        const modifiedBytes = patchCoordinates(originalBytes, targetLocation, stats);
        
        // 判断坐标是否发生了变动
        const isChanged = originalBytes.length !== modifiedBytes.length || 
                          !originalBytes.every((val, index) => val === modifiedBytes[index]);
        if (isChanged) isPatched = true;
        
        patchedRawFields.push(encodeProtobufField(field.fieldNo, field.wireType, modifiedBytes));
      } catch {
        stats.skipped++;
        patchedRawFields.push(field.raw);
      }
    } else {
      patchedRawFields.push(field.raw);
    }
  }

  if (isPatched) stats.wifi++;
  return flattenBytes(patchedRawFields);
}

/**
 * 递归扫描蜂窝基站定位列表 (Field 5)，执行坐标替换
 * @param {Uint8Array} buffer 基站子报文
 * @param {object} targetLocation 目标虚拟坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
function patchCellTowerPayloads(buffer, targetLocation, stats) {
  const fields = scanProtobufFields(buffer);
  let isPatched = false;
  const patchedRawFields = [];

  for (const field of fields) {
    // Field 5 是基站对应的地理坐标子消息 (包含经纬度)
    if (field.fieldNo === 5 && field.wireType === 2) {
      try {
        const originalBytes = field.value;
        const modifiedBytes = patchCoordinates(originalBytes, targetLocation, stats);
        
        const isChanged = originalBytes.length !== modifiedBytes.length ||
                          !originalBytes.every((val, index) => val === modifiedBytes[index]);
        if (isChanged) isPatched = true;

        patchedRawFields.push(encodeProtobufField(field.fieldNo, field.wireType, modifiedBytes));
      } catch {
        stats.skipped++;
        patchedRawFields.push(field.raw);
      }
    } else {
      patchedRawFields.push(field.raw);
    }
  }

  if (isPatched) stats.cell++;
  return flattenBytes(patchedRawFields);
}

/**
 * 遍历 WLOC 最外层包结构
 * @param {Uint8Array} buffer 解密出的整体 WLOC 报文
 * @param {object} targetLocation 目标虚拟坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
export function traverseWlocEnvelope(buffer, targetLocation, stats) {
  const fields = scanProtobufFields(buffer);
  const patchedRawFields = [];

  for (const field of fields) {
    // Field 2 (Wi-Fi) 或 Field 22/24 (蜂窝基站) 的信封结构
    if (field.wireType === 2 && field.fieldNo === 2) {
      patchedRawFields.push(encodeProtobufField(field.fieldNo, field.wireType, patchWiFiPayloads(field.value, targetLocation, stats)));
    } else if (field.wireType === 2 && (field.fieldNo === 22 || field.fieldNo === 24)) {
      patchedRawFields.push(encodeProtobufField(field.fieldNo, field.wireType, patchCellTowerPayloads(field.value, targetLocation, stats)));
    } else {
      patchedRawFields.push(field.raw);
    }
  }

  return flattenBytes(patchedRawFields);
}

/**
 * 单偏移量 WLOC 数据包反序列化与 Patch 尝试
 * @param {Uint8Array} buffer 整体解压后的报文
 * @param {number} baseOffset 报文头部偏移量
 * @param {object} targetLocation 目标虚拟坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
function tryPatchAtOffset(buffer, baseOffset, targetLocation, stats) {
  if (buffer.length < baseOffset + 10) {
    throw new Error(`Payload buffer is too short (${buffer.length} bytes) at base offset ${baseOffset}`);
  }

  // WLOC 报文中，以 BigEndian 读取偏移之后的第 8、9 字节作为 payload 的长度字段
  const payloadLen = (buffer[baseOffset + 8] << 8) | buffer[baseOffset + 9];
  if (payloadLen <= 0) {
    throw new Error(`Invalid empty frame length at offset ${baseOffset}`);
  }
  if (payloadLen + baseOffset + 10 > buffer.length) {
    throw new Error(`Invalid frame size: length ${payloadLen} exceeds buffer boundaries at offset ${baseOffset}`);
  }

  const headerBytes = buffer.slice(0, baseOffset + 8);
  const payloadBytes = buffer.slice(baseOffset + 10, baseOffset + 10 + payloadLen);
  const trailingBytes = buffer.slice(baseOffset + 10 + payloadLen);

  const prevStats = { ...stats };
  const modifiedPayloadBytes = traverseWlocEnvelope(payloadBytes, targetLocation, stats);

  const totalModifications = (stats.locations - prevStats.locations) + 
                             (stats.wifi - prevStats.wifi) + 
                             (stats.cell - prevStats.cell);

  const isIdentical = payloadBytes.length === modifiedPayloadBytes.length &&
                      payloadBytes.every((val, idx) => val === modifiedPayloadBytes[idx]);

  if (totalModifications <= 0 || isIdentical) {
    // 还原统计数据
    stats.wifi = prevStats.wifi;
    stats.cell = prevStats.cell;
    stats.locations = prevStats.locations;
    stats.skipped = prevStats.skipped;
    throw new Error(`Parse passed, but no modifiable WLOC payload found at offset ${baseOffset}`);
  }

  if (modifiedPayloadBytes.length > 65535) {
    throw new Error("Patched payload size exceeds the 16-bit integer boundary (65535 bytes).");
  }

  // 构造重打包后的数据：[头信息] + [新的16位BigEndian长度] + [修改后的消息体] + [尾部挂载数据]
  const newLenBytes = [modifiedPayloadBytes.length >> 8 & 0xFF, modifiedPayloadBytes.length & 0xFF];
  return flattenBytes([headerBytes, newLenBytes, modifiedPayloadBytes, trailingBytes]);
}

/**
 * 递归扫描裸数据（无头部封装数据）的后备方案
 * @param {Uint8Array} buffer 报文数据
 * @param {object} targetLocation 目标坐标
 * @param {object} stats 统计对象
 * @returns {number[]} 修改后的报文
 */
function tryRawProtobufFallback(buffer, targetLocation, stats) {
  const errors = [];
  const maxScanBytes = Math.min(256, buffer.length);

  for (let offset = 0; offset <= maxScanBytes; offset++) {
    const prevStats = { ...stats };
    try {
      const scanSlice = buffer.slice(offset);
      const modifiedSlice = traverseWlocEnvelope(scanSlice, targetLocation, stats);
      
      const totalModifications = (stats.locations - prevStats.locations) + 
                                 (stats.wifi - prevStats.wifi) + 
                                 (stats.cell - prevStats.cell);
      
      const isIdentical = scanSlice.length === modifiedSlice.length &&
                          scanSlice.every((val, idx) => val === modifiedSlice[idx]);

      if (totalModifications > 0 && !isIdentical) {
        return flattenBytes([buffer.slice(0, offset), modifiedSlice]);
      }
      
      // 状态重置
      stats.wifi = prevStats.wifi;
      stats.cell = prevStats.cell;
      stats.locations = prevStats.locations;
      stats.skipped = prevStats.skipped;
    } catch (e) {
      stats.wifi = prevStats.wifi;
      stats.cell = prevStats.cell;
      stats.locations = prevStats.locations;
      stats.skipped = prevStats.skipped;
      if (errors.length < 6) {
        errors.push(`raw@offset_${offset}:${e?.message || e}`);
      }
    }
  }
  throw new Error(`Raw fallback scan failed: ${errors.join(" | ")}`);
}

/**
 * 修改 WLOC 数据包定位信息的最高层主入口 (支持多段偏移量尝试)
 * @param {Uint8Array} buffer 整体解压缩后的原始 WLOC 数据包
 * @param {object} targetLocation 目标定位坐标
 * @returns {{data: number[], stats: {wifi: number, cell: number, locations: number, skipped: number}}} 修改后的二进制数据及修改统计
 */
export function patchWlocPayload(buffer, targetLocation) {
  const stats = {
    wifi: 0,
    cell: 0,
    locations: 0,
    skipped: 0
  };

  if (buffer.length < 10) {
    throw new Error(`WLOC raw payload is too short (${buffer.length} bytes)`);
  }

  const errors = [];
  // 定义常见的头部可能偏移位置
  const candidateOffsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  
  // 补全所有扫描的偏移边界限制 (防止遗漏任意偏移对齐)
  const maxSearchBound = Math.min(96, Math.max(0, buffer.length - 10));
  for (let i = 0; i <= maxSearchBound; i++) {
    if (!candidateOffsets.includes(i)) candidateOffsets.push(i);
  }

  // 1. 尝试使用常规包含长度头的段对齐模式进行 Patch
  for (const offset of candidateOffsets) {
    const prevStats = { ...stats };
    try {
      const patchedData = tryPatchAtOffset(buffer, offset, targetLocation, stats);
      logger.info(`[Protobuf] 成功在偏移 offset=${offset} 处应用补丁。修改项: Wi-Fi=${stats.wifi}, 基站=${stats.cell}, 修改坐标=${stats.locations}`);
      return { data: patchedData, stats };
    } catch (e) {
      stats.wifi = prevStats.wifi;
      stats.cell = prevStats.cell;
      stats.locations = prevStats.locations;
      stats.skipped = prevStats.skipped;
      if (errors.length < 6) {
        errors.push(`offset_${offset}:${e?.message || e}`);
      }
    }
  }

  // 2. 若常规扫描全部失败，尝试后备方案：对裸 Protobuf 数据流暴力线性平移扫描
  try {
    const patchedData = tryRawProtobufFallback(buffer, targetLocation, stats);
    logger.info(`[Protobuf] 成功通过暴力扫描后备方案应用补丁。修改项: Wi-Fi=${stats.wifi}, 基站=${stats.cell}, 修改坐标=${stats.locations}`);
    return { data: patchedData, stats };
  } catch (e) {
    errors.push(`fallback_error:${e?.message || e}`);
  }

  throw new Error(`No patchable WLOC payload found in this response. Details: ${errors.join(" | ")}`);
}

/**
 * Helper to convert Uint8Array/Array to hex string.
 */
function bytesToHex(bytes) {
  if (!bytes) return "";
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decode a generic field into a readable format.
 */
function decodeGenericField(field) {
  if (field.wireType === 0) {
    return field.value; // Varint value (number)
  }
  if (field.wireType === 1 || field.wireType === 5) {
    return bytesToHex(field.value);
  }
  if (field.wireType === 2) {
    const bytes = field.value;
    const isPrintable = bytes.length > 0 && Array.from(bytes).every(b => b >= 32 && b <= 126);
    if (isPrintable) {
      return Array.from(bytes).map(b => String.fromCharCode(b)).join("");
    }
    return bytesToHex(bytes);
  }
  return null;
}

/**
 * Decode the location structure (Field 1 = Lat, Field 2 = Lon, Field 3 = Acc).
 */
function decodeLocation(buffer) {
  try {
    const fields = scanProtobufFields(buffer);
    const result = {
      latitude: null,
      longitude: null,
      accuracy: null,
      extraFields: {}
    };
    for (const field of fields) {
      if (field.fieldNo === 1 && field.wireType === 0) {
        result.latitude = field.value / 1e8;
      } else if (field.fieldNo === 2 && field.wireType === 0) {
        result.longitude = field.value / 1e8;
      } else if (field.fieldNo === 3 && field.wireType === 0) {
        result.accuracy = field.value;
      } else {
        result.extraFields[`field_${field.fieldNo}`] = decodeGenericField(field);
      }
    }
    return result;
  } catch (e) {
    return { raw: bytesToHex(buffer), error: e.message };
  }
}

/**
 * Decode individual Wi-Fi message in Field 2.
 */
function decodeWiFiMessage(buffer) {
  try {
    const fields = scanProtobufFields(buffer);
    const result = {
      bssid: "",
      location: null,
      extraFields: {}
    };
    for (const field of fields) {
      if (field.fieldNo === 1 && field.wireType === 2) {
        result.bssid = Array.from(field.value).map(b => String.fromCharCode(b & 0xFF)).join("");
      } else if (field.fieldNo === 2 && field.wireType === 2) {
        result.location = decodeLocation(field.value);
      } else {
        result.extraFields[`field_${field.fieldNo}`] = decodeGenericField(field);
      }
    }
    return result;
  } catch (e) {
    return { raw: bytesToHex(buffer), error: e.message };
  }
}

/**
 * Decode individual Cell Tower message in Field 22/24.
 */
function decodeCellTowerMessage(buffer) {
  try {
    const fields = scanProtobufFields(buffer);
    const result = {
      location: null,
      extraFields: {}
    };
    for (const field of fields) {
      if (field.fieldNo === 5 && field.wireType === 2) {
        result.location = decodeLocation(field.value);
      } else {
        result.extraFields[`field_${field.fieldNo}`] = decodeGenericField(field);
      }
    }
    return result;
  } catch (e) {
    return { raw: bytesToHex(buffer), error: e.message };
  }
}

/**
 * Parse a WLOC envelope payload.
 */
export function decodeWlocEnvelope(buffer) {
  const fields = scanProtobufFields(buffer);
  const result = {
    wifiDevices: [],
    cellTowers: [],
    extraFields: {}
  };

  for (const field of fields) {
    if (field.wireType === 2 && field.fieldNo === 2) {
      result.wifiDevices.push(decodeWiFiMessage(field.value));
    } else if (field.wireType === 2 && (field.fieldNo === 22 || field.fieldNo === 24)) {
      result.cellTowers.push(decodeCellTowerMessage(field.value));
    } else {
      result.extraFields[`field_${field.fieldNo}`] = decodeGenericField(field);
    }
  }

  return result;
}

/**
 * Decode uncompressed WLOC packet into JSON representation (handles envelope parsing).
 */
export function decodeWlocToJSON(buffer) {
  if (buffer.length < 10) {
    return { error: `WLOC raw payload too short (${buffer.length} bytes)` };
  }

  const candidateOffsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  const maxSearchBound = Math.min(96, Math.max(0, buffer.length - 10));
  for (let i = 0; i <= maxSearchBound; i++) {
    if (!candidateOffsets.includes(i)) candidateOffsets.push(i);
  }

  // 1. Try to decode with envelope length alignment
  for (const offset of candidateOffsets) {
    try {
      const payloadLen = (buffer[offset + 8] << 8) | buffer[offset + 9];
      if (payloadLen > 0 && payloadLen + offset + 10 <= buffer.length) {
        const payloadBytes = buffer.slice(offset + 10, offset + 10 + payloadLen);
        const decoded = decodeWlocEnvelope(payloadBytes);
        if (decoded.wifiDevices.length > 0 || decoded.cellTowers.length > 0) {
          return {
            parseType: "envelope_offset",
            offset: offset,
            header: bytesToHex(buffer.slice(0, offset + 10)),
            payload: decoded,
            trailing: bytesToHex(buffer.slice(offset + 10 + payloadLen))
          };
        }
      }
    } catch {
      // ignore and try next offset
    }
  }

  // 2. Fallback to parsing directly or violence scan
  const maxScanBytes = Math.min(256, buffer.length);
  for (let offset = 0; offset <= maxScanBytes; offset++) {
    try {
      const decoded = decodeWlocEnvelope(buffer.slice(offset));
      if (decoded.wifiDevices.length > 0 || decoded.cellTowers.length > 0) {
        return {
          parseType: "fallback_raw_scan",
          offset: offset,
          header: bytesToHex(buffer.slice(0, offset)),
          payload: decoded
        };
      }
    } catch {
      // ignore
    }
  }

  // 3. Last fallback: decode generic fields of the buffer itself as a protobuf message
  try {
    const fields = scanProtobufFields(buffer);
    const result = {};
    for (const field of fields) {
      result[`field_${field.fieldNo}`] = decodeGenericField(field);
    }
    return {
      parseType: "generic_protobuf_fallback",
      payload: result
    };
  } catch (e) {
    return {
      parseType: "unparsed_hex",
      rawHex: bytesToHex(buffer),
      error: e.message
    };
  }
}
