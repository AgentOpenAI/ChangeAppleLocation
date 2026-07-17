(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/common/adapter.js
  function detectEnvironment() {
    const isDefined = (key) => key in globalThis;
    if (isDefined("$task")) return "Quantumult X";
    if (isDefined("$loon")) return "Loon";
    if (isDefined("$rocket")) return "Shadowrocket";
    if (isDefined("Egern")) return "Egern";
    if (globalThis.$environment?.["surge-version"]) return "Surge";
    if (globalThis.$environment?.["stash-version"]) return "Stash";
    if (isDefined("Cloudflare")) return "Worker";
    if (globalThis.process?.versions?.node) return "Node.js";
    return "unknown";
  }
  var env = detectEnvironment();
  var _Logger = class _Logger {
    constructor(level = "INFO") {
      this.currentLevel = _Logger.LOG_LEVELS[level.toUpperCase()] ?? 3;
      this.groupStack = [];
    }
    setLogLevel(level) {
      if (typeof level === "string") {
        this.currentLevel = _Logger.LOG_LEVELS[level.toUpperCase()] ?? 3;
      } else if (typeof level === "number") {
        this.currentLevel = level;
      }
    }
    log(...args) {
      if (this.currentLevel === 0) return;
      let formattedArgs = args.flatMap((arg) => {
        if (typeof arg === "object") return [JSON.stringify(arg)];
        if (["bigint", "number", "boolean"].includes(typeof arg)) return [arg.toString()];
        if (typeof arg === "string") return arg.split(/\r?\n/u);
        return [arg];
      });
      this.groupStack.forEach((groupName) => {
        formattedArgs = formattedArgs.map((line) => `  ${line}`);
        formattedArgs.unshift(` [${groupName}]:`);
      });
      console.log(["", ...formattedArgs].join("\n"));
    }
    error(...args) {
      if (this.currentLevel < _Logger.LOG_LEVELS.ERROR) return;
      const formatted = args.map((arg) => {
        if (env === "Worker" || env === "Node.js") {
          return arg?.stack ?? arg;
        }
        return ` ${arg}`;
      });
      this.log("[ERROR]", ...formatted);
    }
    warn(...args) {
      if (this.currentLevel < _Logger.LOG_LEVELS.WARN) return;
      this.log("[WARN]", ...args.map((a) => ` ${a}`));
    }
    info(...args) {
      if (this.currentLevel < _Logger.LOG_LEVELS.INFO) return;
      this.log("[INFO]", ...args.map((a) => ` ${a}`));
    }
    debug(...args) {
      if (this.currentLevel < _Logger.LOG_LEVELS.DEBUG) return;
      this.log("[DEBUG]", ...args.map((a) => ` ${a}`));
    }
    group(name) {
      this.groupStack.unshift(name);
    }
    groupEnd() {
      this.groupStack.shift();
    }
  };
  __publicField(_Logger, "LOG_LEVELS", {
    OFF: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    ALL: 5
  });
  var Logger = _Logger;
  var logger = new Logger("INFO");
  var memoryStore = {};
  var Storage = class _Storage {
    /**
     * 读取本地配置数据
     * @param {string} key 键名
     * @param {*} defaultValue 默认值
     * @returns {*} 解析后的值或默认值
     */
    static getItem(key, defaultValue = null) {
      let result = defaultValue;
      if (key.startsWith("@")) {
        const match = key.match(/^@(?<rootKey>[^.]+)(?:\.(?<path>.*))?$/);
        if (match) {
          const { rootKey, path } = match.groups;
          const rootData = _Storage.getItem(rootKey, {});
          const pathParts = path ? path.split(".") : [];
          let temp = rootData;
          for (const part of pathParts) {
            if (temp && typeof temp === "object") {
              temp = temp[part];
            } else {
              temp = void 0;
              break;
            }
          }
          return temp !== void 0 ? temp : defaultValue;
        }
      }
      let rawVal = null;
      switch (env) {
        case "Surge":
        case "Loon":
        case "Stash":
        case "Egern":
        case "Shadowrocket":
          rawVal = typeof $persistentStore !== "undefined" ? $persistentStore.read(key) : null;
          break;
        case "Quantumult X":
          rawVal = typeof $prefs !== "undefined" ? $prefs.valueForKey(key) : null;
          break;
        case "Worker":
          rawVal = memoryStore[key] || null;
          break;
        case "Node.js":
          rawVal = _Storage._readNodeStore(key);
          break;
        default:
          rawVal = memoryStore[key] || null;
      }
      if (rawVal !== null && rawVal !== void 0) {
        try {
          result = JSON.parse(rawVal);
        } catch {
          result = rawVal;
        }
      }
      return result ?? defaultValue;
    }
    /**
     * 写入本地配置数据
     * @param {string} key 键名
     * @param {*} value 要写入的值
     * @returns {boolean} 是否成功
     */
    static setItem(key, value) {
      let writeVal = typeof value === "object" ? JSON.stringify(value) : String(value);
      let success = false;
      if (key.startsWith("@")) {
        const match = key.match(/^@(?<rootKey>[^.]+)(?:\.(?<path>.*))?$/);
        if (match) {
          const { rootKey, path } = match.groups;
          const rootData = _Storage.getItem(rootKey, {});
          const setDeepValue = (obj, pathStr, val) => {
            const parts = pathStr.split(".");
            let temp = obj;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!temp[parts[i]] || typeof temp[parts[i]] !== "object") {
                temp[parts[i]] = {};
              }
              temp = temp[parts[i]];
            }
            temp[parts[parts.length - 1]] = val;
          };
          setDeepValue(rootData, path, value);
          return _Storage.setItem(rootKey, rootData);
        }
      }
      switch (env) {
        case "Surge":
        case "Loon":
        case "Stash":
        case "Egern":
        case "Shadowrocket":
          success = typeof $persistentStore !== "undefined" ? $persistentStore.write(writeVal, key) : false;
          break;
        case "Quantumult X":
          success = typeof $prefs !== "undefined" ? $prefs.setValueForKey(writeVal, key) : false;
          break;
        case "Worker":
          memoryStore[key] = writeVal;
          success = true;
          break;
        case "Node.js":
          success = _Storage._writeNodeStore(key, writeVal);
          break;
        default:
          memoryStore[key] = writeVal;
          success = true;
      }
      return success;
    }
    /**
     * 删除本地配置数据
     * @param {string} key 键名
     * @returns {boolean} 是否成功
     */
    static removeItem(key) {
      let success = false;
      if (key.startsWith("@")) {
        const match = key.match(/^@(?<rootKey>[^.]+)(?:\.(?<path>.*))?$/);
        if (match) {
          const { rootKey, path } = match.groups;
          const rootData = _Storage.getItem(rootKey, {});
          const deleteDeepValue = (obj, pathStr) => {
            const parts = pathStr.split(".");
            let temp = obj;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!temp[parts[i]]) return;
              temp = temp[parts[i]];
            }
            delete temp[parts[parts.length - 1]];
          };
          deleteDeepValue(rootData, path);
          return _Storage.setItem(rootKey, rootData);
        }
      }
      switch (env) {
        case "Surge":
          success = typeof $persistentStore !== "undefined" ? $persistentStore.write(null, key) : false;
          break;
        case "Loon":
        case "Stash":
        case "Egern":
        case "Shadowrocket":
          success = typeof $persistentStore !== "undefined" ? $persistentStore.write(null, key) : false;
          break;
        case "Quantumult X":
          success = typeof $prefs !== "undefined" ? $prefs.removeValueForKey(key) : false;
          break;
        case "Worker":
          delete memoryStore[key];
          success = true;
          break;
        case "Node.js":
          success = _Storage._deleteNodeStore(key);
          break;
        default:
          delete memoryStore[key];
          success = true;
      }
      return success;
    }
    // Node.js 环境下本地模拟存储文件读写
    static _readNodeStore(key) {
      try {
        const fs = __require("fs");
        const path = __require("path");
        const filePath = path.resolve(process.cwd(), "box.dat");
        if (fs.existsSync(filePath)) {
          const fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          return fileContent[key] ?? null;
        }
      } catch {
      }
      return null;
    }
    static _writeNodeStore(key, value) {
      try {
        const fs = __require("fs");
        const path = __require("path");
        const filePath = path.resolve(process.cwd(), "box.dat");
        let fileContent = {};
        if (fs.existsSync(filePath)) {
          fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
        fileContent[key] = value;
        fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");
        return true;
      } catch {
      }
      return false;
    }
    static _deleteNodeStore(key) {
      try {
        const fs = __require("fs");
        const path = __require("path");
        const filePath = path.resolve(process.cwd(), "box.dat");
        if (fs.existsSync(filePath)) {
          const fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          delete fileContent[key];
          fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");
          return true;
        }
      } catch {
      }
      return false;
    }
  };
  function done(responseObj = {}) {
    const statusCodes = {
      200: "OK",
      302: "Found",
      400: "Bad Request",
      404: "Not Found",
      500: "Internal Server Error"
    };
    switch (env) {
      case "Surge":
        if (responseObj.policy) responseObj.headers = { ...responseObj.headers, "X-Surge-Policy": responseObj.policy };
        logger.info(`[Adapter] Surge \u811A\u672C\u6267\u884C\u7ED3\u675F. \u7528\u65F6: ${((/* @__PURE__ */ new Date()).getTime() - $script.startTime) / 1e3}s`);
        $done(responseObj);
        break;
      case "Loon":
        if (responseObj.policy) responseObj.node = responseObj.policy;
        logger.info(`[Adapter] Loon \u811A\u672C\u6267\u884C\u7ED3\u675F. \u7528\u65F6: ${(/* @__PURE__ */ new Date() - $script.startTime) / 1e3}s`);
        $done(responseObj);
        break;
      case "Stash":
        if (responseObj.policy) responseObj.headers = { ...responseObj.headers, "X-Stash-Selected-Proxy": encodeURI(responseObj.policy) };
        logger.info(`[Adapter] Stash \u811A\u672C\u6267\u884C\u7ED3\u675F. \u7528\u65F6: ${(/* @__PURE__ */ new Date() - $script.startTime) / 1e3}s`);
        $done(responseObj);
        break;
      case "Egern":
      case "Shadowrocket":
        logger.info(`[Adapter] ${env} \u811A\u672C\u6267\u884C\u7ED3\u675F.`);
        $done(responseObj);
        break;
      case "Quantumult X":
        if (responseObj.policy) responseObj.opts = { ...responseObj.opts, policy: responseObj.policy };
        let qxResponse = {};
        if (responseObj.status) {
          const statusMsg = statusCodes[responseObj.status] ?? "OK";
          qxResponse.status = `HTTP/1.1 ${responseObj.status} ${statusMsg}`;
        }
        if (responseObj.headers) qxResponse.headers = responseObj.headers;
        if (responseObj.bodyBytes) {
          qxResponse.bodyBytes = responseObj.bodyBytes;
        } else if (responseObj.body) {
          if (responseObj.body instanceof ArrayBuffer) {
            qxResponse.bodyBytes = responseObj.body;
          } else if (ArrayBuffer.isView(responseObj.body)) {
            qxResponse.bodyBytes = responseObj.body.buffer.slice(
              responseObj.body.byteOffset,
              responseObj.body.byteLength + responseObj.body.byteOffset
            );
          } else {
            qxResponse.body = responseObj.body;
          }
        }
        logger.info(`[Adapter] Quantumult X \u811A\u672C\u6267\u884C\u7ED3\u675F.`);
        $done(qxResponse);
        break;
      case "Worker":
      case "Node.js":
      default:
        logger.info(`[Adapter] ${env} \u6A21\u62DF\u6267\u884C\u7ED3\u675F.`);
        if (env === "Node.js") process.exit(1);
    }
  }
  var storage = Storage;

  // src/wloc-settings.js
  var SETTINGS_KEY = "wloc_settings";
  function getQueryParams(url) {
    const params = /* @__PURE__ */ new Map();
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
  (() => {
    const requestUrl = typeof $request !== "undefined" ? $request.url : "";
    if (!requestUrl) {
      logger.warn("[Settings] \u672A\u80FD\u622A\u83B7\u6709\u6548\u7684\u8BF7\u6C42 URL\uFF0C\u9000\u51FA\u3002");
      return done({});
    }
    const queryParams = getQueryParams(requestUrl);
    const action = queryParams.get("action") || "save";
    logger.debug(`[Settings] \u622A\u83B7\u914D\u7F6E\u7BA1\u7406\u8BF7\u6C42. URL: ${requestUrl}, \u6267\u884C\u6307\u4EE4: ${action}`);
    let responseData = {};
    if (action === "query") {
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
          logger.info(`[Settings] \u67E5\u8BE2\u63A5\u53E3: \u8FD4\u56DE\u5F53\u524D\u5DF2\u5B58\u5750\u6807 lon=${data.longitude}, lat=${data.latitude}`);
        } else {
          responseData = {
            success: false,
            error: "\u672A\u5728\u8BBE\u5907\u4E0A\u68C0\u6D4B\u5230\u5DF2\u50A8\u5B58\u7684\u865A\u62DF\u5B9A\u4F4D\u5750\u6807\u914D\u7F6E\u3002"
          };
        }
      } catch (e) {
        responseData = { success: false, error: `\u6570\u636E\u8BFB\u53D6\u5F02\u5E38: ${e.message}` };
      }
    } else if (action === "clear") {
      try {
        const success = storage.removeItem(SETTINGS_KEY);
        if (success) {
          responseData = { success: true };
          logger.info("[Settings] \u6E05\u9664\u63A5\u53E3: \u5DF2\u6210\u529F\u5220\u9664\u672C\u5730\u6301\u4E45\u5316\u5B9A\u4F4D\u914D\u7F6E\uFF08\u5DF2\u6062\u590D\u771F\u5B9E\u5B9A\u4F4D\uFF09\u3002");
        } else {
          responseData = { success: false, error: "\u672C\u5730\u6301\u4E45\u5316\u5B58\u50A8\u914D\u7F6E\u5220\u9664\u52A8\u4F5C\u8FD4\u56DE\u5931\u8D25\u3002" };
        }
      } catch (e) {
        responseData = { success: false, error: `\u6570\u636E\u5220\u9664\u5F02\u5E38: ${e.message}` };
        logger.error(`[Settings] \u64E6\u9664\u672C\u5730\u6301\u4E45\u5316\u914D\u7F6E\u5931\u8D25: ${e.message}`);
      }
    } else {
      const lon = parseFloat(queryParams.get("lon") || queryParams.get("longitude") || "0");
      const lat = parseFloat(queryParams.get("lat") || queryParams.get("latitude") || "0");
      const acc = parseInt(queryParams.get("acc") || queryParams.get("accuracy") || "25", 10);
      if (lon && lat) {
        const savePayload = {
          longitude: lon,
          latitude: lat,
          accuracy: acc,
          updatedAt: new Date(Date.now() + 8 * 3600 * 1e3).toISOString().replace("Z", "+08:00")
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
            logger.info(`[Settings] \u5199\u5165\u63A5\u53E3: \u6210\u529F\u5199\u5165\u76EE\u6807\u7ECF\u7EAC\u5EA6 lon=${lon}, lat=${lat}, \u7CBE\u5EA6=${acc}\u7C73.`);
          } else {
            responseData = { success: false, error: "\u6301\u4E45\u5316\u5B58\u50A8\u5199\u5165\u52A8\u4F5C\u8FD4\u56DE\u5931\u8D25\u3002" };
            logger.error("[Settings] \u5199\u5165\u6301\u4E45\u5316\u6570\u636E\u5931\u8D25: Storage.setItem \u8FD4\u56DE false");
          }
        } catch (e) {
          responseData = { success: false, error: `\u6570\u636E\u5199\u5165\u5F02\u5E38: ${e.message}` };
          logger.error(`[Settings] \u5199\u5165\u6301\u4E45\u5316\u6570\u636E\u9047\u5230\u5F02\u5E38: ${e.message}`);
        }
      } else {
        responseData = {
          success: false,
          error: "\u8BF7\u6C42\u53C2\u6570\u9519\u8BEF\uFF0C\u7F3A\u5931\u6709\u6548\u7684\u7ECF\u5EA6 (lon) \u6216\u7EAC\u5EA6 (lat) \u6570\u503C\u3002"
        };
      }
    }
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
    done(httpResponse);
  })();
})();
