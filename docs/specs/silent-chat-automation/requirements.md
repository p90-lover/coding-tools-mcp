# Requirements: silent chat automation

## 功能概述

App-generated wake-ups and other background follow-ups should resume the chat without looking like messages from the person.

## 范围边界

In scope: new wake-ups, command watches, monitor deliveries, scheduled or recurring follow-ups, later goal rounds and adopted native turns. Hide their prompt from the chat and transcript copies. Out of scope: deleting existing history, suppressing replies or actual approval requests, changing timers, routes or permission policy.

## 需求列表

### FR-1: Deliver automation without a prompt bubble

**Priority:** Must. A person should be able to leave a chat waiting for work without its reminders appearing in the conversation.

#### 验收标准（EARS）

1. WHEN native automation creates a follow-up, the app SHALL deliver its normal prompt and omit the prompt from the user-facing transcript, including while waiting for its run to appear.
2. WHEN that turn replies, fails, or needs approval, the app SHALL continue showing the reply, failure, or approval through the existing controls.

### FR-2: Preserve real user input and history alignment

**Priority:** Must. A person should still be able to see and act on their genuine messages.

#### 验收标准（EARS）

1. WHEN a person types a similar-looking note or steers during an automated turn, the app SHALL show that human text.
2. WHEN rebuilding from stored history, deleting another message, or changing the chat view, the app SHALL keep replies and message positions aligned and keep the automation prompt hidden.

## 非功能需求

Do not add file or database writes beyond the existing send, or migrate old chats. No public API for silencing user messages or approval requests.

## 依赖关系

The existing Electron workflow and its persisted task description supply the chat's prompt history.

## 检查清单

- [x] Scope and acceptance criteria defined for FR-1 and FR-2.
