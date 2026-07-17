/**
 * @file wloc.js
 * @description Apple WLOC 网络定位拦截与响应篡改脚本主入口
 */

import pako from "pako";
import { logger, storage, done } from "./common/adapter.js";
import { patchWlocPayload, decodeWlocToJSON } from "./common/protobuf.js";

// WLOC 预设默认配置参数（透传判断基准点：深圳市腾讯大厦附近）
const DEFAULT_COORDS = {
  longitude: 113.94114,
  latitude: 22.544577,
  accuracy: 25,
  logLevel: "info"
};

/**
 * 判断字节数组是否是 Gzip 压缩包
 * @param {Uint8Array|Array} bytes 字节数组
 * @returns {boolean}
 */
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * 转换各种格式的 Response body 字段为标准的 Uint8Array 数组
 * @param {*} body 响应体
 * @returns {Uint8Array}
 */
function convertToUint8Array(body) {
  if (!body) return new Uint8Array(0);
  
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (Array.isArray(body)) {
    return new Uint8Array(body);
  }
  if (typeof body === "string") {
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) {
      bytes[i] = body.charCodeAt(i) & 0xFF;
    }
    return bytes;
  }
  return new Uint8Array(0);
}

/**
 * 从 URL QueryString 中解析出参数键值对
 * @param {string} queryString URL的参数部分
 * @returns {Record<string, string>}
 */
function parseQueryString(queryString) {
  const result = {};
  if (!queryString) return result;
  
  const pairs = queryString.split("&");
  for (const pair of pairs) {
    if (!pair) continue;
    const splitIndex = pair.indexOf("=");
    const key = splitIndex === -1 ? pair : pair.slice(0, splitIndex);
    const value = splitIndex === -1 ? "" : pair.slice(splitIndex + 1);
    
    let decodedKey, decodedValue;
    try {
      decodedKey = decodeURIComponent(key.replace(/\+/g, " "));
    } catch {
      decodedKey = key;
    }
    try {
      decodedValue = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      decodedValue = value;
    }
    result[decodedKey] = decodedValue;
  }
  return result;
}

/**
 * 读取最终生效的虚拟定位配置信息
 * @returns {object|null} 目标位置坐标 (若为 null 表示进入“透传模式”，不修改定位)
 */
function getActiveLocation() {
  // 1. 获取来自模块默认参数的配置 ($argument)
  let argConfig = {};
  if (typeof $argument === "string") {
    argConfig = parseQueryString($argument);
  } else if (typeof $argument === "object" && $argument !== null) {
    argConfig = $argument;
  }

  // 2. 从本地持久化存储读取用户在选点控制台储存的配置 (优先级最高)
  let savedConfig = null;
  try {
    const data = storage.getItem("wloc_settings");
    if (data && typeof data === "object") {
      savedConfig = data;
    }
  } catch (e) {
    logger.debug(`[Settings] 读取本地持久化数据失败: ${e.message}`);
  }

  // 3. 构造合并后的定位配置参数
  const activeConfig = { ...DEFAULT_COORDS };

  if (argConfig.longitude) activeConfig.longitude = parseFloat(argConfig.longitude);
  if (argConfig.latitude) activeConfig.latitude = parseFloat(argConfig.latitude);
  if (argConfig.accuracy) activeConfig.accuracy = parseInt(argConfig.accuracy, 10);
  if (argConfig.logLevel) activeConfig.logLevel = argConfig.logLevel;
  if (argConfig.LogLevel) activeConfig.logLevel = argConfig.LogLevel;

  if (savedConfig) {
    if (savedConfig.longitude) activeConfig.longitude = parseFloat(savedConfig.longitude);
    if (savedConfig.latitude) activeConfig.latitude = parseFloat(savedConfig.latitude);
    if (savedConfig.accuracy) activeConfig.accuracy = parseInt(savedConfig.accuracy, 10);
    logger.info(`[Settings] 读取并使用已保存坐标: lon=${activeConfig.longitude}, lat=${activeConfig.latitude}`);
  } else {
    // 若持久化配置为空，且参数中依然为预设的默认坐标点，则判定用户并未自定义过虚拟定位，触发“透传放行”
    const isDefaultLon = Math.abs(activeConfig.longitude - DEFAULT_COORDS.longitude) < 0.00001;
    const isDefaultLat = Math.abs(activeConfig.latitude - DEFAULT_COORDS.latitude) < 0.00001;
    if (isDefaultLon && isDefaultLat) {
      logger.info("[Settings] 未配置自定义目标坐标且参数为默认值，触发透传放行机制（恢复真实定位）");
      return null;
    }
  }

  return activeConfig;
}

// 主执行闭环逻辑
(async () => {
  const requestUrl = typeof $request !== "undefined" ? $request.url : "";
  const response = typeof $response !== "undefined" ? $response : null;

  if (!response) {
    logger.warn("[WLOC] 当前非网络响应处理模式，自动跳过。");
    return done({});
  }

  // 1. 获取目标坐标
  const targetLocation = getActiveLocation();
  if (targetLocation) {
    logger.setLogLevel(targetLocation.logLevel);

    // 如果精度为默认值 25 米，启用动态随机精度和微米级坐标抖动联动算法
    if (targetLocation.accuracy === 25) {
      // 生成 10-30 之间的随机整数精度
      const randomAcc = Math.floor(Math.random() * 21) + 10; // [10, 30]

      // 经纬度微抖动：保留前5位小数不变，第6位到第14位进行随机化，并与精度 A 进行比例联动
      const origLat = targetLocation.latitude;
      const origLon = targetLocation.longitude;

      // 截断到小数点前5位基准（处理正负值以防舍入方向错误）
      const get5DecBase = (val) => {
        const sign = Math.sign(val);
        const absVal = Math.abs(val);
        return sign * (Math.floor(absVal * 100000) / 100000);
      };

      const latBase = get5DecBase(origLat);
      const lonBase = get5DecBase(origLon);

      // 联动：精度 A 越大代表信号越差，抖动幅度越大；精度 A 越小，抖动越小。
      // 我们限制最大抖动范围在 0.00000999999999 度以内（从而绝对不会影响到第5位小数）
      const maxJitterDegree = 0.00000999999999;
      const scaleFactor = randomAcc / 30; // [10/30, 30/30] => [0.33, 1.0]

      // 生成完全随机的第 6 至 14 位小数抖动量
      const latJitter = Math.random() * maxJitterDegree * scaleFactor;
      const lonJitter = Math.random() * maxJitterDegree * scaleFactor;

      const signLat = Math.sign(origLat);
      const signLon = Math.sign(origLon);

      targetLocation.latitude = latBase + (signLat >= 0 ? latJitter : -latJitter);
      targetLocation.longitude = lonBase + (signLon >= 0 ? lonJitter : -lonJitter);
      targetLocation.accuracy = randomAcc;

      logger.info(`[WLOC] 触发 25m 随机抖动算法：动态精度=${randomAcc}m, 经度=${origLon.toFixed(6)}->${targetLocation.longitude}, 纬度=${origLat.toFixed(6)}->${targetLocation.latitude}`);
    }
  }

  logger.group(`WLOC 定位修改服务 - ${requestUrl}`);

  try {
    // 2. 转换 Body 字节流
    const originalBodyBytes = convertToUint8Array(response.bodyBytes || response.rawBody || response.body);
    if (originalBodyBytes.length === 0) {
      logger.warn("[WLOC] 响应体为空字节流，跳过处理。");
      return done(response);
    }

    // 3. 检查是否为透传放行模式 (即恢复真实定位)
    if (!targetLocation || targetLocation.longitude === null || targetLocation.latitude === null) {
      logger.info("[WLOC] 进入透传模式。直接放行，返回真实定位信息。");
      return done(response);
    }

    logger.debug(`[WLOC] 收到原始定位响应. 长度: ${originalBodyBytes.length} 字节. 是否是Gzip压缩: ${isGzip(originalBodyBytes)}`);

    // 4. 判断并执行解压缩
    let uncompressedBytes = originalBodyBytes;
    const wasGzipped = isGzip(originalBodyBytes);
    
    if (wasGzipped) {
      uncompressedBytes = pako.inflate(originalBodyBytes);
    }

    // 打印并输出未修改的完整原始报文 JSON 结构
    try {
      const rawJson = decodeWlocToJSON(uncompressedBytes);
      logger.info(`[WLOC-Raw-Payload-JSON]: ${JSON.stringify(rawJson, null, 2)}`);
    } catch (e) {
      logger.warn(`[WLOC] 打印原始报文 JSON 失败: ${e.message}`);
    }

    // 5. 对解压后的 Protobuf 消息流注入目标坐标
    const { data: patchedPayload, stats } = patchWlocPayload(uncompressedBytes, targetLocation);

    // 6. 将修改后的消息重新打包并以 Gzip 压缩（如果原包是Gzip的话）
    let finalBodyBytes = new Uint8Array(patchedPayload);
    if (wasGzipped) {
      finalBodyBytes = pako.gzip(finalBodyBytes);
    }

    // 7. 回写修改后的二进制响应流
    response.body = finalBodyBytes;
    response.bodyBytes = finalBodyBytes;
    response.rawBody = finalBodyBytes;

    // 清除并规范化 Gzip 相关的 HTTP 标头
    if (response.headers) {
      delete response.headers["Content-Encoding"];
      delete response.headers["content-encoding"];
      delete response.headers["Transfer-Encoding"];
      delete response.headers["transfer-encoding"];
      response.headers["Content-Length"] = String(finalBodyBytes.length);
    }
    
    response.status = 200;
    if (response.statusCode) response.statusCode = 200;

    logger.info(`[WLOC] 篡改成功！目标位置经纬度已变更为: ${targetLocation.longitude}, ${targetLocation.latitude} 精度=${targetLocation.accuracy}米. Patch计数: ${stats.locations}`);
    
    done(response);
  } catch (err) {
    logger.error(`[WLOC] 定位拦截修改失败。错误详情: ${err.message || err}`);
    done(response);
  } finally {
    logger.groupEnd();
  }
})().catch(e => {
  logger.error(`[WLOC] 未捕获的运行时异常: ${e.message}`);
  done({});
});
