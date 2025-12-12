import path from 'path'
import { zip } from 'zip-a-folder'
import fs from 'fs'
import { Code, GetFunctionRequest, CreateLayerVersionRequest, ListLayerVersionsRequest, Layer } from '@alicloud/fc-open20210406'
import AliOSS from 'ali-oss'
import retry from 'async-retry'
import { IFcConfig, ILayerConfig, IOssConfig } from './types'
import { getFcClient, getOssClient, getPackageDepsHash, isObjectExist, removePrecedingSlash } from './utils'

/**
 * 读取现有的层文件，如果不存在则上传新的层文件。并创建新的层。
 */
async function getOrUploadLayer(params: {
  ossClient: AliOSS
  layerName: string
  curHash: string
  nodeModulesPath?: string
}): Promise<{
  /** 层文件名称 */
  depFileName: string,
  /** OSS文件中的对象路径 */
  objectName: string,
}> {
  // 压缩打包现有node_modules文件夹
  const nodeModulesPath = params.nodeModulesPath
    ? (path.isAbsolute(params.nodeModulesPath) ? params.nodeModulesPath : path.resolve(process.cwd(), params.nodeModulesPath))
    : path.resolve(process.cwd(), 'node_modules')
  if (!fs.existsSync(nodeModulesPath)) {
    throw new Error(`node_modules目录不存在: ${nodeModulesPath}`)
  }
  if (process.env.DEBUG_FCD) {
    console.log('[Layer] 📦 Preparing to compress node_modules from:', nodeModulesPath)
  }
  const depFileName = `node_modules@${params.curHash}.zip`
  const objectName = `/fc-deploy/${params.layerName}/${depFileName}`
  const isLayerOssFileExist = await isObjectExist({
    client: params.ossClient,
    objectName
  })
  if (isLayerOssFileExist) {
    if (process.env.DEBUG_FCD) {
      console.log('[Layer] ✓ Layer file already exists in OSS:', objectName)
    }
    return {
      depFileName,
      objectName
    }
  } else {
    if (process.env.DEBUG_FCD) {
      console.log('[Layer] ⚠️  Layer file not found in OSS, will create new package:', objectName)
    }
  }
  // 如果不存在，则压缩打包
  const targetPath = path.resolve(process.cwd(), depFileName)
  if (process.env.DEBUG_FCD) {
    console.log('[Layer] 📦 Target zip file:', targetPath)
    console.log('[Layer] 🔄 Compressing node_modules directory...')
  }
  await zip(nodeModulesPath, targetPath, {
    destPath: 'nodejs/node_modules',
  })
  if (process.env.DEBUG_FCD) {
    console.log('[Layer] ✓ Compression complete, uploading to OSS...')
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
    console.log('[Layer] ✓ Upload successful:', ossRes.url)
    console.log('[Layer] 🔄 Layer object ready for FC layer creation')
  }
  return {
    depFileName,
    objectName
  }
}

/**
 * 获取或创建一个新的FC层。
 */
async function getOrCreateLayer(params: {
  curHash: string
  layerConfig: ILayerConfig
  ossConfig: IOssConfig
  fcClient: ReturnType<typeof getFcClient>
  /** 之前创建的层的oss对象 */
  layerObject: {
    depFileName: string
    objectName: string
  }
}): Promise<Layer | undefined> {
  const fcClient = params.fcClient
  if (!fcClient) {
    throw new Error('无法获取FC客户端，请检查阿里云配置是否正确')
  }
  // 先拿到现有的层列表，如果没有则创建一个新的层
  const existingLayers = await fcClient.listLayerVersions(
    params.layerConfig.layerName,
    new ListLayerVersionsRequest({
      // 只获取最新的10个版本
      maxItems: 10
    })
  ).catch(err => {
    // 如果层本身不存在则报错
    if (err?.message?.includes('LayerNotFound')) {
      return undefined
    } else {
      throw err
    }
  })
  if (process.env.DEBUG_FCD) {
    console.log('[Layer] 📋 Existing layer versions:', existingLayers?.body.layers?.length || 0, 'found')
    if (existingLayers?.body.layers?.length) {
      existingLayers.body.layers.forEach(l => console.log('       -', l.layerName, l.version))
    }
  }
  const prevLayer = existingLayers?.body?.layers?.find(l => l.description?.includes(params.curHash))
  if (prevLayer) {
    if (process.env.DEBUG_FCD) {
      console.log('[Layer] ✓ Found existing layer with matching hash:', prevLayer.layerName, `(v${prevLayer.version})`)
    }
    // 如果找到了之前的层，则直接返回
    return prevLayer
  }
  // 创建新的依赖层
  const fcLayer = await retry(() => fcClient.createLayerVersion(
    params.layerConfig.layerName,
    new CreateLayerVersionRequest({
      description: [
        params.layerConfig.layerDescription || 'fcd自定义依赖打包 ',
        /** depFileName 是依赖的名称，其中包含hash，例如：node_modules@${curHash}.zip */
        params.layerObject.depFileName
      ].join('/'),
      compatibleRuntime: params.layerConfig.compatibleRuntime,
      code: new Code({
        ossBucketName: params.ossConfig.bucket,
        ossObjectName: removePrecedingSlash(params.layerObject.objectName)
      })
    })), {
    retries: 3,
    onRetry(e: Error, i: number) {
      console.error(`error@layer create - retry ${i}`, e.message)
    }
  })
  return fcLayer?.body || undefined
}

/** 负责更新一个函数的层信息，并返回这个函数的层数组，以便用到下游的函数更新中 */
async function updateLayers(params: {
  curHash: string
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
    console.log('[Function] 📋 Current layers:', layers.length > 0 ? layers : 'none')
  }
  const fcLayer = await getOrCreateLayer({
    curHash: params.curHash,
    layerConfig: params.layerConfig,
    ossConfig: params.ossConfig,
    fcClient,
    layerObject: params.layerObject
  })
  if (!fcLayer) {
    throw new Error('无法获取或创建新的FC层，请检查配置是否正确')
  }
  const layerName = fcLayer.layerName || ''
  const layerArn = fcLayer.arn || ''
  if (!layerName) {
    throw new Error('无效的layerName！')
  }
  if (!layerArn) {
    throw new Error('无效的layerArn')
  }
  if (process.env.DEBUG_FCD) {
    console.log('[Layer] ✓ Layer ready:', layerName, `(v${fcLayer.version})`)
    console.log('[Layer] 📊 Layer size:', ((fcLayer.codeSize || 0) / 1024 / 1024).toFixed(2), 'MB')
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
  /** 自定义 node_modules 路径，默认为 cwd/node_modules */
  nodeModulesPath?: string
}): Promise<{ hash: string, layers: Array<string[] | undefined> | undefined }> {
  // 生成当前依赖的hash
  const curHash = await getPackageDepsHash(params.layerConfig.packageJsonLists || [
    path.resolve(process.cwd(), 'package.json'),
  ])
  if (process.env.DEBUG_FCD) {
    console.log('[Hash] 🔐 Current package hash:', curHash)
  }
  if (!params.layerConfig.getHash || !params.layerConfig.setHash) {
    throw new Error('必须传入getHash和setHash方法')
  }
  if (process.env.DEBUG_FCD) {
    console.log('[Hash] 🔍 Fetching previous package hashes...')
  }
  const prevHashs = await Promise.all(params.fcConfigs.map(fcConfig => params.layerConfig.getHash({
    funcName: `${fcConfig.fcService}-${fcConfig.fcFunction}`
  })))
  if (process.env.DEBUG_FCD) {
    console.log('[Hash] 📋 Previous hashes:', prevHashs.length > 0 ? prevHashs : 'none')
  }
  if (prevHashs.every(hash => hash === curHash)) {
    if (process.env.DEBUG_FCD) {
      console.log('[Layer] ✓ No dependency changes detected, skipping layer update')
    }
    return {
      hash: curHash,
      layers: undefined // 没有变化则返回undefined
    }
  } else {
    if (process.env.DEBUG_FCD) {
      console.log('[Layer] 🔄 Dependency changes detected, updating layer...')
    }
  }
  // 如果依赖发生变化，则创建新的层
  const layerObject = await getOrUploadLayer({
    curHash,
    layerName: params.layerConfig.layerName,
    nodeModulesPath: params.nodeModulesPath,
    ossClient: getOssClient(params.ossConfig),
  })

  if (process.env.DEBUG_FCD) {
    console.log('[Layer] 📦 Layer package info:', layerObject.depFileName)
  }
  const resLayers: Array<string[] | undefined> = []
  // 顺序更新一个函数
  for (let i = 0; i < params.fcConfigs.length; i++) {
    if (prevHashs[i] === curHash) {
      if (process.env.DEBUG_FCD) {
        console.log(`[Function] ✓ ${params.fcConfigs[i].fcFunction} - hash unchanged, skipping update`)
      }
      resLayers.push(undefined) // 没有变化则返回空
      continue
    }
    if (process.env.DEBUG_FCD) {
      console.log(`[Function] 🔄 Updating layer for: ${params.fcConfigs[i].fcFunction}`)
    }
    const layers = await updateLayers({
      curHash: curHash,
      fcConfig: params.fcConfigs[i],
      layerConfig: params.layerConfig,
      ossConfig: params.ossConfig,
      layerObject
    })
    if (process.env.DEBUG_FCD) {
      console.log(`[Function] ✓ ${params.fcConfigs[i].fcFunction} - layer updated successfully (${layers.length} layers)`)
    }
    resLayers.push(layers)
  }
  // 返回所有函数的层信息
  return {
    hash: curHash,
    layers: resLayers
  }

}