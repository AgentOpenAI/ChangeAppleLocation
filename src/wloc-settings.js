/**
 * @file wloc-settings.js
 * @description 网页端选点控制台本地保存/查询/清除逻辑拦截主程序
 */

import { logger, storage, done } from "./common/adapter.js";

const SETTINGS_KEY = "wloc_settings";

/**
 * 从 URL 中提取 Query 参数键值对
 * @param {string} url 请求地址
 * @returns {Map<string, string>}
 */
function getQueryParams(url) {
  const params = new Map();
  const queryString = url.split("?")[1] || "";
  
  if (!queryString) return params;

  const pairs = queryString.split("&");
  for (const pair of pairs) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? "" : pair.slice(index + 1);

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
    params.set(decodedKey, decodedValue);
  }
  return params;
}

// 主逻辑闭环执行
(() => {
  const requestUrl = typeof $request !== "undefined" ? $request.url : "";
  if (!requestUrl) {
    logger.warn("[Settings] 未能截获有效的请求 URL，退出。");
    return done({});
  }

  const queryParams = getQueryParams(requestUrl);
  const action = queryParams.get("action") || "save";
  
  logger.debug(`[Settings] 截获配置管理请求. URL: ${requestUrl}, 执行指令: ${action}`);

  let responseData = {};

  if (action === "query") {
    // 路由 1: 查询当前手机设备已保存的虚拟定位坐标信息
    try {
      const data = storage.getItem(SETTINGS_KEY);
      if (data && typeof data === "object" && data.longitude && data.latitude) {
        responseData = {
          success: true,
          longitude: data.longitude,
          latitude: data.latitude,
          accuracy: data.accuracy || 25,
          updatedAt: data.updatedAt || null
        };
        logger.info(`[Settings] 查询接口: 返回当前已存坐标 lon=${data.longitude}, lat=${data.latitude}`);
      } else {
        responseData = {
          success: false,
          error: "未在设备上检测到已储存的虚拟定位坐标配置。"
        };
      }
    } catch (e) {
      responseData = { success: false, error: `数据读取异常: ${e.message}` };
    }
  } else if (action === "clear") {
    // 路由 2: 清除本地已保存的定位信息（触发透传）
    try {
      const success = storage.removeItem(SETTINGS_KEY);
      if (success) {
        responseData = { success: true };
        logger.info("[Settings] 清除接口: 已成功删除本地持久化定位配置（已恢复真实定位）。");
      } else {
        responseData = { success: false, error: "本地持久化存储配置删除动作返回失败。" };
      }
    } catch (e) {
      responseData = { success: false, error: `数据删除异常: ${e.message}` };
      logger.error(`[Settings] 擦除本地持久化配置失败: ${e.message}`);
    }
  } else {
    // 路由 3: 默认的 save 命令，写入并保存前端选点页面传过来的坐标
    const lon = parseFloat(queryParams.get("lon") || queryParams.get("longitude") || "0");
    const lat = parseFloat(queryParams.get("lat") || queryParams.get("latitude") || "0");
    const acc = parseInt(queryParams.get("acc") || queryParams.get("accuracy") || "25", 10);

    if (lon && lat) {
      // 构造存储实体，附加时区更新戳 (北京时间 UTC+8)
      const savePayload = {
        longitude: lon,
        latitude: lat,
        accuracy: acc,
        updatedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00")
      };

      try {
        const success = storage.setItem(SETTINGS_KEY, savePayload);
        if (success) {
          responseData = {
            success: true,
            longitude: lon,
            latitude: lat,
            accuracy: acc
          };
          logger.info(`[Settings] 写入接口: 成功写入目标经纬度 lon=${lon}, lat=${lat}, 精度=${acc}米.`);
        } else {
          responseData = { success: false, error: "持久化存储写入动作返回失败。" };
          logger.error("[Settings] 写入持久化数据失败: Storage.setItem 返回 false");
        }
      } catch (e) {
        responseData = { success: false, error: `数据写入异常: ${e.message}` };
        logger.error(`[Settings] 写入持久化数据遇到异常: ${e.message}`);
      }
    } else {
      responseData = {
        success: false,
        error: "请求参数错误，缺失有效的经度 (lon) 或纬度 (lat) 数值。"
      };
    }
  }

  // 构造统一跨域 CORS 的 HTTP JSON 响应
  const httpResponse = {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(responseData)
  };

  // 通过环境适配桥接器回包并退出
  done(httpResponse);
})();
