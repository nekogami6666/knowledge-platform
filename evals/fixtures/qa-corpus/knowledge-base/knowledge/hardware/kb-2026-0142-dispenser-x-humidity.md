---
id: kb-2026-0142
title: 分注ロボット X は高湿度環境で Y 軸が脱調する
type: failure
domain: hardware
tags: ["dispenser-x", "motor", "humidity"]
sources:
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
  - kind: discord
    url: "https://discord.com/channels/100200/300400/500600"
people: ["yamada", "suzuki"]
confidence: high
status: active
created: "2026-06-10"
last_verified: "2026-06-10"
review_interval_days: 365
owner: yamada
---

## 事象
高湿度環境(45%RH 超)で分注ロボット X の Y 軸が脱調する。

## 対処 / 学び
除湿機の設置と運転前ホーミングで回避する。推奨湿度しきい値は安全側に 40%RH 以下。
