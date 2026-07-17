/**
 * @file adapter.js
 * @description 跨平台代理软件运行环境适配器与持久化存储管理
 */

/**
 * 探测当前的代理软件执行环境
 * @returns {string} 环境名称 ('Surge' | 'Quantumult X' | 'Loon' | 'Stash' | 'Shadowrocket' | 'Egern' | 'Node.js' | 'Worker' | 'unknown')
 */
export function detectEnvironment() {
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

const env = detectEnvironment();

/**
 * 跨平台分级日志记录器
 */
export class Logger {
  static LOG_LEVELS = {
    OFF: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    ALL: 5
  };

  constructor(level = "INFO") {
    this.currentLevel = Logger.LOG_LEVELS[level.toUpperCase()] ?? 3;
    this.groupStack = [];
  }

  setLogLevel(level) {
    if (typeof level === "string") {
      this.currentLevel = Logger.LOG_LEVELS[level.toUpperCase()] ?? 3;
    } else if (typeof level === "number") {
      this.currentLevel = level;
    }
  }

  log(...args) {
    if (this.currentLevel === 0) return;
    let formattedArgs = args.flatMap(arg => {
      if (typeof arg === "object") return [JSON.stringify(arg)];
      if (["bigint", "number", "boolean"].includes(typeof arg)) return [arg.toString()];
      if (typeof arg === "string") return arg.split(/\r?\n/u);
      return [arg];
    });

    this.groupStack.forEach(groupName => {
      formattedArgs = formattedArgs.map(line => `  ${line}`);
      formattedArgs.unshift(` [${groupName}]:`);
    });

    console.log(["", ...formattedArgs].join("\n"));
  }

  error(...args) {
    if (this.currentLevel < Logger.LOG_LEVELS.ERROR) return;
    const formatted = args.map(arg => {
      if (env === "Worker" || env === "Node.js") {
        return arg?.stack ?? arg;
      }
      return ` ${arg}`;
    });
    this.log("[ERROR]", ...formatted);
  }

  warn(...args) {
    if (this.currentLevel < Logger.LOG_LEVELS.WARN) return;
    this.log("[WARN]", ...args.map(a => ` ${a}`));
  }

  info(...args) {
    if (this.currentLevel < Logger.LOG_LEVELS.INFO) return;
    this.log("[INFO]", ...args.map(a => ` ${a}`));
  }

  debug(...args) {
    if (this.currentLevel < Logger.LOG_LEVELS.DEBUG) return;
    this.log("[DEBUG]", ...args.map(a => ` ${a}`));
  }

  group(name) {
    this.groupStack.unshift(name);
  }

  groupEnd() {
    this.groupStack.shift();
  }
}

export const logger = new Logger("INFO");

// 用于内存缓存的临时存储，以防在不支持文件系统的环境使用
const memoryStore = {};

/**
 * 跨平台键值本地持久化存储器
 */
export class Storage {
  /**
   * 读取本地配置数据
   * @param {string} key 键名
   * @param {*} defaultValue 默认值
   * @returns {*} 解析后的值或默认值
   */
  static getItem(key, defaultValue = null) {
    let result = defaultValue;

    // 处理 @ 简易路径选择读取 (BoxJS 兼容语法)
    if (key.startsWith("@")) {
      const match = key.match(/^@(?<rootKey>[^.]+)(?:\.(?<path>.*))?$/);
      if (match) {
        const { rootKey, path } = match.groups;
        const rootData = Storage.getItem(rootKey, {});
        const pathParts = path ? path.split(".") : [];
        let temp = rootData;
        for (const part of pathParts) {
          if (temp && typeof temp === "object") {
            temp = temp[part];
          } else {
            temp = undefined;
            break;
          }
        }
        return temp !== undefined ? temp : defaultValue;
      }
    }

    // 根据不同代理客户端读取本地持久化数据
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
        rawVal = Storage._readNodeStore(key);
        break;
      default:
        rawVal = memoryStore[key] || null;
    }

    if (rawVal !== null && rawVal !== undefined) {
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

    // 兼容 @ 语法进行深层合并写入
    if (key.startsWith("@")) {
      const match = key.match(/^@(?<rootKey>[^.]+)(?:\.(?<path>.*))?$/);
      if (match) {
        const { rootKey, path } = match.groups;
        const rootData = Storage.getItem(rootKey, {});
        
        // 深层路径赋值辅助
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
        return Storage.setItem(rootKey, rootData);
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
        success = Storage._writeNodeStore(key, writeVal);
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
        const rootData = Storage.getItem(rootKey, {});
        
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
        return Storage.setItem(rootKey, rootData);
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
        success = Storage._deleteNodeStore(key);
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
      const fs = require("fs");
      const path = require("path");
      const filePath = path.resolve(process.cwd(), "box.dat");
      if (fs.existsSync(filePath)) {
        const fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return fileContent[key] ?? null;
      }
    } catch {}
    return null;
  }

  static _writeNodeStore(key, value) {
    try {
      const fs = require("fs");
      const path = require("path");
      const filePath = path.resolve(process.cwd(), "box.dat");
      let fileContent = {};
      if (fs.existsSync(filePath)) {
        fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
      fileContent[key] = value;
      fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");
      return true;
    } catch {}
    return false;
  }

  static _deleteNodeStore(key) {
    try {
      const fs = require("fs");
      const path = require("path");
      const filePath = path.resolve(process.cwd(), "box.dat");
      if (fs.existsSync(filePath)) {
        const fileContent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        delete fileContent[key];
        fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), "utf-8");
        return true;
      }
    } catch {}
    return false;
  }
}

/**
 * 封装统一的响应结束回调函数
 * @param {object} responseObj 最终响应包内容
 */
export function done(responseObj = {}) {
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
      logger.info(`[Adapter] Surge 脚本执行结束. 用时: ${(new Date().getTime() - $script.startTime) / 1000}s`);
      if (typeof $request !== "undefined" && typeof $response === "undefined") {
        $done({ response: responseObj });
      } else {
        $done(responseObj);
      }
      break;
    case "Loon":
      if (responseObj.policy) responseObj.node = responseObj.policy;
      logger.info(`[Adapter] Loon 脚本执行结束. 用时: ${(new Date() - $script.startTime) / 1000}s`);
      if (typeof $request !== "undefined" && typeof $response === "undefined") {
        $done({ response: responseObj });
      } else {
        $done(responseObj);
      }
      break;
    case "Stash":
      if (responseObj.policy) responseObj.headers = { ...responseObj.headers, "X-Stash-Selected-Proxy": encodeURI(responseObj.policy) };
      logger.info(`[Adapter] Stash 脚本执行结束. 用时: ${(new Date() - $script.startTime) / 1000}s`);
      if (typeof $request !== "undefined" && typeof $response === "undefined") {
        $done({ response: responseObj });
      } else {
        $done(responseObj);
      }
      break;
    case "Egern":
    case "Shadowrocket":
      logger.info(`[Adapter] ${env} 脚本执行结束.`);
      if (typeof $request !== "undefined" && typeof $response === "undefined") {
        $done({ response: responseObj });
      } else {
        $done(responseObj);
      }
      break;
    case "Quantumult X":
      // QX 需要特殊的参数格式过滤
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
      logger.info(`[Adapter] Quantumult X 脚本执行结束.`);
      $done(qxResponse);
      break;
    case "Worker":
    case "Node.js":
    default:
      logger.info(`[Adapter] ${env} 模拟执行结束.`);
      if (env === "Node.js") process.exit(1);
  }
}

/**
 * 导出 Storage 类本身作为 storage 别名（所有方法均为静态方法，可直接用 storage.getItem() 调用）
 */
export const storage = Storage;
