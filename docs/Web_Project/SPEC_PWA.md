# PWA化 & オフラインキャッシュ 詳細仕様書 (SPEC_PWA.md)

本ドキュメントは、血糖値・食事・インスリン統合管理システム Web版における **「PWA (Progressive Web Apps) 化 & オフラインキャッシュ（Offline Support）」** の機能要件、マニフェスト設計、Service Workerキャッシュ戦略、UI通知設計、および受け入れ条件（DoD）を定めた仕様書（SSOT）です。
`ARCHITECTURE.md` Section 1（Local-First PWA設計）に完全準拠して策定されています。

---

## 1. 概要 & 目的

糖尿病患者にとって、外出先・移動中・地下・電波障害時など、**「いつでも・どこでも・ネット環境に依存せず、血糖値を確認し、食事とインスリンを記録できること」** は生命に関わる医療的安全性（Safety-Critical）の要件です。

本システムは IndexedDB (Dexie.js) による Local-First データベースをすでに備えているため、
1. **Web App Manifest** によるネイティブアプリ同様のホーム画面インストール
2. **Service Worker** による静的アセット（HTML/CSS/JS/Fonts/SVG）の完全オフラインキャッシュ
3. **ネットワーク状態検知 (Online/Offline State Machine)** による安心のUIインジケーター
を統合することで、**100%完全オフラインで動作する医療PWA** を実現します。

---

## 2. Web App Manifest 仕様 (`public/manifest.webmanifest`)

```json
{
  "name": "血糖・食事・インスリン統合管理システム",
  "short_name": "CGMマネージャー",
  "description": "FreeStyleリブレ生データと食事・インスリン記録を統合管理するLocal-First Webアプリ",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "theme_color": "#0f172a",
  "background_color": "#f8fafc",
  "lang": "ja",
  "categories": ["medical", "health", "lifestyle"],
  "icons": [
    {
      "src": "/icons/icon-192.svg",
      "sizes": "192x192",
      "type": "image/svg+xml",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.svg",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable.svg",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "maskable"
    }
  ]
}
```

---

## 3. Service Worker キャッシュ戦略 (`public/sw.js`)

### 3.1 キャッシュライフサイクル & 遅延チャンクのアイドル時先読み
- **キャッシュ名**: `cgm-manager-v2`（`public/sw.js`）
- **Pre-cache (インストール時 `APP_SHELL_ASSETS`)**:
  - `/` および `/index.html`
  - `/manifest.webmanifest`
  - `/icons/icon-192.svg`, `/icons/icon-512.svg`
- **遅延読み込みチャンク（Code Splitting）のアイドル時バックグラウンド先読み**:
  - 初期表示（カレンダー画面）の高速描画を最優先するため、日次詳細ドロワー（`DailyDetailDrawer`）・24時間グラフ（`DailyGlucoseChart`）・各サブ画面（`FoodMasterView`, `AnalysisView`, `SettingsView`）・記録モーダル（`MealRecordModal`, `ActivityRecordModal`, `CsvImportModal`）は `React.lazy()` によりチャンク分割されている。
  - 同時に、アプリ起動直後にオフライン（機内モード・地下移動等）になった場合でも未訪問画面のチャンク取得エラー（`Failed to fetch dynamically imported module`）を起こさないよう、`src/App.tsx` の初期マウントから 200ms 後にバックグラウンドで全遅延チャンクを非同期プリロード（ウォームアップ）する。
- **Fetch イベント戦略 (Stale-While-Revalidate & 大容量データJSONのCache Storage除外)**:
  - 静的アセット（CSS, JS, フォント, 画像）: キャッシュを最優先（Cache-First）で即座に返却し、バックグラウンドでネットワーク更新。
  - **大容量デモデータ JSON (`/data/*.json`) の Cache Storage 除外**: スマートフォン端末の Cache Storage 圧迫を防止するため、`url.pathname.startsWith('/data/')` のリクエストは Service Worker の Cache Storage 保存対象から除外し、`activate` および `fetch` 時に既存の `/data/` キャッシュエントリがあれば自動削除する。
  - API通信（Google Gemini 等の外部リクエスト）: Network-Only（失敗時はオフライン簡易辞書にフォールバック）。
  - ナビゲーションリクエスト: オフライン時はキャッシュされた `/index.html` を返却（SPAのルーティング保護）。

---

## 4. UIコンポーネント & UX設計

### 4.1 オフライン状態バナー (`src/components/common/OfflineBanner.tsx`)
- ブラウザの `navigator.onLine` および `window.addEventListener('online' | 'offline')` を `useOnlineStatus` (`src/lib/pwa.ts`) で監視。
- オフライン時、画面上部（ヘッダー直下）に控えめで安心感のあるバナーを表示（オンライン時は非表示）：
  > 📴 **オフライン動作中**: 端末内の保存データで動作しています。食事の記録やグラフ閲覧はそのまま行えます。

### 4.2 PWAインストール促進機能 (`src/lib/pwa.ts` / `src/components/settings/SettingsView.tsx` / `src/components/settings/VerificationPwaSection.tsx`)
- ブラウザの `beforeinstallprompt` イベントを `usePwaInstallPrompt()` フック（`src/lib/pwa.ts`）で捕捉。
- 日常のヘッダー領域を圧迫しないよう、ヘッダー上には配置せず、**設定画面（`SettingsView.tsx` / `VerificationPwaSection.tsx` の「5. 動作検証・アプリ追加」）内に「ホーム画面にアプリを追加」ボタン**として配置（`isInstallable === true` の場合のみ表示）。

---

## 5. 受け入れ基準 (Definition of Done: DoD)

- [x] **DoD-1: Web App Manifest の認識**
  - `manifest.webmanifest` が `index.html` に正しくリンクされ、ブラウザの開発者ツールで PWA Ready と認識されること。
- [x] **DoD-2: Service Worker の正常登録とライフサイクル**
  - アプリ起動時に Service Worker がエラーなく登録され、静的アセットがキャッシュされること。
- [x] **DoD-3: 完全オフラインでの画面動作**
  - ネットワークを切断（DevTools で Offline モード）にしても、カレンダー、日次推移グラフ、臨床分析、食品・活動一覧、食事手動記録が一切エラーなく動作すること。
- [x] **DoD-4: オフライン状態の可視化**
  - オフライン切断時に、ユーザーへ安心感を与えるオフラインバナー（`OfflineBanner.tsx`）が表示されること。
- [x] **DoD-5: PWAインストールプロンプト対応（通常モード）**
  - `beforeinstallprompt` イベントを検知し、通常モードの設定画面（`SettingsView.tsx`）のインストール案内ボタンが適切に制御されること（デモアプリでは該当セクションを非表示化）。
- [x] **DoD-6: セキュリティレスポンスヘッダー (`public/_headers`)・コンソール出力クリーンアップ & ビルド品質**
  - `public/_headers` により `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy` が配信され、`public/sw.js` や `src/lib/pwa.ts` 等から不要な `console.log` が除去され、TypeScript 型検査（`npm run typecheck`）および本番ビルド（`npm run build`）がエラーゼロでパスすること。
