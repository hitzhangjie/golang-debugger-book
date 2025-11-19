# gg_catalogue

`/gg_catalogue` 是一个命令，用于更新目录操作（包括目录中的引用的文件路径以及显示的章节名称），需要执行以下步骤：

1. 确定当前有变更的文件列表（比如通过git status）
2. 如果是新增文件，记得在目录文件SUMMARY.md中添加对应的章节
3. 如果是删除文件，记得在目录文件SUMMARY.md中删除对应的章节
4. 如果是重命名文件，需要先确定旧文件的名称及SUMMARY.md中的章节名称，然后更新为新的文件名称及章节名称

## 注意事项

- 确保在更新目录前已经保存了所有文件变更
- 检查SUMMARY.md的格式是否正确
- 保持章节顺序的逻辑性和连贯性

This command will be available in chat with `/gg_catalogue`
