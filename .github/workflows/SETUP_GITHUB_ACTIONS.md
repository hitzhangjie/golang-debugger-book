# GitHub Actions 设置指南

## 快速开始

### 1. 选择工作流文件

根据你的需求选择合适的工作流文件：

**选项A：基础部署（推荐）**
```bash
# 使用基础版本，只部署到目标仓库
cp .github/workflows/deploy.yml .github/workflows/
```

**选项B：增强部署**
```bash
# 使用增强版本，包含GitHub Pages
cp .github/workflows/deploy-with-pages.yml .github/workflows/deploy.yml
```

### 2. 提交并推送

```bash
git add .github/workflows/
git commit -m "Add GitHub Actions for auto deployment"
git push origin main
```

### 3. 验证配置

1. 进入GitHub仓库页面
2. 点击 "Actions" 标签
3. 你应该能看到 "Auto Deploy GitBook" 工作流
4. 点击工作流查看详情

## 配置说明

### 触发条件
- **自动触发**：每次push到 `main` 或 `master` 分支
- **手动触发**：通过GitHub界面手动运行

### 目标仓库
工作流会将构建结果推送到：`https://github.com/hitzhangjie/debugger101.io`

### Docker镜像
使用你的自定义Docker镜像：`hitzhangjie/gitbook-cli:latest`

## 测试部署

### 方法1：推送测试
```bash
# 修改任意文件
echo "# Test" >> README.md
git add README.md
git commit -m "Test GitHub Actions deployment"
git push origin main
```

### 方法2：手动触发
1. 进入GitHub仓库的Actions页面
2. 选择 "Auto Deploy GitBook" 工作流
3. 点击 "Run workflow"
4. 选择分支并运行

## 监控部署

### 查看日志
1. 进入Actions页面
2. 点击最新的工作流运行
3. 查看每个步骤的详细日志

### 成功标志
- ✅ 所有步骤显示绿色
- 📤 目标仓库收到新的提交
- 🌐 GitHub Pages更新（如果使用增强版本）

## 故障排除

### 常见问题

**1. 权限错误**
```
Error: fatal: Authentication failed
```
**解决方案**：确保目标仓库存在且有推送权限

**2. Docker镜像错误**
```
Error: Unable to find image 'hitzhangjie/gitbook-cli:latest'
```
**解决方案**：确保Docker镜像已发布到Docker Hub

**3. GitBook构建失败**
```
Error: gitbook: command not found
```
**解决方案**：检查 `book/` 目录结构和 `book.json` 配置

### 获取帮助

如果遇到问题：
1. 查看GitHub Actions的详细日志
2. 检查目标仓库的权限设置
3. 验证Docker镜像是否可用
4. 确认GitBook配置正确

## 高级配置

### 自定义触发条件
编辑 `.github/workflows/deploy.yml` 中的 `on` 部分：

```yaml
on:
  push:
    branches: [ main, master ]
    paths: [ 'book/**', '*.md' ]  # 只监听特定文件变化
  workflow_dispatch:
```

### 环境变量
如果需要使用私有仓库或自定义配置，可以添加环境变量：

```yaml
env:
  TARGET_REPO: https://github.com/hitzhangjie/debugger101.io
  DOCKER_IMAGE: hitzhangjie/gitbook-cli:latest
```

### 缓存优化
为了加快构建速度，可以添加缓存：

```yaml
- name: Cache node modules
  uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
``` 