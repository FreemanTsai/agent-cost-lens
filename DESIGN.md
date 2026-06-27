# Design System: Agent Cost Lens

> Dashboard 風格參考自 [getdesign.md/mastercard/design-md](https://getdesign.md/mastercard/design-md)
>
> Agent Cost Lens: local AI cost analytics. Dark operational canvas, dense metrics, warm magenta accent.

## Design Tokens

### Mode
Dark theme（暗色主題），暖色調暗黑（warm dark），非冷色藍黑

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Background | `#0d0d0d` | `--bg` |
| Card | `#1a1a1a` | `--bg-card` |
| Surface | `#222` | `--bg-surface` |
| Hover | `#2a2a2a` | `--bg-hover` |
| Border | `#2e2e2e` | `--border` |
| Accent | `#ffb1ee` | `--accent` |
| Accent Subtle | `rgba(255,177,238,0.1)` | `--accent-subtle` |
| Text Primary | `#ededed` | `--text` |
| Text Secondary | `#a0a0a0` | `--text-secondary` |
| Text Muted | `#666` | `--text-muted` |

### Font

```css
--font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

### Radius

| Level | Value |
|-------|-------|
| Default | `12px` |
| Small | `8px` |

### Accent Usage

- Active tab / pill button
- Bar chart cost values
- Progress bar fill (cold → hot gradient)
- Primary CTA button
- Details marker caret

## RWD Breakpoints

| Breakpoint | Target |
|-----------|--------|
| `< 480px` | Small phone |
| `640px` | Large phone |
| `768px` | Tablet |
| `1024px` | Desktop |
| `1440px` | Max container |

## Responsive Grid Behavior

| Component | Desktop | Tablet | Mobile |
|-----------|---------|--------|--------|
| Header bar (8 cells) | 8 columns | 4 columns | 2 columns |
| Panel grid (6 panels) | 2 columns | 2 columns | 1 column |
| Details (8 cells) | 4 columns | 4 columns | 2 columns |
| Period tabs | inline | inline | horizontal scroll |

## Page-Specific Overrides

### `public/index.html`

Compared to the original version, the following adjustments were made:

**Color & Style**
- 全面改用暗色主題，以 warm magenta（`#ffb1ee`）為強調色
- Card / surface 層次分明：`#0d0d0d` → `#1a1a1a` → `#222`
- 資料數值（cost / token）以 monospace 呈現

**RWD**
- 所有 grid 元件在不同 breakpoint 都有對應欄數
- `.table-wrap` 防止表格破版（overflow-x: auto）
- 長文字全面 `text-overflow: ellipsis` 截斷
- `.summary-meta` 在手機版隱藏／截斷
- Search input 改為 `flex: 1` 自動縮放，不再固定寬度
- Period tabs 支援橫向捲動

**Bar Chart（Heat Style）**
- 長條從青色 `#22d3ee` → 黃色 `#facc15` → 橘色 `#f97316` → 紅色 `#ef4444`
- 模擬熱力圖／雨量條效果：短 bar 偏冷色，長 bar 偏熱色

**印刷支援**
- `@media print` 保留黑白色可讀性

## Files

| File | Description |
|------|-------------|
| `public/index.html` | Dashboard（統計 + 搜尋 + Session Detail） |
| `DESIGN.md` | This file — design system reference |
