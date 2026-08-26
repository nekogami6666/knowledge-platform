# ナレッジ共有 bot 利用ガイド(ユーザー向け)— 正典は knowledge-base へ移動しました

社内 Discord のナレッジ共有 bot(QB Knowledge Ops)の**利用者向け操作説明の正典は、
knowledge-base リポジトリのナレッジエントリ**です(bot 自身が `/ask` の検索対象にしており、
`/ask bot の使い方` でも同じ内容が返ります):

- **[ナレッジ共有エージェント利用ガイド](https://github.com/queeenb-com/knowledge-base/blob/main/knowledge/ops/kb-2026-yscyrt-knowledge-sharing-agent-user-guide.md)**
  (`knowledge/ops/kb-2026-yscyrt-knowledge-sharing-agent-user-guide.md`)
- 全体像・役割別の入口・困ったときの索引: [knowledge-base の README](https://github.com/queeenb-com/knowledge-base#readme)

覚えることは実質この 3 つだけです(詳細・制限・見送り時の案内は上のガイドへ):

| やりたいこと | 操作 |
|---|---|
| 知りたい | `/ask` で質問する |
| 残したい | 💡 を付ける・`knowledge_memo` ボイスチャンネルで話す・面談パネル |
| 承認したい | bot からの DM、または `#knowledge_sharing` の bot 通知に 👍 |

このリポジトリ(knowledge-platform)側には利用者向けの手順本文を置きません(重複して食い違うのを防ぐため)。
管理者向けは [admin-guide.md](admin-guide.md)、開発者向けは [architecture.md](architecture.md) /
[design.md](design.md)、個別の有効化・障害対応は [runbooks/](runbooks/) を参照してください。
