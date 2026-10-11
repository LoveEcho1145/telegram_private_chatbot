// Cloudflare Worker：Telegram 双向机器人 v6.2
// 人机验证方式：Cloudflare Turnstile 网页验证（需配置 TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY）

// --- 配置常量 ---
const CONFIG = {
    VERIFY_ID_LENGTH: 12,
    VERIFY_EXPIRE_SECONDS: 600,         // 网页验证链接有效期 10分钟
    VERIFIED_EXPIRE_SECONDS: 2592000,   // 30天
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,         // 3秒（从2秒增加）
    PENDING_MAX_MESSAGES: 10,           // 验证期间最多暂存的消息数
    ADMIN_CACHE_TTL_SECONDS: 300,       // 管理员权限缓存 5 分钟
    NEEDS_REVERIFY_TTL_SECONDS: 600,    // 标记需重新验证的 TTL（用于并发兜底）
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    MAX_CLEANUP_DISPLAY: 20,
    CLEANUP_LOCK_TTL_SECONDS: 600,      // /cleanup 防并发锁 10 分钟
    CLEANUP_TIME_BUDGET_MS: 20000,      // /cleanup 单次运行时间预算（超出则断点续扫）
    CLEANUP_PROBE_DELAY_MS: 1100,       // /cleanup 探测节流间隔（避免 Telegram 群消息限流 429）
    VERIFY_DONE_DELETE_DELAY_MS: 8000,  // 验证通过提示消息的延迟删除时间
    DELIVERED_HINT_DELETE_MS: 6000,     // 用户"已送达"提示的自动消失时间
    JUST_VERIFIED_TTL_SECONDS: 300,     // "刚通过验证"宽限期（规避 KV 边缘缓存延迟）
    MAX_RETRY_ATTEMPTS: 3,
    THREAD_HEALTH_TTL_MS: 60000
};

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    /**
     * 记录信息级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    /**
     * 记录警告级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    warn(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...data
        };
        console.warn(JSON.stringify(log));
    },

    /**
     * 记录错误级别日志
     * @param {string} action - 操作名称
     * @param {Error|string} error - 错误对象或消息
     * @param {object} data - 附加数据
     */
    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    /**
     * 记录调试级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

// 加密安全的随机ID生成
function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

// 判断用户是否已通过验证（含刚通过验证的短暂宽限期，规避 KV 边缘缓存导致的误判）
async function isUserVerified(env, userId) {
    const verified = await env.TOPIC_MAP.get(`verified:${userId}`);
    if (verified) return true;

    const justVerified = await env.TOPIC_MAP.get(`just_verified:${userId}`);
    if (justVerified) {
        // 自愈：补写正式验证状态；保留宽限标记并续期（KV 边缘缓存最长 60s 才失效，期间持续兜底）
        await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        await env.TOPIC_MAP.put(`just_verified:${userId}`, "1", { expirationTtl: CONFIG.JUST_VERIFIED_TTL_SECONDS });
        return true;
    }
    return false;
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await safeGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        // 并发下二次确认，避免已被其他请求创建却读到旧值
        const again = await safeGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    topicCreateInFlight.set(String(userId), p);
    try {
        return await p;
    } finally {
        if (topicCreateInFlight.get(String(userId)) === p) {
            topicCreateInFlight.delete(String(userId));
        }
    }
}

function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: "🔎"
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        // 尽可能清理探测消息（无论落到哪个话题/General）
        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
                // 删除失败不影响主流程
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description, retryAfter: res.parameters?.retry_after };
        }

        // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    // 二次探测：避免偶发字段缺失导致误判并触发重建
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason, origin, from }) {
    // 清理旧映射与验证状态：用户需要重新做人机验证
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.delete(`just_verified:${userId}`);
    await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`retry:${userId}`);

    if (userKey) {
        await env.TOPIC_MAP.delete(userKey);
    }

    if (oldThreadId !== undefined && oldThreadId !== null) {
        await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
        await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        threadHealthCache.delete(oldThreadId);
    }

    Logger.info('verification_reset_due_to_topic_loss', {
        userId,
        oldThreadId,
        pendingMsgId,
        reason
    });

    await sendVerificationChallenge(userId, env, pendingMsgId || null, origin, from);
}

function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    const now = Date.now();
    const cached = adminStatusCache.get(cacheKey);
    if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
        return cached.isAdmin;
    }

    const kvKey = `admin:${userId}`;
    const kvVal = await env.TOPIC_MAP.get(kvKey);
    if (kvVal === "1" || kvVal === "0") {
        const isAdmin = kvVal === "1";
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

export default {
  async fetch(request, env, ctx) {
    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");
    if (!env.TURNSTILE_SITE_KEY) return new Response("Error: TURNSTILE_SITE_KEY not set.");
    if (!env.TURNSTILE_SECRET_KEY) return new Response("Error: TURNSTILE_SECRET_KEY not set.");

    // 【修复 #7】规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: String(env.SUPERGROUP_ID),
        BOT_TOKEN: String(env.BOT_TOKEN)
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    const url = new URL(request.url);

    // 人机验证网页路由
    if (url.pathname === "/verify") {
        if (request.method === "GET") return handleVerifyPage(url, normalizedEnv);
        if (request.method === "POST") return handleVerifySubmit(request, normalizedEnv, ctx, url.origin);
        return new Response("Method Not Allowed", { status: 405 });
    }

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx, url.origin);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 【修复 #7】使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 【修复】支持 General 话题和普通话题
        // General 话题的 message_thread_id 可能不存在，或者等于 1
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx, origin) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;
  // 取命令主体，兼容群组内自动附加的 @机器人 后缀（如 /start@BotName）
  const firstWord = (msg.text || "").trim().split(/\s+/)[0].split("@")[0];

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ 发送过于频繁，请稍后再试。"
      });
      return;
  }

  // 拦截普通用户发送的指令
  if (firstWord.startsWith("/") && firstWord !== "/start") {
      return;
  }

  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) return;

  const verified = await isUserVerified(env, userId);

  if (!verified) {
    const isStart = firstWord === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId, origin, msg.from);
    return;
  }

  await forwardToTopic(msg, userId, key, env, ctx, origin);
}

async function forwardToTopic(msg, userId, key, env, ctx, origin, quiet = false) {
    // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        if (await isUserVerified(env, userId)) {
            // 刚通过验证（KV 缓存延迟导致标记残留），清除后继续转发
            await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
        } else {
            await sendVerificationChallenge(userId, env, msg.message_id || null, origin, msg.from);
            return;
        }
    }

    // 【修复 #4】使用安全的 JSON 解析
    let rec = await safeGetJSON(env, key, null);

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 【修复 #5】重试计数器，防止无限循环
    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "❌ 系统繁忙，请稍后再试。"
        });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error("创建话题失败");
        }
    }

    // 补建 thread->user 映射（兼容旧数据）
    if (rec && rec.thread_id) {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mappedUser) {
            await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
        }
    }

    // 【修复1】验证话题是否仍然存在（带缓存，降低探测频率）
    // 当话题被删除后，KV中的thread_id仍然存在，但实际话题已不可用
    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = threadHealthCache.get(cacheKey);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
            } else {
            const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

            if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, {
                        userId,
                        userKey: key,
                        oldThreadId: rec.thread_id,
                        pendingMsgId: msg.message_id,
                        reason: `health_check:${probe.status}`,
                        origin,
                        from: msg.from
                    });
                    return;
            } else if (probe.status === "probe_invalid") {
                Logger.warn('topic_health_probe_invalid_message', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });

                // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            } else if (probe.status === "unknown_error") {
                Logger.warn('topic_test_failed_unknown', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });
            } else {
                await env.TOPIC_MAP.delete(retryKey);
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            }
            }
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    // 检测 Telegram 静默重定向到 General 的情况
    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        // 删除误投到 General 的消息
        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
                // 删除失败不影响重发
            }
        }
        await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsgId: msg.message_id,
            reason: "forward_redirected_to_general",
            origin,
            from: msg.from
        });
        return;
    }

    // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            // 尽量删除误投消息（通常在 General）
            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                    // 删除失败不影响重发
                }
            }
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: `forward_missing_thread_id:${probe.status}`,
                origin,
                from: msg.from
            });
            return;
        }
    }

    // 【修复2】增强错误处理，双重保险
    // 如果上面的测试没有捕获到，这里再次检测
    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_failed_topic_missing",
                origin,
                from: msg.from
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        // 如果forwardMessage失败，尝试使用copyMessage作为降级方案
        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
    }

    // 送达成功提示（短暂显示后自动消失）；批量补发(quiet)与媒体组不提示
    if (!quiet && !msg.media_group_id) {
        await sendDeliveredHint(userId, env, ctx);
    }
}

// 给用户发送临时"已送达"提示，稍后自动删除
async function sendDeliveredHint(userId, env, ctx) {
    const res = await tgCall(env, "sendMessage", { chat_id: userId, text: "✅ 已送达" });
    if (!res.ok) {
        Logger.warn('delivered_hint_send_failed', { userId, description: res.description });
    }
    const msgId = res.result?.message_id;
    if (msgId && ctx && ctx.waitUntil) {
        ctx.waitUntil((async () => {
            try {
                await new Promise(r => setTimeout(r, CONFIG.DELIVERED_HINT_DELETE_MS));
                await tgCall(env, "deleteMessage", { chat_id: userId, message_id: msgId });
            } catch (e) {
                // 删除失败不影响主流程
            }
        })());
    }
}

// 管理员命令表（/help）
async function sendAdminHelp(threadId, env) {
    const text =
`🛠️ 管理员指令

/close 强制关闭对话
机器人会提示用户对话已结束，并拒收新消息。
工单处理完成，礼貌结束咨询。

/open 重新开启对话
恢复对该用户的消息转发。
误操作关闭，或用户需再次联系。

/ban 封禁用户
机器人将完全无视该用户的所有消息（无提示）。
遇到恶意刷屏、广告机器人。

/unban 解封用户
恢复该用户的正常通讯权限。
给予改过自新的机会。

/cleanbanned 清理封禁账号
在通用频道发送，自动查找所有被封禁的账号，
清除其数据与话题聊天记录，保留封禁状态。较多时会分批处理。

/trust 永久信任
该用户将永久免除人机验证（永不过期）。
熟人、VIP 客户、长期合作伙伴。

/reset 重置验证
强制清除该用户的验证状态，下次需重新验证。
测试验证流程，或怀疑账号被盗。

/info 查看信息
显示当前用户的 UID、话题 ID 和链接。
查询用户资料。

/cleanup 批量清理
扫描并清理已删除话题的用户数据。用户较多时会分批处理，
按提示再次发送 /cleanup 即可继续。

/help 命令表
显示本指令列表。`;

    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text
    }, threadId));
}

async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const text = (msg.text || "").trim();
  // 取命令主体，兼容群组内自动附加的 @机器人 后缀（如 /help@BotName）
  const cmd = (text.split(/\s+/)[0] || "").split("@")[0];
  const senderId = msg.from?.id;

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  if (!senderId || !(await isAdminUser(env, senderId))) {
      return;
  }

  // 【修复】允许在任何话题执行 /cleanup 命令
  if (cmd === "/cleanup") {
      // /cleanup 可能处理较久，使用 waitUntil 防止 webhook 请求超时导致“卡住”
      ctx.waitUntil(handleCleanupCommand(threadId, env));
      return;
  }

  // 在通用频道批量清理所有被封禁账号（自动查找 banned: 记录）
  if (cmd === "/cleanbanned") {
      ctx.waitUntil(handleCleanBannedCommand(threadId, env));
      return;
  }

  // 命令表：任何话题（含 General）可用
  if (cmd === "/help" || cmd === "/start") {
      await sendAdminHelp(threadId, env);
      return;
  }

  // 优先通过 thread 映射快速反查用户，缺失时再降级全量扫描
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
      userId = Number(mappedUser);
  } else {
      const allKeys = await getAllKeys(env, "user:");
      for (const { name } of allKeys) {
          const rec = await safeGetJSON(env, name, null);
          if (rec && Number(rec.thread_id) === Number(threadId)) {
              userId = Number(name.slice(5));
              break;
          }
      }
  }

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) return; 

  // --- 指令区域 ---

  if (cmd === "/close") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = true;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
      }
      return;
  }

  if (cmd === "/open") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = false;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
      }
      return;
  }

  if (cmd === "/reset") {
      await env.TOPIC_MAP.delete(`verified:${userId}`);
      await env.TOPIC_MAP.delete(`just_verified:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🔄 **验证重置**", parse_mode: "Markdown" });
      return;
  }

  if (cmd === "/trust") {
      await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🌟 **已设置永久信任**", parse_mode: "Markdown" });
      return;
  }

  if (cmd === "/ban") {
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
      return;
  }

  if (cmd === "/unban") {
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
      return;
  }

  if (cmd === "/info") {
      const userKey = `user:${userId}`;
      const userRec = await safeGetJSON(env, userKey, null);
      const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
      const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

      const info = `👤 **用户信息**\nUID: \`${userId}\`\nTopic ID: \`${threadId}\`\n话题标题: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: [点击私聊](tg://user?id=${userId})`;
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
      return;
  }

  // 转发管理员消息给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 验证模块 (Cloudflare Turnstile 网页验证) ----------------

// 验证页共用样式（自适应明暗主题 + Telegram WebApp 主题）
const VERIFY_PAGE_CSS = `
*{margin:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:#f2f4f8;color:#1c1e21;padding:16px}
.card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:32px 28px;max-width:380px;width:100%;text-align:center}
h1{font-size:20px;margin-bottom:12px}
p{font-size:14px;color:#5f6368;line-height:1.6;margin-bottom:20px}
.cf-turnstile{display:flex;justify-content:center}
.btn{display:inline-block;padding:10px 24px;border:none;border-radius:10px;background:#3390ec;color:#fff;font-size:15px;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#131314;color:#e3e3e3}.card{background:#1e1f20;box-shadow:0 8px 30px rgba(0,0,0,.4)}p{color:#9aa0a6}}
html.tg-dark body{background:#131314;color:#e3e3e3}
html.tg-dark .card{background:#1e1f20;box-shadow:0 8px 30px rgba(0,0,0,.4)}
html.tg-dark p{color:#9aa0a6}
`;

// Telegram Mini App 初始化（内嵌打开时适配主题并展开）
const VERIFY_TG_INIT = `(function(){var w=window.Telegram&&window.Telegram.WebApp;if(w){w.ready();w.expand();if(w.colorScheme==='dark'){document.documentElement.classList.add('tg-dark');}}})();`;

async function sendVerificationChallenge(userId, env, pendingMsgId, origin, fromUser) {
    // 刚通过验证（KV 边缘缓存延迟兜底），避免对已验证用户重复下发挑战
    if (await env.TOPIC_MAP.get(`just_verified:${userId}`)) {
        await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
        return;
    }

    // 检查是否已有进行中的验证
    const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (existingChallenge) {
        // 有正在进行的验证：仅将新消息加入待发送队列，避免重复下发链接/触发验证限速
        const chalKey = `chal:${existingChallenge}`;
        const state = await safeGetJSON(env, chalKey, null);

        // KV 可能存在不一致/过期：自愈清理后重新下发
        if (!state || state.userId !== userId) {
            await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
        } else {
            if (pendingMsgId) {
                const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : [];
                if (!pendingIds.includes(pendingMsgId)) {
                    pendingIds.push(pendingMsgId);
                    state.pending_ids = pendingIds.slice(-CONFIG.PENDING_MAX_MESSAGES);
                    await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
                }
            }
            Logger.debug('verification_duplicate_skipped', { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
            return;
        }
    }

    // 验证请求速率限制：仅在需要创建新挑战时检查
    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
        });
        return;
    }

    const verifyId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);
    const state = {
        userId,
        pending_ids: pendingMsgId ? [pendingMsgId] : [],
        // 留存用户资料，验证通过后创建话题时使用
        from: fromUser ? {
            id: fromUser.id,
            first_name: fromUser.first_name,
            last_name: fromUser.last_name,
            username: fromUser.username
        } : null
    };

    await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    Logger.info('verification_sent', { userId, verifyId, pendingCount: state.pending_ids.length });

    const sent = await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "🛡️ **人机验证**\n\n请点击下方按钮，在弹出的窗口内完成 Cloudflare 安全验证 (验证通过后将自动发送您刚才的消息)。",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🛡️ 点击完成验证", web_app: { url: `${origin}/verify?uid=${userId}&token=${verifyId}` } }]] }
    });

    // 记录验证消息发送失败原因（便于 wrangler tail 诊断）
    if (!sent.ok) {
        Logger.warn('verification_send_failed', { userId, description: sent.description });
    }

    // 记录验证消息 ID，验证通过后可更新状态并自动删除
    if (sent.ok && sent.result?.message_id) {
        state.bot_msg_id = sent.result.message_id;
        await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
    }
}

// 验证网页 (GET /verify)
function handleVerifyPage(url, env) {
    const uid = url.searchParams.get("uid") || "";
    const token = url.searchParams.get("token") || "";
    if (!/^\d+$/.test(uid) || !/^[a-z0-9]{1,32}$/i.test(token)) {
        return new Response(renderVerifyResult(false, "无效的验证链接，请返回 Telegram 重新获取。"), {
            status: 400,
            headers: { "content-type": "text/html;charset=utf-8" }
        });
    }
    return new Response(renderVerifyPage(env.TURNSTILE_SITE_KEY, uid, token), {
        headers: { "content-type": "text/html;charset=utf-8" }
    });
}

function renderVerifyPage(siteKey, uid, token) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>人机验证</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>${VERIFY_PAGE_CSS}</style>
</head>
<body>
<main class="card">
  <h1>🛡️ 人机验证</h1>
  <p id="tip">请完成下方安全验证，通过后即可返回 Telegram 继续对话。</p>
  <form id="vf" action="/verify" method="POST">
    <input type="hidden" name="uid" value="${uid}">
    <input type="hidden" name="token" value="${token}">
    <div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="onVerify"></div>
  </form>
</main>
<script>${VERIFY_TG_INIT}
function onVerify() {
    document.getElementById('tip').textContent = '✅ 验证成功，正在提交…';
    document.getElementById('vf').submit();
}
</script>
</body>
</html>`;
}

function renderVerifyResult(ok, message) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? "验证成功" : "验证失败"}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${VERIFY_PAGE_CSS}</style>
</head>
<body>
<main class="card">
  <h1>${ok ? "✅ 验证成功" : "❌ 验证失败"}</h1>
  <p>${message}</p>
  ${ok ? `<button class="btn" onclick="var w=window.Telegram&&window.Telegram.WebApp;if(w){w.close();}">返回 Telegram</button>` : ""}
</main>
<script>${VERIFY_TG_INIT}</script>
</body>
</html>`;
}

// 验证提交 (POST /verify)
async function handleVerifySubmit(request, env, ctx, origin) {
    const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8" } });
    const fail = (msg) => html(renderVerifyResult(false, msg), 400);

    let form;
    try {
        form = await request.formData();
    } catch (e) {
        return fail("请求格式错误。");
    }

    const userId = Number(form.get("uid"));
    const verifyId = String(form.get("token") || "");
    const tsToken = String(form.get("cf-turnstile-response") || "");

    const state = await safeGetJSON(env, `chal:${verifyId}`, null);
    if (!state || state.userId !== userId) {
        return fail("验证链接已过期，请返回 Telegram 重新发送消息获取新链接。");
    }

    const passed = await verifyTurnstile(env, tsToken, request.headers.get("CF-Connecting-IP"));
    if (!passed) {
        return fail("安全验证未通过，请返回 Telegram 重新获取验证链接。");
    }

    await completeVerification(userId, verifyId, state, env, ctx, origin);
    return html(renderVerifyResult(true, "您现在可以返回 Telegram 自由对话了。"));
}

// 校验 Turnstile token
async function verifyTurnstile(env, tsToken, remoteip) {
    try {
        const body = new URLSearchParams({
            secret: String(env.TURNSTILE_SECRET_KEY),
            response: tsToken
        });
        if (remoteip) body.set("remoteip", remoteip);

        const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            body
        });
        const result = await resp.json();
        if (!result.success) {
            Logger.warn('turnstile_verify_failed', { codes: result["error-codes"] });
        }
        return !!result.success;
    } catch (e) {
        Logger.error('turnstile_verify_error', e);
        return false;
    }
}

// 验证通过后的统一处理：写入已验证状态并转发暂存消息
async function completeVerification(userId, verifyId, state, env, ctx, origin) {
    // 30天有效期
    await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
    // 写入"刚通过验证"宽限标记（规避 KV 边缘缓存延迟导致的误判）
    await env.TOPIC_MAP.put(`just_verified:${userId}`, "1", { expirationTtl: CONFIG.JUST_VERIFIED_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
    await env.TOPIC_MAP.delete(`chal:${verifyId}`);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

    Logger.info('verification_passed', { userId, verifyId });

    // 验证消息更新为"验证通过"状态，过一会自动删除
    if (state.bot_msg_id) {
        const msgId = state.bot_msg_id;
        try {
            await tgCall(env, "editMessageText", {
                chat_id: userId,
                message_id: msgId,
                text: "✅ **验证通过**\n\n您现在可以自由对话了。",
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [] }
            });
            if (ctx && ctx.waitUntil) {
                ctx.waitUntil((async () => {
                    try {
                        await new Promise(r => setTimeout(r, CONFIG.VERIFY_DONE_DELETE_DELAY_MS));
                        await tgCall(env, "deleteMessage", { chat_id: userId, message_id: msgId });
                    } catch (e) {
                        Logger.warn('verify_msg_delete_failed', e, { userId, msgId });
                    }
                })());
            }
        } catch (e) {
            Logger.warn('verify_msg_update_failed', e, { userId, msgId });
        }
    } else {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "✅ **验证通过**\n\n您现在可以自由对话了。",
            parse_mode: "Markdown"
        });
    }

    // 限制一次性转发量，避免用户恶意堆积导致执行超时
    const pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice(-CONFIG.PENDING_MAX_MESSAGES) : [];
    if (pendingIds.length === 0) return;

    try {
        let forwardedCount = 0;
        for (const pendingId of pendingIds) {
            if (!pendingId) continue;
            const forwardedKey = `forwarded:${userId}:${pendingId}`;
            if (await env.TOPIC_MAP.get(forwardedKey)) {
                Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
                continue;
            }

            const fakeMsg = {
                message_id: pendingId,
                chat: { id: userId, type: "private" },
                from: state.from || { id: userId }
            };

            await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx, origin, true);
            await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
            forwardedCount++;
        }

        if (forwardedCount > 0) {
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
            });
        }
    } catch (e) {
        Logger.error('pending_message_forward_failed', e, { userId });
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 自动发送失败，请重新发送您的消息。"
        });
    }
}

// ---------------- 辅助函数 ----------------

/**
 * 【修复 #8】批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    const stateKey = "cleanup:state";

    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 断点续扫状态：用户较多时单次运行扫不完，自动分多轮处理
    let state = await safeGetJSON(env, stateKey, null);
    const resumed = !!state;
    if (!state) {
        state = { cursor: null, index: 0, scanned: 0, cleaned: 0, errors: 0, users: [] };
    }

    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: resumed
            ? `🔄 **继续扫描...** (此前已扫描 ${state.scanned} 个用户，清理 ${state.cleaned} 个)`
            : "🔄 **正在扫描需要清理的用户...**",
        parse_mode: "Markdown"
    }, threadId));

    const startedAt = Date.now();
    let exhausted = false;

    try {
        do {
            const pageCursor = state.cursor;
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor: pageCursor || undefined, limit: 200 });
            const names = (result.keys || []).map(k => k.name);

            for (let i = state.index; i < names.length; i++) {
                // 时间预算：超出则保存断点，下轮从此处继续
                if (Date.now() - startedAt > CONFIG.CLEANUP_TIME_BUDGET_MS) {
                    exhausted = true;
                    state.cursor = pageCursor;
                    state.index = i;
                    break;
                }

                const name = names[i];
                const rec = await safeGetJSON(env, name, null);
                state.scanned++;
                if (!rec || !rec.thread_id) continue;

                const userId = name.slice(5);
                const topicThreadId = rec.thread_id;

                // 检测话题是否存在（带 429 限流重试）
                const probe = await probeWithRetry(env, topicThreadId, userId);

                // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
                if (probe.status === "redirected" || probe.status === "missing") {
                    await env.TOPIC_MAP.delete(name);
                    await env.TOPIC_MAP.delete(`verified:${userId}`);
                    await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);
                    state.cleaned++;
                    if (state.users.length < CONFIG.MAX_CLEANUP_DISPLAY) {
                        state.users.push({ userId, title: rec.title || "未知" });
                    }
                    Logger.info('cleanup_user', { userId, threadId: topicThreadId });
                } else if (probe.status !== "ok") {
                    state.errors++;
                    Logger.warn('cleanup_probe_failed', {
                        userId,
                        threadId: topicThreadId,
                        status: probe.status,
                        errorDescription: probe.description
                    });
                }

                // 探测节流：避免触发 Telegram 群消息限流
                await new Promise(r => setTimeout(r, CONFIG.CLEANUP_PROBE_DELAY_MS));
            }

            if (exhausted) break;
            state.index = 0;
            state.cursor = result.list_complete ? null : result.cursor;
        } while (state.cursor);

        if (exhausted) {
            // 保存断点，提示管理员继续
            await env.TOPIC_MAP.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 });
            Logger.info('cleanup_paused', { scanned: state.scanned, cleaned: state.cleaned, errors: state.errors });
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                text: `⏸️ **本轮清理暂停（用户较多，自动分批处理）**\n\n- 已扫描: ${state.scanned}\n- 已清理: ${state.cleaned}\n- 探测失败: ${state.errors}\n\n💡 再次发送 /cleanup 将继续扫描，直至提示“清理完成”。`,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        // 全部扫描完成，清除断点
        await env.TOPIC_MAP.delete(stateKey);

        // 生成并发送清理报告
        let reportText = `✅ **清理完成**\n\n`;
        reportText += `📊 **统计信息**\n`;
        reportText += `- 扫描用户数: ${state.scanned}\n`;
        reportText += `- 已清理用户数: ${state.cleaned}\n`;
        reportText += `- 探测失败数: ${state.errors}\n\n`;

        if (state.cleaned > 0) {
            reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
            for (const user of state.users) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (state.cleaned > state.users.length) {
                reportText += `\n...(还有 ${state.cleaned - state.users.length} 个用户)\n`;
            }
            reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
        } else {
            reportText += `✨ 没有发现需要清理的用户记录。`;
        }

        Logger.info('cleanup_completed', {
            cleanedCount: state.cleaned,
            errorCount: state.errors,
            totalUsers: state.scanned
        });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        // 保存断点，下轮可继续
        await env.TOPIC_MAP.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 }).catch(() => {});
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\`\n\n💡 再次发送 /cleanup 可从断点继续。`,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// 带 429 限流重试的话题探测
async function probeWithRetry(env, threadId, userId) {
    let probe = await probeForumThread(env, threadId, { userId, reason: "cleanup_check", doubleCheckOnMissingThreadId: false });
    if (probe.status === "unknown_error" && probe.description && probe.description.includes("Too Many Requests")) {
        const waitMs = ((probe.retryAfter || 5) + 1) * 1000;
        Logger.warn('cleanup_probe_rate_limited', { userId, threadId, retryAfter: probe.retryAfter });
        await new Promise(r => setTimeout(r, waitMs));
        probe = await probeForumThread(env, threadId, { userId, reason: "cleanup_check_retry", doubleCheckOnMissingThreadId: false });
    }
    return probe;
}

// /cleanbanned：在通用频道批量清理所有被封禁账号（清除数据与聊天记录，保留封禁状态）
async function handleCleanBannedCommand(threadId, env) {
    const lockKey = "cleanbanned:lock";
    const stateKey = "cleanbanned:state";

    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }
    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 断点续扫状态：被封禁用户较多时自动分多轮处理
    let state = await safeGetJSON(env, stateKey, null);
    const resumed = !!state;
    if (!state) {
        state = { index: 0, scanned: 0, cleaned: 0, skipped: 0, errors: 0, users: [] };
    }

    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: resumed
            ? `🔄 **继续清理被封禁账号...** (此前已处理 ${state.scanned} 个)`
            : "🔄 **正在清理被封禁账号...**",
        parse_mode: "Markdown"
    }, threadId));

    const startedAt = Date.now();
    let exhausted = false;

    try {
        // 汇总全部被封禁用户（仅需 key 列表，速度快）
        let bannedIds = [];
        let cursor = undefined;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "banned:", cursor });
            bannedIds = bannedIds.concat((result.keys || []).map(k => Number(k.name.slice(7))));
            cursor = result.list_complete ? undefined : result.cursor;
        } while (cursor);
        const total = bannedIds.length;

        for (let i = state.index; i < total; i++) {
            // 时间预算：超出则保存断点，下轮从此处继续
            if (Date.now() - startedAt > CONFIG.CLEANUP_TIME_BUDGET_MS) {
                exhausted = true;
                state.index = i;
                break;
            }

            const userId = bannedIds[i];
            state.scanned++;
            const rec = await safeGetJSON(env, `user:${userId}`, null);

            if (!rec) {
                // 用户数据已不存在，仅保留封禁状态
                state.skipped++;
                continue;
            }

            try {
                const userThreadId = rec.thread_id;
                await env.TOPIC_MAP.delete(`user:${userId}`);
                await env.TOPIC_MAP.delete(`verified:${userId}`);
                await env.TOPIC_MAP.delete(`just_verified:${userId}`);
                await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
                await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
                await env.TOPIC_MAP.delete(`retry:${userId}`);
                if (userThreadId !== undefined && userThreadId !== null) {
                    await env.TOPIC_MAP.delete(`thread:${userThreadId}`);
                    await env.TOPIC_MAP.delete(`thread_ok:${userThreadId}`);
                    threadHealthCache.delete(userThreadId);
                    // 删除话题以清除聊天记录
                    await tgCall(env, "deleteForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: userThreadId });
                }
                state.cleaned++;
                if (state.users.length < CONFIG.MAX_CLEANUP_DISPLAY) {
                    state.users.push({ userId, title: rec.title || "未知" });
                }
                Logger.info('banned_user_cleaned', { userId, threadId: userThreadId });
            } catch (e) {
                state.errors++;
                Logger.error('banned_user_clean_failed', e, { userId });
            }

            // 节流，避免触发 Telegram API 限流
            await new Promise(r => setTimeout(r, CONFIG.CLEANUP_PROBE_DELAY_MS));
        }

        if (exhausted) {
            // 保存断点，提示管理员继续
            await env.TOPIC_MAP.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 });
            Logger.info('cleanbanned_paused', { scanned: state.scanned, cleaned: state.cleaned, errors: state.errors });
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                text: `⏸️ **本轮清理暂停（被封禁账号较多，自动分批处理）**\n\n- 总数: ${total}\n- 已处理: ${state.scanned}\n- 已清理: ${state.cleaned}\n- 无需清理: ${state.skipped}\n- 失败: ${state.errors}\n\n💡 再次发送 /cleanbanned 将继续，直至提示“清理完成”。`,
                parse_mode: "Markdown"
            }, threadId));
            return;
        }

        // 全部处理完成，清除断点
        await env.TOPIC_MAP.delete(stateKey);

        let reportText = `✅ **被封禁账号清理完成**\n\n`;
        reportText += `📊 **统计信息**\n`;
        reportText += `- 被封禁账号总数: ${total}\n`;
        reportText += `- 已清理（数据+聊天记录）: ${state.cleaned}\n`;
        reportText += `- 无需清理: ${state.skipped}\n`;
        reportText += `- 失败: ${state.errors}\n\n`;
        reportText += `💡 封禁状态已保留，这些账号发消息仍会被机器人无视。`;

        if (state.cleaned > 0) {
            reportText += `\n\n🗑️ **已清理的用户**:\n`;
            for (const user of state.users) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (state.cleaned > state.users.length) {
                reportText += `\n...(还有 ${state.cleaned - state.users.length} 个用户)\n`;
            }
        }

        Logger.info('cleanbanned_completed', {
            total,
            cleaned: state.cleaned,
            skipped: state.skipped,
            errors: state.errors
        });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        // 保存断点，下轮可继续
        await env.TOPIC_MAP.put(stateKey, JSON.stringify(state), { expirationTtl: 86400 }).catch(() => {});
        Logger.error('cleanbanned_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\`\n\n💡 再次发送 /cleanbanned 可从断点继续。`,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (userId) {
        await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
    return rec;
}

// 【修复 #2】更新话题状态 - 修复异步操作未等待
async function updateThreadStatus(threadId, isClosed, env) {
    try {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
        if (mappedUser) {
            const userKey = `user:${mappedUser}`;
            const rec = await safeGetJSON(env, userKey, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
                Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
                return;
            }

            // 映射失效：清理后降级全量扫描
            await env.TOPIC_MAP.delete(`thread:${threadId}`);
        }

        const allKeys = await getAllKeys(env, "user:");
        const updates = [];

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
            }
        }

        await Promise.all(updates);
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
    } catch (e) {
        Logger.error('thread_status_update_failed', e, { threadId, isClosed });
        throw e;
    }
}

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
      username = from.username
          .replace(/[^\w]/g, '')  // 只保留字母数字下划线
          .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 【修复 #20】强制 HTTPS
  if (base.startsWith("http://")) {
      Logger.warn('api_http_upgraded', { originalBase: base });
      base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
      new URL(`${base}/test`);
  } catch (e) {
      Logger.error('api_base_invalid', e, { base });
      base = "https://api.telegram.org";
  }

  // 【修复 #13】添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok && resp.status >= 500) {
          Logger.warn('telegram_api_server_error', {
              method,
              status: resp.status
          });
      }

      const result = await resp.json();

      // 记录速率限制
      if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
          const retryAfter = result.parameters?.retry_after || 5;
          Logger.warn('telegram_api_rate_limit', {
              method,
              retryAfter
          });
      }

      return result;
  } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }

      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        await tgCall(env, "copyMessage", withMessageThreadId({
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        }, threadId));
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 【修复 #15, #19】改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];  // 不使用 pop()
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    // 文档
    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    // 音频
    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }

    // 动图
    if (msg.animation) {
        return {
            type: "animation",
            id: msg.animation.file_id,
            cap: msg.caption || ""
        };
    }

    // 语音和视频消息不支持 media group
    return null;
}

// 【修复 #21】实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
    try {
        const prefix = "mg:";
        const allKeys = await getAllKeys(env, prefix);
        let deletedCount = 0;

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
                await env.TOPIC_MAP.delete(name);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            Logger.info('media_groups_cleaned', { deletedCount });
        }
    } catch (e) {
        Logger.error('media_group_cleanup_failed', e);
    }
}

// 【修复 #12, #28】改进媒体组延迟发送
async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await safeGetJSON(env, key, null);

    if (rec && rec.last_ts === ts) {
        // 验证媒体数组
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await env.TOPIC_MAP.delete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            // 【修复 #28】限制 caption 长度
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return { 
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);  // 过滤掉无效项

        if (media.length > 0) {
            try {
                const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
                    chat_id: rec.targetChat,
                    media
                }, rec.threadId));

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await env.TOPIC_MAP.delete(key);
    }
}
