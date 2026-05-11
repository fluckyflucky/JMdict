# JMdict

本地日语词典 + 单词卡片。数据来源 [JMdict](https://www.edrdg.org/jmdict/)。

## 目录

- `scripts/build-db.ts` — 构建 SQLite 数据库（21万+词条、中日例句匹配）
- `index.html` — 搜索页（支持日/英/中搜索）
- `flashcard.html` — 单词卡片页（随机抽词，点击显示释义）

## 使用

```bash
npm install
npm run build   # 构建数据库 + 拷贝页面到 dist/
npm run serve   # http://localhost:3456
```

例句匹配使用 Kuromoji 形态分析器做分词 + 倒排索引。有汉字的词按汉字表面形匹配，纯假名词按读音匹配。
