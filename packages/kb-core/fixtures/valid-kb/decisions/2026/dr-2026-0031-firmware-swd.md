---
id: "dr-2026-0031"
title: "分注ユニットのファームウェア書き込みを CAN 経由から SWD 直結に変更"
date: "2026-06-03"
status: "accepted"
deciders:
  - "yamada"
  - "sato"
sources:
  - kind: "meeting"
    repo: "org/minutes"
    path: "2026/06/2026-06-03-hw-weekly.md"
tags:
  - "dispenser-x"
  - "firmware"
---

## 決定内容
SWD 直結に変更する。

## 検討した代替案と却下理由
CAN 経由は書き込み速度が遅い。
