# 天下廣告訂版 Cue 助手

Chrome Manifest V3 唯讀側欄。開啟公司訂版系統的一張訂單，即可核對權益、查逐日庫存、試排並複製 Cue。正式訂版由承辦人在原系統核對與儲存。

[操作說明](https://cms-copy-studio.github.io/cue-assistant/) · [模擬訂單展示](https://cms-copy-studio.github.io/cue-assistant/demo/) · [下載本機載入包](https://cms-copy-studio.github.io/cue-assistant/downloads/cue-assistant.zip)

## 維護

- `extension/` 是可在 Chrome 116 或以上版本載入的完整擴充功能。於 `chrome://extensions` 啟用開發人員模式後，選「載入未封裝項目」。公司正式發佈與自動更新依管理政策辦理。
- `demo/source.mjs` 提供虛構訂單與庫存。公開展示和正式側欄共用介面與排程程式。公開頁沒有公司登入或查詢能力。
- 執行 `node --test tests/*.test.mjs`。執行 `node scripts/build.mjs` 產生靜態展示及安裝包；建置環境需 Node.js 及 Python 3。將產物與來源一併提交。Pages 使用 main 的 /docs。
- 網站版位以逐格明細中的精確剩餘量與當期費率試算；社群以當日時段的可用次數及單次發送價格試算。後台欄名或結構變動時，請更新讀取程式，以兩個不同餘量的格子往返驗收，再驗證切換訂單、日期與缺值。
- 訂單、查詢、試排結果都只在瀏覽器暫存。唯一寫入 Chrome 本機儲存的是個人偏好。示範模式的偏好只保留在當次頁面。版本庫與測試只使用合成資料。
