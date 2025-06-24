# fc-deploy

阿里云函数计算自动部署

### 安装

```bash
npm i fc-deploy
```

### 使用

```ts
import { deploy } from "fc-deploy";
/** 一组函数名称 */
const funcs = [
  "chat",
  "msgfile",
  "msgfile_large",
  "recog",
  "group",
  "wemeeting",
] as const;

deploy({
  /** 项目名称 */
  name: "wecom-chat",
  /** FC客户端设置 */
  fcConfigs: funcs.map((f) => ({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY!,
    accessKeySecret: process.env.ALIYUN_SECRET_ACCESS_KEY!,
    fcEndpoint: "xxxxxxxx.cn-beijing.fc.aliyuncs.com",
    fcRegionId: "cn-beijing",
    fcFunction: f,
    fcService: "服务名称",
  })),
  /** 层设置 */
  layerConfig: {
    layerName: "wecom-chat",
    /** 层描述 */
    layerDescription: "",
    /** 层兼容哪些运行时 */
    compatibleRuntime: ["nodejs20"],
    /** 定义如何获取各个函数的依赖hash */
    getHash: async (params) => {
      const redis = getUpstashRedis("dk");
      const data = await redis.get<string>(`fcd:hash:${params.funcName}`);
      return data || "";
    },
    /** 定义如何设置hash */
    setHash: async (params) => {
      const redis = getUpstashRedis("dk");
      const res = await redis.set(`fcd:hash:${params.funcName}`, params.hash);
      if (res !== "OK") {
        console.error("upstash redis cache error: " + res);
      }
    },
    /** 需要监控哪些依赖变化，可以同时监控多个依赖，任意一个变化了，都会重新创建层 */
    packageJsonLists: [
      path.resolve(process.cwd(), "package.json"),
      path.resolve(
        process.cwd(),
        "node_modules/@myrog/mylib/package.json",
      ),
    ],
  },
  /** oss配置，用来上传层文件。 */
  ossConfig: {
    accessKeyId: process.env.ALIYUN_ACCESS_KEY!,
    accessKeySecret: process.env.ALIYUN_SECRET_ACCESS_KEY!,
    bucket: "pte-assets",
    region: "oss-cn-beijing",
  },
  /** 日志回调 */
  cbLog(msg) {
    console.log(msg);
    const fsClient = getFeishuClient();
    return fsClient.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        msg_type: "text",
        receive_id: process.env.FEISHU_CHAT_ID!,
        content: JSON.stringify({
          text: msg,
        }),
      },
    });
  },
});
```
