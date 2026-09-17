# pi-kb

Pi 扩展：跨项目检索本地笔记/文档，读完原文后整理成可复用笔记，并把已验证的经验记下来。

已在 Node.js `24.15.0`、`@earendil-works/pi-coding-agent` `0.85.1` 上验证。`npm test` 覆盖配置、检索、写入和扩展事件。模型是否主动调用工具取决于所用模型，插件不保证每次都会查或记。

## 安装

本目录作为本地 Pi package：

```bash
pi install /home/Node/pi-docs
```

或在 `~/.pi/agent/settings.json` 的 `packages` 中加入该路径（相对 settings 文件）。

配置写在 `getAgentDir()` 下的 `pi-kb.json`（默认 `~/.pi/agent/pi-kb.json`）：

```json
{
  "roots": [
    {
      "name": "obsidian",
      "path": "/home/Node/pi-docs/Obsidian",
      "writable": false
    },
    {
      "name": "agent",
      "path": "/home/Node/pi-docs/Obsidian/agent",
      "writable": true
    }
  ]
}
```

`path` 必须是绝对路径或 `~/`（Windows 可用 `C:\\Notes` 或 `C:/Notes`）。最多一个 `writable: true`。`exclude` 为相对该 root 的路径前缀，按路径段匹配。修改配置后 `/reload`。

可选 `enrich` 指定独立的低价清洗模型（`provider`、`model`，以及可选的 `maxOutputTokens`、`timeoutMs`）。改目录配置时会保留该字段。未配置时仍可只做规则清洗。

Windows：路径比较忽略大小写和斜杠方向；目录联接按符号链接跳过，不跟随。写入先尝试硬链接，失败则用 `COPYFILE_EXCL` 独占拷贝，不会覆盖已有笔记。

临时调试：`pi -e ./extensions/index.ts`

## 使用

- `kb_search({ query, root?, limit? })`：短关键词。省略 `root` 时联合检索范围内的原文、派生笔记、digest 和 lesson，不再因 AI 笔记命中而跳过原文。未启用隔离时范围为全部来源；启用后默认当前项目加共享资料。指定 root 只搜该来源，仍受项目范围约束。中文按字与连续双字、代码按完整标识符检索；多词优先全部命中，不足时返回标明“部分匹配”的结果。标题、别名和常见问法可命中，问法命中不是“该功能已支持”的证据。
- `kb_write({ title, body, readRef? })`：有 `readRef` 时保存该原文版本的资料整理；没有则保存问题经验。只新建文件，不改原笔记。写入后会更新该记录目录的索引。启用隔离后，经验记到当前项目；范围外原文不签发 `readRef`。
- `/kb`：看来源。有终端 UI 时用带边框的居中弹窗（左选项、右说明，可鼠标点击，Esc 返回）：未配置时只有「添加文档」（名称和路径不填默认值，接着问项目地址，跳过则全局共享）；已添加则点某个文档再删除 / AI整理（开始、增量、停止）/ 归属。添加后做规则清洗和后台索引，不自动开 AI。无 UI：`/kb refresh` 刷新规则资料并完整校验索引，`/kb enrich <root>` 启动/继续语义整理，`/kb pause <root>` 暂停，`/kb project <id|auto|shared>` 选择当前项目，`/kb scope <current|all|项目ID列表>` 调整临时检索范围。

生成资料写在每个来源目录下的 `.pi-kb/`：

- `manifest.json` + `index/`：分片倒排索引，查询只读已发布世代
- `notes/*.md`：AI 整理后的派生笔记（可读，不回写原文）
- `snapshot.json` / `sem.json` / `job.json`：规则快照、语义记录与任务检查点（兼容旧版）

扫描会跳过 `.pi-kb/`，不改原文。索引在会话后台增量更新，查询前不整库重算哈希；刚新增的文件在扫描完成前可能尚未召回，状态行会显示索引世代。生成资料不能当作完整阅读证据，`readRef` 仍只来自原文的完整 `read`。

完整读过配置范围内的原文后，阅读结果会附带 `readRef`。讨论、规划、只读任务不要保存。

## 项目隔离

旧配置没有 `version` 字段时隔离关闭，行为与以前相同。给文档添加归属时写入 `version: 2`，并备份为 `pi-kb.json.bak`。

- 用工作目录识别当前项目，用资料目录（或单文件）绑定归属。
- 默认只检索当前项目和明确标记为共享的资料；未分类资料不参与检索。
- 零命中不会自动搜全部项目。需要时用 `/kb scope all` 或指定项目 ID。
- 这不是文件权限隔离：`read` / `bash` 仍可能碰到其他目录。

## 范围

检索 UTF-8 的 `.md` `.mdx` `.txt` `.html` `.htm` `.json` `.yaml` `.yml`。不处理 PDF/Office、图片 OCR、向量检索。截图里的内容搜不到。资料整理只覆盖已读文字，来源哈希相同只说明原文没改，不证明整理正确。

## 测试

逻辑测试不依赖 `node_modules`。Pi 加载插件时会注入 `pi-coding-agent` / `typebox`，使用时不必 `npm install`。

```bash
npm test
node scripts/bench-kb.mjs
```

Windows 实机（中文路径、目录联接、Pi 安装版）本轮未在本环境验证。
