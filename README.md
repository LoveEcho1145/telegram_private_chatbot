# 🤖 Telegram Private Chatbot (v6.2)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jikssha/telegram_private_chatbot)
![GitHub stars](https://img.shields.io/github/stars/jikssha/telegram_private_chatbot?style=social)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
[![Telegram](https://img.shields.io/badge/Telegram-DM-blue?style=social&logo=telegram)](https://t.me/vaghr_wegram_bot)
[🇺🇸 English](README_EN.md) | [🇨🇳 简体中文](README.md)

**Telegram Private Chatbot** 是一个基于 **Cloudflare Workers** 的高性能 Telegram 双向私聊机器人。它专为解决 Telegram 上的垃圾广告骚扰而生，拥有 Cloudflare Turnstile 网页人机验证系统、强大的管理员指令集以及无缝的消息转发体验。

无需购买服务器，利用 Cloudflare 强大的边缘计算网络，即可免费部署一套企业级的客户服务系统。

---

<details>
<summary>📢 <b>v6.2 版本更新 (2026-10-11)</b></summary>

### 本次更新：
- **修复验证通过后短暂无法发消息**：Cloudflare KV 边缘缓存延迟导致刚验证的用户被误判，现在通过"刚验证"宽限标记兜底，验证后消息立即正常转发。
- **命令支持 @机器人 后缀**：群组内点击命令自动带上的 `@BotName` 后缀不再导致指令失效。
- **移除 /deluser**：批量清理统一使用通用频道的 /cleanbanned。

### 历史更新 (v6.1 / v6.0)：
- **验证消息自动清理**：CF 验证通过后，验证消息自动变为"验证通过"，稍后自动删除。
- **送达回执**：用户消息成功送达管理员话题后，机器人回复"✅ 已送达"提示，稍后自动消失。
- **验证方式更换**：本地答题验证改为 **Cloudflare Turnstile**，在 Telegram Mini App 内一键完成。

### ⚠️ 更新指南：

1. 更新 worker.js 代码（Fork 用户直接 sync，手动部署用户复制代码重新部署）。
2. 前往 Cloudflare Dashboard → **Turnstile** → **Add Site**，域名填写你的 Worker 域名（如 `xxx.workers.dev` 或自定义域名），获取 Site Key 和 Secret Key。
3. 在 Worker 的 **Settings → Variables** 中添加 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY` 两个环境变量，然后重新部署。
</details>

---

## 📑 目录 (Table of Contents)

* [✨ 核心特性](#-核心特性)
* [🛠️ 管理员指令](#-管理员指令)
* [🚀 部署教程](#-部署教程)
    * [方法一：GitHub 一键连接 (推荐)](#方法一github-一键连接部署-推荐-)
    * [方法二：手动复制部署](#方法二手动复制部署-简单直接)
    * [最后一步：激活 Webhook](#最后一步激活-webhook-至关重要)
* [❓ 常见问题 (FAQ)](#-常见问题-faq)
* [📈 Star History](#-star-history)

---

## ✨ 核心特性

v6.0 版本采用 Cloudflare Turnstile 网页验证，专注于**更强的防机器人能力**与**绝对的稳定性**。

| 特性 | 描述 |
| :--- | :--- |
| **🛡️ Turnstile 网页验证** | 采用 **Cloudflare Turnstile** 无感人机验证，在 **Telegram Mini App 内**一键完成（无需跳转浏览器），有效拦截广告机器人。验证通过后提供 **30 天免打扰期**，兼顾安全与用户体验。 |
| **💬 话题群组管理** | 利用 **Telegram Forum Topics** 功能，自动为每位私聊用户创建一个独立的话题，消息隔离，管理井井有条。 |
| **👮 隐形指令系统** | 自动**拦截**用户端发送的 `/` 开头指令，防止普通用户骚扰管理员。管理指令仅在管理员群组内生效。 |
| **🔒 权限控制** | 强大的指令集：支持 **封禁 (/ban)**、**解封 (/unban)**、**清理封禁账号 (/cleanbanned)**、**结单 (/close)** 和 **永久信任 (/trust)** 等操作。 |
| **☁️ Serverless** | 完全基于 Cloudflare Workers 运行。**0 成本**、无需服务器、无需运维、抗高并发。 |
| **📸 多媒体支持** | 完美支持文本、图片、视频、文件等多种消息格式的双向转发，不丢失任何细节。 |

---

## 🛠️ 管理员指令

> **注意**：以下指令仅在 **管理员群组的话题内** 有效。用户在私聊窗口发送指令会被静默拦截，不会对管理员造成骚扰。

| 指令 | 作用 | 适用场景 |
| :--- | :--- | :--- |
| `/close` | **强制关闭对话**<br>机器人会提示用户对话已结束，并拒收新消息。 | 工单处理完成，礼貌结束咨询。 |
| `/open` | **重新开启对话**<br>恢复对该用户的消息转发。 | 误操作关闭，或用户需再次联系。 |
| `/ban` | **封禁用户**<br>机器人将完全无视该用户的所有消息（无提示）。 | 遇到恶意刷屏、广告机器人。 |
| `/unban` | **解封用户**<br>恢复该用户的正常通讯权限。 | 给予改过自新的机会。 |
| `/cleanbanned` | **清理封禁账号**<br>在通用频道发送，自动查找所有被封禁账号，清除其数据与话题聊天记录，**保留封禁状态**。较多时自动分批处理。 | 批量清理被封禁用户。 |
| `/trust` | **永久信任**<br>该用户将永久免除人机验证（永不过期）。 | 熟人、VIP 客户、长期合作伙伴。 |
| `/reset` | **重置验证**<br>强制清除该用户的验证状态，下次需重新验证。 | 测试验证流程，或怀疑账号被盗。 |
| `/info` | **查看信息**<br>显示当前用户的 UID、话题 ID 和链接。 | 查询用户资料。 |
| `/cleanup` | **批量清理**<br>扫描并清理已删除话题的用户数据。用户较多时自动分批处理，按提示再次发送即可继续。 | 清理失效用户。 |
| `/help` | **命令表**<br>显示完整的管理员指令说明（任意话题可用）。 | 随时查阅指令。 |

---

## 🚀 部署教程

### 前置准备
1.  **Telegram Bot**：找 [@BotFather](https://t.me/BotFather) 申请一个机器人，获取 `Token`。
    * *重要设置*：在 BotFather 中关闭 **Group Privacy** (`/mybots` > Settings > Group Privacy > Turn off)。
2.  **管理员群组**：创建一个 Telegram 群组，并**开启话题功能 (Topics)**。
    * 将机器人拉入群组，并设为**管理员**（给予管理话题权限）。
    * 获取群组 ID（通常以 `-100` 开头）。
     ``获取 SUPERGROUP_ID 小技巧：
在 Telegram 桌面端右键群内任意消息，复制消息链接；链接里会有一段 -100xxxxxxxxxx 或 xxxxxxxxxx；若只看到纯数字 xxxxxxxxxx，在前面加上 -100，就是完整的 SUPERGROUP_ID（私密频道/群组同理）。``
3.  **Cloudflare Turnstile**：登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile** → **Add Site**：
    * **Domain** 填写你的 Worker 域名（如 `xxx.workers.dev`，使用自定义域名则填自定义域名）。
    * **Widget Mode** 选择 **Managed** 即可。
    * 创建后获得 **Site Key** 和 **Secret Key**，稍后部署时用到。

### 方法一：GitHub 一键连接部署 (推荐 ★)

这是最简单的自动化部署方式，当您更新 GitHub 仓库时，Cloudflare 会自动重新部署您的 Worker。

1.  **Fork 本仓库** 到您的 GitHub 账户。
2.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
3.  导航到 **Workers & Pages** -> **Create Application**。
4.  点击 **Connect to Git** 标签页。
5.  授权 Cloudflare 访问您的 GitHub，并选择您刚才 Fork 的 `telegram_private_chatbot` 仓库。
6.  **配置部署设置**：
    * 项目名称：`telegram-private-chatbot` (或任意名称)。
    * 生产分支：通常是 `main` 或 `master`。
    * 其余保持默认，点击 **Save and Deploy**。
7.  **⚠️ 关键步骤：绑定数据库与变量**
    * 部署完成后，进入该 Worker 的 **Settings** -> **Variables** 页面。
    * **绑定 KV 数据库** (必须)：
        * 在 Cloudflare 左侧菜单 **KV** 中创建一个新的 Namespace（例如叫 `TOPIC_MAP`）。
        * 回到 Worker 的 Variables 页面，向下滚动到 **KV Namespace Bindings**。
        * 点击 **Add binding**，变量名填写 `TOPIC_MAP` (必须全大写)，Namespace 选择刚才创建的那个。
    * **添加环境变量**：
        * `BOT_TOKEN`: 你的机器人 Token。
        * `SUPERGROUP_ID`: 你的群组 ID (例如 -100123...)。
        * `TURNSTILE_SITE_KEY`: Turnstile 站点的 Site Key。
        * `TURNSTILE_SECRET_KEY`: Turnstile 站点的 Secret Key。
8.  **最后一步**：配置完成后，点击页面顶部的 **Deployments** 标签，找到最新的部署记录，点击右侧的 **Retry deployment** (重新部署)，让变量生效。

### 方法二：手动复制部署 (简单直接)

如果您不想关联 GitHub，可以直接复制代码。

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages** -> **Create Application** -> **Create Worker** ，选择从`hello world`开始。
3.  命名你的 Worker，点击 **Deploy**。
4.  点击 **Edit code**，将本项目 `worker.js` 的所有代码复制粘贴进去，覆盖原代码。
5.  点击右上角 **Deploy** 保存。
6.  **配置 KV 与变量**：
    * 去 **Settings** -> **Variables**。
    * 添加 KV 绑定：Variable name 填 `TOPIC_MAP`，并绑定一个 KV 数据库。
    * 添加环境变量：`BOT_TOKEN`、`SUPERGROUP_ID`、`TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`。
    * 点击 **Save and Deploy**。

---

### 最后一步：激活 Webhook (至关重要)

无论使用哪种部署方式，最后都需要手动告诉 Telegram 你的 Worker 地址。请在浏览器中**严格按顺序**访问以下 URL：

 **设置新 Webhook**：
    ```
   (https://api.telegram.org/bot)<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
    ```
    *将 `<YOUR_TOKEN>` 替换为机器人 Token，`<YOUR_WORKER_URL>` 替换为 Worker 的完整域名或者你绑定的自定义的域名 (如 `https://xxx.workers.dev`)。*
    
 *举例：https://api.telegram.org/bot1234:HUSH2GW/setWebhook?url=https://1234.workers.dev* `<YOUR_TOKEN>前面的bot别删了`

如果返回 `{"ok":true, "result":true, "description":"Webhook was set"}`，即表示部署成功！

---

## ❓ 常见问题 (FAQ)

**Q1: 为什么用户点击验证按钮打不开网页或验证失败？**
A: 请检查：1. `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY` 是否配置正确且属于同一个 Turnstile 站点；2. Turnstile 站点的 Domain 是否包含你的 Worker 域名（如 `xxx.workers.dev` 或自定义域名）；3. 修改变量后是否重新部署了 Worker。

**Q2: 为什么机器人无法在群里创建话题？**
A: 请确保：1. 群组 ID 正确（-100开头）；2. 群组已开启 Topics 功能；3. 机器人是群管理员且拥有 "Manage Topics" 权限。

**Q3: 为什么人机验证能通过收不到转发的消息？**
A: 请仔细检查所有变量名称和id是否准确，删除webhook再重新激活。
 `(https://api.telegram.org/bot)<YOUR_TOKEN>/deleteWebhook?drop_pending_updates=true` 

  如果依然无法正常转发消息，尝试完成所有步骤后，最后再添加bot的管理员权限。

**Q4: 为什么webhook设置失败？**
A: 如果你设置了自定义域名不成功，Webhook 改回 workers.dev 域名再尝试。这种情况是你域名解析失败或者网络环境阻断造成的

---

## 🔒 安全说明

> [!IMPORTANT]
> 请妥善保管您的 Bot API Token ，不要泄露，这些信息关系到您服务的安全性。

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jikssha/telegram_private_chatbot&type=date&legend=top-left)](https://www.star-history.com/#jikssha/telegram_private_chatbot&type=date&legend=top-left)

---
**如果这个项目对你有帮助，请给个 Star ⭐️ 吧！**
