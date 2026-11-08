# Multi-Agent 项目交付验收样例

在此目录使用 Node.js 24 运行以下命令，分别验证运行结果、类型和编译产物。

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

金额转换逻辑、测试和依赖都限于本目录。GitHub Actions 对修改此样例的推送与合并请求运行相同检查。
