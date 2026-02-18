## [1.2.11] - 2026-02-18

### Fixed
- 修复 `getPackageDepsHash` 对非 JSON 文件（如 `schema.prisma`）直接 `JSON.parse` 导致报错的问题；现在对无法解析为 JSON 对象的文件，退回到原始文本内容 hash

## [1.2.10] - 2026-02-18

## Fixed

- 修复依赖变化检测逻辑：不再将宿主项目的 `version` 字段混入 hash，仅提取 `dependencies`、`peerDependencies`、`optionalDependencies` 参与计算，避免单纯改版本号触发不必要的 layer 重建
- 对 `packageJsonLists` 中每个文件，不再 hash 整个原始文件内容，改为只序列化依赖字段（key 排序），消除格式变动的干扰
