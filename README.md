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

Windows：路径比较忽略大小写和斜杠方向；目录联接按符号链接跳过，不跟随。写入先尝试硬链接，失败则用 `COPYFILE_EXCL` 独占拷贝，不会覆盖已有笔记。

临时调试：`pi -e ./extensions/index.ts`

## 使用

- `kb_search({ query, root?, limit? })`：短关键词。省略 `root` 时先搜 AI 笔记，没有可用结果再搜原文。指定只读 root 可强制搜原文。
- `kb_write({ title, body, readRef? })`：有 `readRef` 时保存该原文版本的资料整理；没有则保存问题经验。只新建文件，不改原笔记。
- `/kb`：看来源。有终端 UI 时可添加、删除目录，并指定记录目录；结果写入 `pi-kb.json`。无 UI 时只刷新状态。

完整读过配置范围内的原文后，阅读结果会附带 `readRef`。讨论、规划、只读任务不要保存。

## 范围

检索 UTF-8 的 `.md` `.mdx` `.txt` `.html` `.htm` `.json` `.yaml` `.yml`。不处理 PDF/Office、图片 OCR、向量检索。截图里的内容搜不到。资料整理只覆盖已读文字，来源哈希相同只说明原文没改，不证明整理正确。

## 测试

逻辑测试不依赖 `node_modules`。Pi 加载插件时会注入 `pi-coding-agent` / `typebox`，使用时不必 `npm install`。

```bash
npm test
```
