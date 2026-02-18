# Agents Guide -- fc-deploy

本文件用于指导智能体（AI Agent）在此项目中正确执行各类任务。

--------------------------------------------------------------------------------

## 项目概览

- **功能**：将代码部署到阿里云函数计算（FC），核心能力是智能依赖 Layer 管理，只在实际依赖发生变化时才重建并发布 Layer。
- **语言**：TypeScript
- **包管理器**：`pnpm`（版本锁定于 `package.json` 的 `packageManager` 字段）
- **入口文件**：`src/index.ts` → 编译输出至 `dist/`
- **主要脚本**： | 命令 | 说明 | |---|---| | `pnpm build` | 执行 `tsc -p .`，编译 TypeScript | | `pnpm dev` | 以 watch 模式编译，用于开发 |

--------------------------------------------------------------------------------

## 开发规范

- 安装依赖使用 `pnpm`，**不要使用 npm install 或 yarn**。
- 修改代码后执行 `npx tsc --noEmit` 确认无编译错误再提交。
- 项目无测试框架，修改后需人工验证核心逻辑。

--------------------------------------------------------------------------------

## 发布流程

> 当用户说「执行发布流程」时，严格按以下步骤操作。

### Step 1 -- 提交所有未提交的修改

```bash
git add -A
git commit -m "<描述本次改动的提交信息>"
```

如果工作区干净（无未提交变更），跳过此步。

### Step 2 -- 维护 ChangeLog

在 `CHANGELOG.md`（若不存在则创建）中，在文件顶部新增一条记录，格式如下：

```markdown
## [x.y.z] - YYYY-MM-DD

### Added / Changed / Fixed / Breaking
- 具体变更描述
```

> **ChangeLog 是必须维护的**，每次发布前都要更新，不得跳过。 版本号此时填写预期的新版本号（见 Step 3）。 维护完 ChangeLog 后提交：`git add CHANGELOG.md && git commit -m "chore: update changelog"`

### Step 3 -- 更新版本号（Bump）

- **必须使用 `npm version` 命令**，不要手动编辑 `package.json`。
- 如果不清楚本次属于哪种变更类型，**先询问用户**，再操作。

```bash
# patch：修复 bug、小改动
npm version patch

# minor：新增功能、向后兼容
npm version minor

# major：破坏性变更
npm version major
```

版本号更新后，将 `package.json` 的版本号变更提交：

```bash
git add package.json
git commit -m "chore: bump version to x.y.z"
```

### Step 4 -- 构建

```bash
pnpm build
```

确认编译无报错后继续。

### Step 5 -- 发布

```bash
npm publish
```

--------------------------------------------------------------------------------

## 发布流程速查（摘要）

```
1\. git add -A && git commit
2\. 更新 CHANGELOG.md → git commit
3\. npm version [patch|minor|major] → git commit
4\. pnpm build
5\. npm publish
```
