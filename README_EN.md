# 🛡️ TeleGuard (v6.2)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jikssha/telegram_private_chatbot)
![GitHub stars](https://img.shields.io/github/stars/jikssha/telegram_private_chatbot?style=social)
![License](https://img.shields.io/badge/License-MIT-blue.svg)
[![Telegram](https://img.shields.io/badge/Telegram-DM-blue?style=social&logo=telegram)](https://t.me/vaghr_wegram_bot)

[🇺🇸 English](README_EN.md) | [🇨🇳 简体中文](README.md)

**Telegram Private Chatbot** is a high-performance, two-way private messaging bot based on **Cloudflare Workers**. It is designed to solve the problem of spam harassment on Telegram, featuring a Cloudflare Turnstile web-based human verification system, a powerful set of administrator commands, and a seamless message forwarding experience.

Deploy a free, enterprise-grade customer service system utilizing Cloudflare's powerful edge computing network without purchasing any servers.

---

<details>
<summary>📢 <b>v6.2 Release Notes (2026-10-11)</b></summary>

### What's New:
- **Fixed messages failing right after verification**: Cloudflare KV edge-cache delay could misjudge freshly verified users; a "just verified" grace marker now ensures messages forward immediately after verification.
- **Commands support @bot suffix**: Commands auto-completed with `@BotName` in groups (e.g. `/help@BotName`) now work correctly.
- **Removed /cleanbanned**: Redundant with the per-topic /deluser — use /deluser instead.

### Previous Changes (v6.1 / v6.0):
- **Auto-cleaned Verification Message**: After Turnstile verification passes, the verification message is edited to "✅ Verified" and deleted automatically after a few seconds.
- **Delivery Receipt**: After a user's message is delivered to the admin topic, the bot replies with a "✅ Delivered" hint that disappears automatically.
- **New Command /deluser**: Deletes a banned user's data and topic chat history while **keeping the ban active** (requires /ban first).
- **New Verification Method**: **Cloudflare Turnstile** verification completed inside a Telegram Mini App with one click.

### Previous Changes (v6.0):
- **New Verification Method**: The local quiz verification has been replaced with **Cloudflare Turnstile web verification**. Users tap a button to open a verification page and complete it with one click — stronger bot resistance.
- **New Command /deluser**: Deletes a banned user's data and topic chat history while **keeping the ban active** (requires /ban first).
- **New Environment Variables**: `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (create a free site in the Cloudflare Turnstile dashboard).

### ⚠️ Upgrade Guide:
1. Update worker.js (Fork users: sync the repo; manual deployers: paste the new code and redeploy).
2. Go to Cloudflare Dashboard → **Turnstile** → **Add Site**, set the domain to your Worker domain (e.g. `xxx.workers.dev` or your custom domain), and copy the Site Key and Secret Key.
3. In the Worker's **Settings → Variables**, add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, then redeploy.
</details>

---

## 📑 Table of Contents

* [✨ Key Features](#-key-features)
* [🛠️ Administrator Commands](#-administrator-commands)
* [🚀 Deployment Tutorial](#-deployment-tutorial)
    * [Method 1: One-Click Deploy via GitHub (Recommended)](#method-1-one-click-deploy-via-github-recommended-)
    * [Method 2: Manual Deployment](#method-2-manual-deployment-simple--direct)
    * [Final Step: Activate Webhook](#final-step-activate-webhook-crucial)
* [❓ FAQ](#-faq)
* [📈 Star History](#-star-history)

---

## ✨ Key Features

Version 6.0 adopts Cloudflare Turnstile web verification, focusing on **stronger bot resistance** and **absolute stability**.

| Feature | Description |
| :--- | :--- |
| **🛡️ Turnstile Web Verification** | Uses **Cloudflare Turnstile** for frictionless human verification — completed with one click **inside a Telegram Mini App** (no external browser needed), effectively blocking ad bots. Provides a **30-day disturbance-free period** after verification, balancing security and user experience. |
| **💬 Topic Group Management** | Utilizes **Telegram Forum Topics** to automatically create a separate topic for each private chat user, isolating messages for organized management. |
| **👮 Invisible Command System** | Automatically **intercepts** commands starting with `/` sent by users to prevent harassment. Admin commands are only effective within the administrator group. |
| **🔒 Permission Control** | Powerful command set: Supports **Ban (/ban)**, **Unban (/unban)**, **Delete User (/deluser)**, **Close Ticket (/close)**, and **Trust (/trust)** operations. |
| **☁️ Serverless** | Runs entirely on Cloudflare Workers. **Zero cost**, server-free, maintenance-free, and handles high concurrency. |
| **📸 Multimedia Support** | Perfectly supports two-way forwarding of text, images, videos, files, and other message formats without losing any details. |

---

## 🛠️ Administrator Commands

> **Note**: The following commands are only effective within **topics in the administrator group**. Commands sent by users in private chats will be silently intercepted and will not disturb administrators.

| Command | Action | Scenario |
| :--- | :--- | :--- |
| `/close` | **Force Close Chat**<br>The bot will notify the user that the chat has ended and reject new messages. | Ticket resolved; politely ending the consultation. |
| `/open` | **Reopen Chat**<br>Resumes message forwarding for the user. | Accidental closure, or the user needs to contact again. |
| `/ban` | **Ban User**<br>The bot will completely ignore all messages from this user (no notification). | Malicious spamming, ad bots. |
| `/unban` | **Unban User**<br>Restores the user's normal communication permissions. | Giving a second chance. |
| `/deluser` | **Delete User Data**<br>Clears the user's KV data and topic chat history while **keeping the ban active** (requires /ban first). | Completely erasing traces of banned users. |
| `/trust` | **Permanent Trust**<br>The user will be permanently exempt from CAPTCHA verification (never expires). | Acquaintances, VIP clients, long-term partners. |
| `/reset` | **Reset Verification**<br>Forcibly clears the user's verification status; re-verification required next time. | Testing verification flow, or suspected account compromise. |
| `/info` | **View Info**<br>Displays the current user's UID, Topic ID, and profile link. | Checking user details. |
| `/cleanup` | **Batch Cleanup**<br>Scans and cleans up user data for deleted topics. Processes in batches when there are many users — just send /cleanup again as prompted to continue. | Cleaning up inactive users. |
| `/help` | **Command List**<br>Shows the full administrator command reference (works in any topic). | Looking up commands anytime. |

---

## 🚀 Deployment Tutorial

### Prerequisites
1.  **Telegram Bot**: Apply for a bot from [@BotFather](https://t.me/BotFather) and get the `Token`.
    * *Important*: Turn off **Group Privacy** in BotFather (`/mybots` > Settings > Group Privacy > Turn off).
2.  **Administrator Group**: Create a Telegram group and **enable Topics**.
    * Add the bot to the group and set it as an **Administrator** (grant "Manage Topics" permission).
    * Get the Group ID (usually starts with `-100`).
    > **Tip for getting SUPERGROUP_ID**: In Telegram Desktop, right-click any message in the group and copy the message link. The link will contain a segment like `-100xxxxxxxxxx` or `xxxxxxxxxx`. If you only see numbers `xxxxxxxxxx`, add `-100` in front to get the full `SUPERGROUP_ID` (same applies to private channels/groups).
3.  **Cloudflare Turnstile**: Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile** → **Add Site**:
    * Set **Domain** to your Worker domain (e.g. `xxx.workers.dev`, or your custom domain if you use one).
    * Choose **Managed** as the Widget Mode.
    * After creation you will get a **Site Key** and a **Secret Key**, which are needed during deployment.

### Method 1: One-Click Deploy via GitHub (Recommended ★)

This is the simplest automated deployment method. Cloudflare will automatically redeploy your Worker when you update your GitHub repository.

1.  **Fork this repository** to your GitHub account.
2.  Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
3.  Navigate to **Workers & Pages** -> **Create Application**.
4.  Click the **Connect to Git** tab.
5.  Authorize Cloudflare to access your GitHub and select the `telegram_private_chatbot` repository you just forked.
6.  **Configure Deployment**:
    * Project Name: `telegram-private-chatbot` (or any name).
    * Production Branch: Usually `main` or `master`.
    * Keep others as default and click **Save and Deploy**.
7.  **⚠️ Crucial Step: Bind Database & Variables**
    * After deployment, go to the **Settings** -> **Variables** page of the Worker.
    * **Bind KV Database** (Required):
        * In the Cloudflare sidebar menu **KV**, create a new Namespace (e.g., named `TOPIC_MAP`).
        * Go back to the Worker's Variables page, scroll down to **KV Namespace Bindings**.
        * Click **Add binding**, set Variable name to `TOPIC_MAP` (must be uppercase), and select the Namespace you just created.
    * **Add Environment Variables**:
        * `BOT_TOKEN`: Your bot token.
        * `SUPERGROUP_ID`: Your group ID (e.g., -100123...).
        * `TURNSTILE_SITE_KEY`: The Site Key of your Turnstile site.
        * `TURNSTILE_SECRET_KEY`: The Secret Key of your Turnstile site.
8.  **Final Step**: After configuration, go to the **Deployments** tab at the top, find the latest deployment record, and click **Retry deployment** on the right to apply variables.

### Method 2: Manual Deployment (Simple & Direct)

If you don't want to link GitHub, you can copy the code directly.

1.  Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/).
2.  Go to **Workers & Pages** -> **Create Application** -> **Create Worker**, start from `Hello World`.
3.  Name your Worker and click **Deploy**.
4.  Click **Edit code**, copy and paste all code from `worker.js` in this project, overwriting the original code.
5.  Click **Deploy** in the top right corner.
6.  **Configure KV & Variables**:
    * Go to **Settings** -> **Variables**.
    * Add KV Binding: Variable name `TOPIC_MAP`, bind to a KV database.
    * Add Environment Variables: `BOT_TOKEN`, `SUPERGROUP_ID`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
    * Click **Save and Deploy**.

---

### Final Step: Activate Webhook (Crucial)

Regardless of the deployment method, you must manually tell Telegram your Worker address. Visit the following URL in your browser **strictly in order**:

 **Set New Webhook**:
    ```
    [https://api.telegram.org/bot](https://api.telegram.org/bot)<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
    ```
    *Replace `<YOUR_TOKEN>` with your bot token, and `<YOUR_WORKER_URL>` with your Worker's full domain or custom domain (e.g., `https://xxx.workers.dev`).*

If it returns `{"ok":true, "result":true, "description":"Webhook was set"}`, the deployment is successful!

---

## ❓ FAQ

**Q: Why can't users open the verification page or complete verification?**
A: Please check: 1. `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set correctly and belong to the same Turnstile site; 2. The Turnstile site's Domain includes your Worker domain (e.g. `xxx.workers.dev` or your custom domain); 3. You redeployed the Worker after changing variables.

**Q: Why can't the bot create topics in the group?**
A: Please ensure: 1. Group ID is correct (starts with -100); 2. Topics are enabled in the group; 3. The bot is an administrator and has "Manage Topics" permission.

---

## 🔒 Security Note

> [!IMPORTANT]
> Please keep your Bot API Token and Secret Token safe, as this information is critical to the security of your service.

> [!WARNING]
> Do not change the configured Secret Token arbitrarily! After changing it, all registered bots will fail to work because they cannot match the original token. If you need to change it, all bots must be re-registered.

- Choose a secure and memorable Secret Token during initial setup.
- Avoid using simple or common prefixes.
- Do not share sensitive information with others.

---

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jikssha/telegram_private_chatbot&type=Date)](https://star-history.com/#jikssha/telegram_private_chatbot&Date)

---
**If this project helps you, please give it a Star ⭐️!**
