import path from 'path'
import { zip } from 'zip-a-folder'
import fs from 'fs'
import { Code, GetFunctionRequest, CreateLayerVersionRequest } from '@alicloud/fc-open20210406'
import AliOSS from 'ali-oss'
import retry from 'async-retry'
import { IFcConfig, ILayerConfig, IOssConfig } from './types'
import { getFcClient, getOssClient, getPackageDepsHash, isObjectExist } from './utils'






/**
 * 读取现有的层文件，如果不存在则上传新的层文件。
 */
async function getOrUploadLayer(params: {
  ossClient: AliOSS
  layerName: string
  curHash: string
}): Promise<{
  /** 层文件名称 */
  depFileName: string,
  /** OSS文件中的对象路径 */
  objectName: string
}> {
  // 压缩打包现有node_modules文件夹
  const nodeModulesPath = path.resolve(process.cwd(), 'node_modules')
  if (!fs.existsSync(nodeModulesPath)) {
    throw new Error(`node_modules目录不存在: ${nodeModulesPath}`)
  }
  if (process.env.DEBUG_FCD) {
    console.log('Compressing node_modules: ', nodeModulesPath)
  }
  const depFileName = `node_modules@${params.curHash}.zip`
  const objectName = `/fc-deploy/${params.layerName}/${depFileName}`
  const isLayerOssFileExist = await isObjectExist({
    client: params.ossClient,
    objectName
  })
  if (isLayerOssFileExist) {
    if (process.env.DEBUG_FCD) {
      console.log('依赖层文件已存在:', objectName)
    }
    return {
      depFileName,
      objectName
    }
  }
  // 如果不存在，则压缩打包
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
  const ossRes = await params.ossClient.put(
    `/fc-deploy/${params.layerName}/${depFileName}`,
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
  return {
    depFileName,
    objectName
  }
}

/** 负责更新一个函数的层信息，并返回这个函数的层数组，以便用到下游的函数更新中 */
async function updateLayers(params: {
  fcConfig: IFcConfig
  layerConfig: ILayerConfig
  ossConfig: IOssConfig
  layerObject: {
    depFileName: string
    objectName: string
  }
}): Promise<string[]> {
  // 先获取现有的层列表
  const fcClient = getFcClient(params.fcConfig)
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
  // 创建新的依赖层
  const fcLayer = await retry(() => fcClient.createLayerVersion(
    params.layerConfig.layerName,
    new CreateLayerVersionRequest({
      description: (params.layerConfig.layerDescription || 'fcd自定义依赖打包 ') + params.layerObject.depFileName,
      compatibleRuntime: params.layerConfig.compatibleRuntime,
      code: new Code({
        ossBucketName: params.ossConfig.bucket,
        ossObjectName: params.layerObject.objectName,
      })
    })), {
    retries: 3,
    onRetry(e: Error, i: number) {
      console.error(`error@layer create - retry ${i}`, e.message)
    }
  })
  const layerName = fcLayer.body.layerName || ''
  const layerArn = fcLayer.body.arn || ''
  if (!layerName) {
    throw new Error('无效的layerName！')
  }
  if (!layerArn) {
    throw new Error('无效的layerArn')
  }
  if (process.env.DEBUG_FCD) {
    console.log('层创建成功：', layerName, layerArn)
    console.log('层大小：', fcLayer.body.codesize)
  }
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


/**
 * 判断本地依赖是否有改变，如果有的话，将本地依赖文件夹整体打包成新的层，并更新已有的层。
 * @returns 如果没有改变则返回undefined，有改变则返回需要设置的层名称列表
 */
export async function setupLayers(params: {
  /** 全部需要更新的函数的配置 */
  fcConfigs: IFcConfig[]
  ossConfig: IOssConfig
  layerConfig: ILayerConfig
}): Promise<{ hash: string, layers: Array<string[] | undefined> | undefined }> {
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
  const prevHashs = await Promise.all(params.fcConfigs.map(fcConfig => params.layerConfig.getHash({
    funcName: `${fcConfig.fcService}-${fcConfig.fcFunction}`
  })))
  if (process.env.DEBUG_FCD) {
    console.log('上一次PackageHash为:', prevHashs)
  }
  if (prevHashs.every(hash => hash === curHash)) {
    if (process.env.DEBUG_FCD) {
      console.log('全部函数依赖没有变化，不需要更新层')
    }
    return {
      hash: curHash,
      layers: undefined // 没有变化则返回undefined
    }
  } else {
    if (process.env.DEBUG_FCD) {
      console.log('依赖发生变化，需要更新层')
    }
  }
  // 如果依赖发生变化，则创建新的层
  const layerObject = await getOrUploadLayer({
    curHash,
    layerName: params.layerConfig.layerName,
    ossClient: getOssClient(params.ossConfig),
  })

  if (process.env.DEBUG_FCD) {
    console.log('依赖层文件信息:', layerObject)
  }
  const resLayers: Array<string[] | undefined> = []
  // 顺序更新一个函数
  for (let i = 0; i < params.fcConfigs.length; i++) {
    if (prevHashs[i] === curHash) {
      if (process.env.DEBUG_FCD) {
        console.log(`函数 ${params.fcConfigs[i].fcFunction} hash没有变化，跳过更新`)
      }
      resLayers.push(undefined) // 没有变化则返回空
      continue
    }
    if (process.env.DEBUG_FCD) {
      console.log(`开始更新函数 ${params.fcConfigs[i].fcFunction} 的层信息...`)
    }
    const layers = await updateLayers({
      fcConfig: params.fcConfigs[i],
      layerConfig: params.layerConfig,
      ossConfig: params.ossConfig,
      layerObject
    })
    if (process.env.DEBUG_FCD) {
      console.log(`函数 ${params.fcConfigs[i].fcFunction} 的层信息更新成功:`, layers)
    }
    resLayers.push(layers)
  }
  // 返回所有函数的层信息
  return {
    hash: curHash,
    layers: resLayers
  }

}