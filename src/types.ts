export interface IFcConfig {
  accessKeyId: string,
  accessKeySecret: string,
  /** 函数计算服务的endpoint。例如：1152487483572383.cn-beijing.fc.aliyuncs.com */
  fcEndpoint: string,
  /** 函数计算服务的regionId。例如：cn-beijing */
  fcRegionId: string
  /** 函数服务名称 */
  fcService: string,
  /** 函数名称 */
  fcFunction: string,
}

export interface IOssConfig {
  accessKeyId: string,
  accessKeySecret: string,
  /** OSS存储通的。用来存储层文件 */
  bucket: string,
  /** OSS存储桶的地区 */
  region: string,
}

export interface ILayerConfig {
  /** 传入项目依赖的package.json。可以传入多个，比如把依赖到的一些库的package.json也加进来。当这些package.json变化的时候，就会重新生成层 */
  packageJsonLists?: string[],
  /** 获取上一次层信息的hash */
  getHash: (params: {
    /** 函数名称 */
    funcName: string
  }) => Promise<string>,
  /** 设置新的层hash */
  setHash: (params: {
    /** 函数名称 */
    funcName: string,
    /** 新的hash值 */
    hash: string
  }) => Promise<void>,
  /** 层名称 */
  layerName: string
  /** 层描述 */
  layerDescription?: string
  /** 例如：['custom.debian10', 'nodejs20'] */
  compatibleRuntime: string[]
}