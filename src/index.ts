import path from 'path'
import { zip } from 'zip-a-folder'
import fs from 'fs'
import crypto from 'crypto'
import FcClient, { UpdateFunctionRequest, Code, GetFunctionRequest, CreateLayerVersionRequest } from '@alicloud/fc-open20210406'
import { Config as AliConfig } from '@alicloud/openapi-client'
import dayjs from 'dayjs'
import AliOSS from 'ali-oss'
import retry from 'async-retry'


interface IFcConfig {
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

interface IOssConfig {
  accessKeyId: string,
  accessKeySecret: string,
  /** OSS存储通的。用来存储层文件 */
  bucket: string,
  /** OSS存储桶的地区 */
  region: string,
  /** 可选，上传到OSS的子目录。例如：“ abc/def ” */
  subDir?: string,
}

interface ILayerConfig {
  /** 阿里云配置 */
  fcConfig: IFcConfig,
  ossConfig: IOssConfig,
  /** 传入项目依赖的package.json。可以传入多个，比如把依赖到的一些库的package.json也加进来。当这些package.json变化的时候，就会重新生成层 */
  packageJsonLists?: string[],
  /** 获取上一次层信息的hash */
  getHash: () => Promise<string>,
  /** 设置新的层hash */
  setHash: (hash: string) => Promise<void>,
  /** 层名称 */
  layerName?: string
  /** 层描述 */
  layerDescription?: string
  /** 例如：['custom.debian10', 'nodejs20'] */
  compatibleRuntime: string[]
}

const FC_CLIENTS: { [key: string]: FcClient | undefined } = {}

function getFcClient(params: {
  accessKeyId: string,
  accessKeySecret: string,
  endpoint: string,
  regionId: string
}) {
  if (!FC_CLIENTS[params.accessKeyId]) {
    FC_CLIENTS[params.accessKeyId] = new FcClient(new AliConfig({
      // 必填，您的 AccessKey ID
      accessKeyId: params.accessKeyId,
      // 必填，您的 AccessKey Secret
      accessKeySecret: params.accessKeySecret,
      // 必填，函数计算服务的endpoint
      endpoint: params.endpoint,
      // 必填，函数计算服务的regionId
      regionId: params.regionId
    }))
  }
  return FC_CLIENTS[params.accessKeyId]
}

// https://medium.com/@chris_72272/what-is-the-fastest-node-js-hashing-algorithm-c15c1a0e164e
function md5(content: string) {
  return crypto.createHash('md5').update(content).digest('hex')
}

/**
 * 传入多个package.json的地址，会将全部的dependencies键里的依赖做排序，然后做hash，以便判断项目依赖是否发生了变化
 */
function getPackageDepsHash(paths: string[]) {
  const _pathAll = paths
    .map(v => v)
    .sort()
    .map(p => require(p) as { dependencies?: { [key: string]: string } })
    .map(p => p.dependencies || {})
    .map(deps => {
      const packageNames = Object.keys(deps).sort()
      return packageNames.map(pn => `${pn}:${deps[pn]}`).join('\n')
    })
    .join('\n')
  return md5(_pathAll)
}

/**
 * 将当前代码目录里的文件，打包压缩成zip文件，并返回其base64编码。
 */
async function compressCodeToBase64(params?: {
  distPath?: string
}): Promise<string> {
  const distPath = params?.distPath || path.resolve(process.cwd(), 'dist')
  if (!fs.existsSync(distPath)) {
    throw new Error(`指定的dist目录不存在: ${distPath}`)
  }
  if (process.env.DEBUG_FCD) {
    console.log('Compressing: ', distPath)
  }
  const targetPath = path.resolve(process.cwd(), 'code.zip')
  if (process.env.DEBUG_FCD) {
    console.log('Target: ', targetPath)
  }
  if (process.env.DEBUG_FCD) {
    console.log('Start compressing code files...')
  }
  await zip(distPath, targetPath)
  if (process.env.DEBUG_FCD) {
    console.log('Compression successful!')
  }
  const fileContent = await fs.promises.readFile(targetPath, { encoding: 'base64' })
  return fileContent
}


/**
 * 判断本地依赖是否有改变，如果有的话，将本地依赖文件夹整体打包成新的层，并更新已有的层。
 * @returns 如果没有改变则返回undefined，有改变则返回需要设置的层名称列表
 */
async function setupLayers(params: {
  fcConfig: IFcConfig
  ossConfig: IOssConfig
  layerConfig: ILayerConfig
}): Promise<string[] | undefined> {
  // 生成当前依赖的hash
  const curHash = getPackageDepsHash(params.layerConfig.packageJsonLists || [
    path.resolve(process.cwd(), 'package.json'),
  ])
  if (process.env.DEBUG_FCD) {
    console.log('本次PackageHash:', curHash)
  }
  if (!params.layerConfig.getHash || !params.layerConfig.setHash) {
    throw new Error('必须传入getHash和setHash方法')
  }
  if (process.env.DEBUG_FCD) {
    console.log('获取上一次PackageHash...')
  }
  const prevHash = await params.layerConfig.getHash()
  if (process.env.DEBUG_FCD) {
    console.log('上一次PackageHash为:', prevHash)
  }
  if (curHash === prevHash) {
    if (process.env.DEBUG_FCD) {
      console.log('依赖没有变化，不需要更新层')
    }
    return undefined
  } else {
    if (process.env.DEBUG_FCD) {
      console.log('依赖发生变化，需要更新层')
    }
  }
  // 如果依赖发生变化，则创建新的层
  // 先获取现有的层列表
  const fcClient = getFcClient({
    accessKeyId: params.fcConfig.accessKeyId,
    accessKeySecret: params.fcConfig.accessKeySecret,
    endpoint: params.fcConfig.fcEndpoint,
    regionId: params.fcConfig.fcRegionId,
  })
  if (!fcClient) {
    throw new Error('无法获取FC客户端，请检查阿里云配置是否正确')
  }
  const fcInfo = await fcClient.getFunction(
    params.fcConfig.fcService,
    params.fcConfig.fcFunction,
    new GetFunctionRequest()
  )
  const layers = fcInfo.body.layers || []
  if (process.env.DEBUG_FCD) {
    console.log('现有层信息:', layers)
  }
  // 压缩打包现有node_modules文件夹
  const nodeModulesPath = path.resolve(process.cwd(), 'node_modules')
  if (!fs.existsSync(nodeModulesPath)) {
    throw new Error(`node_modules目录不存在: ${nodeModulesPath}`)
  }
  if (process.env.DEBUG_FCD) {
    console.log('Compressing node_modules: ', nodeModulesPath)
  }
  const depFileName = `node_modules@${dayjs().format('YYYYMMDD-HHmmss')}.zip`
  const targetPath = path.resolve(process.cwd(), depFileName)
  if (process.env.DEBUG_FCD) {
    console.log('Target: ', targetPath)
    console.log('开始压缩./node_modules目录...')
  }
  await zip(nodeModulesPath, targetPath, {
    destPath: 'nodejs/node_modules',
  })
  if (process.env.DEBUG_FCD) {
    console.log('压缩成功，即将上传到OSS')
  }
  const ossClient = new AliOSS({
    accessKeyId: params.fcConfig.accessKeyId,
    accessKeySecret: params.fcConfig.accessKeySecret,
    bucket: params.ossConfig.bucket,
    region: params.ossConfig.region,
  })
  const ossRes = await ossClient.put(
    params.ossConfig.subDir ? `/${params.ossConfig.subDir}/${depFileName}` : `/${depFileName}`,
    targetPath,
    {
      // 5分钟上传超时
      timeout: 5 * 60 * 1000
    }
  )
  if (process.env.DEBUG_FCD) {
    console.log('上传成功:', ossRes.url)
    console.log('即将创建新的FC层...')
  }
  // 创建新的依赖层
  const fcwecomLayer = await retry(() => fcClient.createLayerVersion(
    params.layerConfig.layerName || `fcd-layer`,
    new CreateLayerVersionRequest({
      description: (params.layerConfig.layerDescription || 'fcd自定义依赖打包 ') + depFileName,
      compatibleRuntime: params.layerConfig.compatibleRuntime,
      code: new Code({
        ossBucketName: params.ossConfig.bucket,
        ossObjectName: `${params.ossConfig.subDir}/${depFileName}`
      })
    })), {
    retries: 3,
    onRetry(e: Error, i: number) {
      console.error(`retry ${i}`, e.message)
    }
  })
  const layerName = fcwecomLayer.body.layerName || ''
  const layerArn = fcwecomLayer.body.arn || ''
  if (!layerName) {
    throw new Error('无效的layerName！')
  }
  if (!layerArn) {
    throw new Error('无效的layerArn')
  }
  if (process.env.DEBUG_FCD) {
    console.log('层创建成功：', layerName, layerArn)
    console.log('层大小：', fcwecomLayer.body.codesize)
  }
  // 更新PackageHash
  const hashSave = await params.layerConfig.setHash(curHash).then(() => {
    if (process.env.DEBUG_FCD) {
      console.log('更新PackageHash成功:', hashSave)
    }
  }).catch(err => {
    console.error('更新PackageHash失败:', err)
  })
  // 找到现有层里，之前的层的位置
  let layerIndex = layers.findIndex(a => a.includes(layerName))
  // 如果能找到，则更新
  if (layerIndex !== -1) {
    layers[layerIndex] = layerArn
  } else {
    // 找不到的话，则放第一个
    layers.unshift(layerArn)
  }
  return layers
}

export async function deploy(params: {
  /** 项目名称 */
  name: string
  /** 需要压缩的代码目录。比如一般构建结果都是在dist目录，如果不传入这个参数，默认是cwd里的dist目录 */
  distPath?: string
  fcConfig: IFcConfig
  ossConfig: IOssConfig
  layerConfig: ILayerConfig
}) {
  // 将源码压缩成base64
  const codeBase64 = await compressCodeToBase64({
    distPath: params.distPath
  })
  // 检测层是否需要更新
  const layers = await setupLayers({
    fcConfig: params.layerConfig.fcConfig,
    ossConfig: params.layerConfig.ossConfig,
    layerConfig: params.layerConfig
  })
  const updateFunctionReq = new UpdateFunctionRequest({
    code: new Code({
      zipFile: codeBase64
    }),
  })
  if (layers) {
    updateFunctionReq.layers = layers
  }
  const fcClient = getFcClient({
    accessKeyId: params.fcConfig.accessKeyId,
    accessKeySecret: params.fcConfig.accessKeySecret,
    endpoint: params.fcConfig.fcEndpoint,
    regionId: params.fcConfig.fcRegionId,
  })
  if (!fcClient) {
    throw new Error('无法获取FC客户端，请检查阿里云配置是否正确')
  }
  const deployResult = await fcClient.updateFunction(
    params.fcConfig.fcService,
    params.fcConfig.fcFunction,
    updateFunctionReq
  )
  if (process.env.DEBUG_FCD) {
    const msgs = [
      `### ${params.name} 部署成功!  `,
      `statusCode: ${deployResult.statusCode}  `,
      `codeSize: ${deployResult.body?.codeSize ? (deployResult.body.codeSize / 1000 + 'KB') : 'n/a'}  `,
      `cpu: ${deployResult.body?.cpu || 'n/a'}  `,
      `memory: ${deployResult.body?.memorySize || 'n/a'} MB  `
    ]
    console.log('部署结果:')
    console.log(msgs.join('\n'))
  }
  return deployResult
}