# SmartNotes 排障与优化完整记录

> 日期：2026-05-14
> 开发者：Claude (wplma)
> 仓库：D:\dd0211\repository\pttw

---

## 一、问题发现：Excel 导出后格式丢失

### 1.1 问题现象
用户在 SmartNotes 页面导出 Excel 后，重新导入，编辑内容时格式全部变成一行了。

### 1.2 问题定位
**判断过程**：
1. 查看 `pages/SmartNotes.html` 第 559 行
2. 发现导出代码：
```javascript
const data = this.notes.map(note => ({
  内容: note.content.replace(/<[^>]*>/g, ''),  // 问题在这里！
  ...
}));
```

**原因分析**：`replace(/<[^>]*>/g, '')` 把所有 HTML 标签都去掉了，导致格式信息完全丢失。

### 1.3 解决方案
修改为保留原始 HTML 内容：
```javascript
const data = this.notes.map(note => ({
  内容: note.content, // 保留原始 HTML 格式
  ...
}));
```

同时新增"纯文本内容"列用于 Excel 中查看。

### 1.4 提交记录
```bash
git add pages/SmartNotes.html
git commit -m "修复 SmartNotes 导出时格式丢失问题"
git push
# Commit: 60caff6
```

---

## 二、功能增强：导入导出系统重构

### 2.1 需求分析
用户确认优先级：导入导出 > 编辑体验 > 组织管理 > 查找/视图

### 2.2 实现功能
1. **JSON 导出/导入**（追加模式）
2. **Markdown 导出**（HTML 转 Markdown）
3. **备份恢复功能**（覆盖模式）
4. **UI 按钮更新**

### 2.3 关键代码实现

#### JSON 导出
```javascript
exportJSON() {
  const data = {
    version: 1,
    exportTime: new Date().toISOString(),
    notes: this.notes
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `便签备份_${this.formatDate(new Date()).replace(/[\/\s:]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
```

#### HTML 转 Markdown
```javascript
htmlToMarkdown(html) {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(b|strong)>/gi, '**');
  text = text.replace(/<\/?(em|i)>/gi, '*');
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi, '[$2]($1)');
  // ... 更多转换规则
  return text.trim();
}
```

### 2.4 提交记录
```bash
git add pages/SmartNotes.html
git commit -m "SmartNotes 增强：JSON/Markdown导出、备份恢复功能"
git push
# Commit: 1ebf286
```

---

## 三、UI 全面重构 v2.0

### 3.1 设计决策
- **设计风格**：简约现代（大量留白、卡片式、渐变色、微交互）
- **深色模式**：支持，用户可切换
- **字体**：Inter + 苹方 + 微软雅黑

### 3.2 配色方案

**亮色模式**
```css
--primary: #6366f1;        /* 靛蓝紫 */
--primary-light: #818cf8;
--accent: #f43f5e;          /* 玫红 */
--bg: #fafafa;
--surface: #ffffff;
```

**暗色模式**
```css
--bg: #0f172a;
--surface: #1e293b;
--primary: #818cf8;
```

### 3.3 改动清单

1. **Header**：渐变背景（靛蓝紫→紫色）+ 毛玻璃装饰
2. **卡片**：16px圆角 + 彩色阴影 + hover上浮
3. **编辑器**：居中弹窗 + 格式工具栏
4. **动效**：staggered淡入 + hover反馈

### 3.4 提交记录
```bash
git add pages/SmartNotes.html docs/smartnotes-evolution.md
git commit -m "SmartNotes UI v2.0：简约现代风格全面重构"
git push
# Commit: 545b075
```

---

## 四、问题修复系列

### 4.1 Header 太大

**问题现象**：标题栏占据太多空间

**解决方案**：
```css
.app-header {
  padding: 1rem 0 1.5rem;  /* 原: 2rem 0 3rem */
  margin-bottom: 1.5rem;    /* 原: 2rem */
}

.app-logo-icon {
  width: 40px;   /* 原: 48px */
  height: 40px;  /* 原: 48px */
}

.app-title {
  font-size: 1.35rem;  /* 原: 1.75rem */
}
```

### 4.2 快捷键提示不可见

**问题现象**：浅色模式下 `Ctrl + Enter 保存` 文字看不见

**原因分析**：`--text-muted` 在浅色模式下颜色太浅

**解决方案**：
```css
.editor-hint {
  color: var(--text-secondary);  /* 原: var(--text-muted) */
}

.editor-hint kbd {
  color: var(--text);  /* 新增：确保文字可见 */
}
```

### 4.3 底部操作栏太丑

**问题现象**：按钮排列混乱，有"导出"、"Excel"、"JSON"等文字

**判断过程**：分析用户需求，用户希望：
- 只保留"导入"和"导出"两个按钮
- 点击后弹出格式选择

**最终方案**：
```
┌─────────────────────────────────────────────────────────┐
│              [📤 导出]              [📥 导入]            │
└─────────────────────────────────────────────────────────┘
```

点击"导出" → 弹出格式选择（Excel / JSON / MD）
点击"导入" → 选择文件（自动识别格式，覆盖当前数据）

**HTML 结构**：
```html
<button class="io-btn primary" @click="showExportMenu = true">
  <i class="fas fa-arrow-up"></i>导出
</button>
<button class="io-btn" @click="showImportMenu = true">
  <i class="fas fa-arrow-down"></i>导入
</button>
```

### 4.4 导入不支持 Markdown

**问题现象**：用户问为什么导入不支持 MD

**解决方案**：新增导入 Markdown 功能

**关键代码**：
```javascript
importMarkdown(e) {
  const file = e.target.files[0];
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    const lines = text.split('\n');
    const title = lines[0]?.replace(/^#+\s*/, '').trim() || file.name;

    this.notes = [{
      id: Date.now(),
      title: title,
      content: `<p>${lines.slice(1).join('<br>')}</p>`,
      tags: '',
      tagsArray: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }];
    this.saveNotes();
  };
  reader.readAsText(file);
}
```

### 4.5 空数据时无导入导出按钮

**问题现象**：页面没有便签数据时，无法显示导入、导出按钮

**原因分析**：`v-if="filteredNotes.length > 0"` 条件太严格

**解决方案**：改为 `v-if="notes.length > 0"`，只在真正没有数据时隐藏

### 4.6 导入导出按钮移到头部

**用户需求**：把导入导出操作放到页面上方，页面宽度减小

**解决方案**：
1. Header 新增两个小按钮
2. 底部操作栏只保留分页

```html
<!-- 头部 -->
<div class="header-actions">
  <button class="header-tool-btn" @click="showExportMenu = true" title="导出便签">
    <i class="fas fa-download"></i>
  </button>
  <button class="header-tool-btn" @click="showImportMenu = true" title="导入便签">
    <i class="fas fa-upload"></i>
  </button>
</div>
```

### 4.7 按钮样式区分

**问题现象**：导入导出按钮无法一眼区分

**解决方案**：
```css
.header-export {
  background: rgba(16, 185, 129, 0.3);  /* 绿色 */
  border-color: rgba(16, 185, 129, 0.5);
}

.header-import {
  background: rgba(99, 102, 241, 0.3);   /* 紫色 */
  border-color: rgba(99, 102, 241, 0.5);
}
```

### 4.8 分页栏太大

**问题现象**：底部分页栏占据太大空间

**解决方案**：简化为一整行紧凑样式
```css
.page-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}
```

---

## 五、Markdown 编辑功能

### 5.1 功能设计
1. 点击工具栏 `<>` 图标切换到 Markdown 模式
2. Markdown 模式可编辑/预览切换
3. 保存时自动将 Markdown 转为 HTML

### 5.2 引入 marked.js
```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```

### 5.3 Markdown 渲染
```javascript
renderMarkdown(text) {
  if (!text) return '';
  const raw = marked.parse(text || '');
  return DOMPurify.sanitize(raw);
}
```

### 5.4 切换逻辑问题

**问题现象**：新建 Markdown 便签无法预览和保存

**原因分析**：
1. rich 模式输入的内容是 HTML
2. 切换到 markdown 模式后，内容没转换
3. marked.parse 处理 HTML 标签导致乱码

**解决方案**：切换时将 HTML 转成纯文本
```javascript
toggleEditorMode() {
  if (this.editorMode === 'rich') {
    const html = this.$refs.editor ? this.$refs.editor.innerHTML : '';
    const temp = document.createElement('div');
    temp.innerHTML = html;
    this.currentNote.content = temp.textContent || temp.innerText || '';
    this.editorMode = 'markdown';
  } else {
    this.editorMode = 'rich';
  }
  this.showMarkdownPreview = false;
}
```

### 5.5 保存逻辑
```javascript
saveNote() {
  // ...
  if (this.editorMode === 'markdown') {
    this.currentNote.content = this.renderMarkdown(this.currentNote.content);
    this.currentNote.isMarkdown = true;
  } else {
    this.currentNote.isMarkdown = false;
  }
  // ...
}
```

---

## 六、最终提交记录

```bash
# 1. 修复格式丢失
git commit -m "修复 SmartNotes 导出时格式丢失问题"
# 60caff6

# 2. 功能增强
git commit -m "SmartNotes 增强：JSON/Markdown导出、备份恢复功能"
# 1ebf286

# 3. UI v2.0
git commit -m "SmartNotes UI v2.0：简约现代风格全面重构"
# 545b075

# 4. 优化 Header 尺寸
git commit -m "优化 SmartNotes Header 尺寸"
# 75c4dc3

# 5. 修复快捷键提示
git commit -m "修复编辑器快捷键提示在浅色模式下不可见的问题"
# 7a18a95

# 6. 优化底部操作栏
git commit -m "优化 SmartNotes 底部操作栏和分页器"
# b0bb7bf

# 7. 简化导入导出
git commit -m "简化 SmartNotes 导入导出交互"
# 93363bb

# 8. 导入支持 Markdown
git commit -m "SmartNotes 导入支持 Markdown 格式"
# e1a734b

# 9. 修复空数据按钮隐藏
git commit -m "修复 SmartNotes 导入导出按钮在空数据时隐藏的 Bug"
# daf64db

# 10. 底部操作栏始终显示
git commit -m "修复 SmartNotes 底部操作栏始终显示"
# 46db6c1

# 11. Excel 导出文件名加时间戳
git commit -m "SmartNotes 导出 Excel 文件名添加时间戳"
# 64992b4

# 12. 导入导出移到头部
git commit -m "SmartNotes 导入导出移到头部，修复 Markdown 导入"
# 1be3eec

# 13. Markdown 编辑模式
git commit -m "SmartNotes 新增 Markdown 编辑模式"
# e87d13c

# 14. marked.js 增强
git commit -m "SmartNotes 使用 marked.js 增强 Markdown 渲染"
# ddcbd79

# 15. 修复 Markdown 保存显示
git commit -m "修复 SmartNotes Markdown 保存后显示问题"
# 0b686f1

# 16. 优化导入导出按钮
git commit -m "优化 SmartNotes 导入导出按钮样式"
# 1d57d78

# 17. 简化分页栏
git commit -m "简化 SmartNotes 分页栏样式"
# ededb77

# 18. 修复 Markdown 模式切换
git commit -m "修复 SmartNotes Markdown 模式切换问题"
# 4611e8b
```

---

## 七、文件结构

```
D:\dd0211\repository\pttw\
├── pages/
│   └── SmartNotes.html      # 主要文件（1800+ 行）
└── docs/
    ├── smartnotes-evolution.md    # 演进记录
    └── smartnotes-debug-log.md   # 本文档
```

---

## 八、关键代码片段汇总

### 8.1 数据结构
```javascript
{
  id: Number,
  title: String,
  content: String,        // HTML 内容
  tags: String,            // 逗号分隔
  tagsArray: Array,
  createdAt: Date,
  updatedAt: Date,
  isMarkdown: Boolean      // 是否为 Markdown 便签
}
```

### 8.2 导出函数
- `exportExcel()` - Excel 导出
- `exportJSON()` - JSON 导出
- `exportMarkdown()` - Markdown 导出

### 8.3 导入函数
- `importExcel(e)` - Excel 导入
- `importJSON(e, mode)` - JSON 导入
- `importMarkdown(e)` - Markdown 导入

### 8.4 核心函数
- `showEditor()` - 显示编辑器
- `editNote(note)` - 编辑便签
- `saveNote()` - 保存便签
- `toggleEditorMode()` - 切换编辑模式
- `renderMarkdown(text)` - Markdown 转 HTML

---

## 九、测试验证

### 9.1 测试地址
https://232310.xyz/pages/SmartNotes.html

### 9.2 测试用例
1. ✅ 导出 Excel/JSON/MD 格式
2. ✅ 导入 Excel/JSON/MD 文件
3. ✅ 新建便签（富文本）
4. ✅ 新建便签（Markdown）
5. ✅ Markdown 编辑/预览切换
6. ✅ 主题切换（亮/暗）
7. ✅ 空数据时导入功能
8. ✅ 搜索和标签筛选

---

## 十、后续待办

- [ ] 第二阶段：编辑体验（撤销/重做、拖拽排序）
- [ ] 第三阶段：组织管理（置顶/收藏、标签管理、文件夹分组）
- [ ] 第四阶段：搜索与视图（图库模式、看板模式）
- [ ] 云端同步（暂不做）

---

*文档生成时间：2026-05-14*
*工具：Claude Code (PowerShell + Git)*
