# CoThink

CoThink は、対等な 2 つのモデルが同じ問いに独立して答え、質問と修正を交換し、固定されたすべての主張バージョンをそれぞれ評価するローカル CLI です。レポートには両者の判断、理由、証拠の要求、未解決の問題が残ります。代表者や勝者は選びません。合意は正しさの証明ではありません。

Node.js 22 以降、npm、設定する API の認証情報が必要です。このソースからインストールします。

```bash
git clone https://github.com/XSY-28/CoThink.git
cd CoThink
npm ci
npm run build
npm pack --workspace packages/cothink --pack-destination .
npm install -g ./cothink-0.6.1.tgz
cothink setup
cothink test
cothink start --question "この提案にはどのようなトレードオフがありますか？" --context proposal.md
cothink view SESSION_ID
```

`setup` は API を呼び出しません。キーの非表示入力を省略して、既存の環境変数を利用できます。設定、キーファイル、セッションの既定の保存先は、現在のディレクトリの `.cothink/config.json`、`.cothink/keys.env`、`.cothink/sessions/` です。既存ファイルは上書きしません。`test` は接続と出力形式を確認するため、最大 4 回の有料 API リクエストを行います。回答の品質は評価しません。

現在はソースから作成する独立した tarball を提供し、npm registry には未公開です。OpenAI-compatible とネイティブ Anthropic-compatible の通信を実装しています。実際の GPT/Claude アカウントは未検証です。問いとコンテキストは設定した API に送信されます。

[討論モードの実装計画](docs/plan/discussion-v1.md)は、思考の強度、参加と決定の重み、同じ回答バージョンへの合意、早期終了、異論の要約を扱います。これらは未実装です。現在のベースラインは両者のレポートを生成し、討論の内容も表示します。

詳細は [English README](README.md)、[インストール](docs/cothink/INSTALL.md)、[設定](docs/cothink/CONFIGURATION.md)、[リリース準備](docs/cothink/RELEASE.md) を参照してください。[onevcat/argue](https://github.com/onevcat/argue) を基にし、[MIT ライセンス](LICENSE) と元の著作権表示を保持しています。
