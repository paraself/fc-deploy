import path from 'path'
import { zip } from 'zip-a-folder'
import fs from 'fs'
import crypto from 'crypto'
import FcClient from '@alicloud/fc-open20210406'
import { Config as AliConfig } from '@alicloud/openapi-client'
import AliOSS from 'ali-oss'
import { IOssConfig, IFcConfig } from './types'


const FC_CLIENTS: { [key: string]: FcClient | undefined } = {}

export function getFcClient(params: IFcConfig) {
  if (!FC_CLIENTS[params.accessKeyId]) {
    FC_CLIENTS[params.accessKeyId] = new FcClient(new AliConfig({
      // 必填，您的 AccessKey ID
      accessKeyId: params.accessKeyId,
      // 必填，您的 AccessKey Secret
      accessKeySecret: params.accessKeySecret,
      // 必填，函数计算服务的endpoint
      endpoint: params.fcEndpoint,
      // 必填，函数计算服务的regionId
      regionId: params.fcRegionId
    }))
  }
  return FC_CLIENTS[params.accessKeyId]
}

const OSS_CLIENTS: { [key: string]: AliOSS | undefined } = {}

export function getOssClient(params: IOssConfig) {
  if (!OSS_CLIENTS[params.accessKeyId]) {
    OSS_CLIENTS[params.accessKeyId] = new AliOSS({
      accessKeyId: params.accessKeyId,
      accessKeySecret: params.accessKeySecret,
      bucket: params.bucket,
      region: params.region,
    })
  }
  return OSS_CLIENTS[params.accessKeyId] as AliOSS
}




// https://medium.com/@chris_72272/what-is-the-fastest-node-js-hashing-algorithm-c15c1a0e164e
export function md5(content: string) {
  return crypto.createHash('md5').update(content).digest('hex')
}

/**
 * 传入多个package.json的地址，将每个文件的完整内容排序后生成hash，并包含当前项目版本号，以便判断依赖文件或版本是否发生变化
 */
export async function getPackageDepsHash(paths: string[]) {
  const projectPkgPath = path.resolve(process.cwd(), 'package.json')
  const projectPkgContent = await fs.promises.readFile(projectPkgPath, 'utf8')
  const projectVersion = (JSON.parse(projectPkgContent).version as string | undefined) || ''

  const fileContents = await Promise.all(
    paths
      .slice()
      .sort()
      .map(async p => {
        const content = await fs.promises.readFile(p, 'utf8')
        return content.replace(/\r\n/g, '\n') // normalize newlines for stable hashing
      })
  )

  const combinedContent = [projectVersion, ...fileContents].join('\n')
  return md5(combinedContent)
}

/**
 * 将当前代码目录里的文件，打包压缩成zip文件，并返回其base64编码。
 */
export async function compressCodeToBase64(params?: {
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
 * 判断一个oss对象是否存在
 */
export async function isObjectExist(params: { client: AliOSS, objectName: string, options?: {} }) {
  try {
    await params.client.head(params.objectName, params.options || {})
    // console.log('对象存在')
    return true
  } catch (error) {
    if ((error as any).code === 'NoSuchKey') {
      return false
    } else {
      throw error // 处理其他异常如网络错误
    }
  }
}

export function removePrecedingSlash(str: string) {
  if (str.startsWith("/")) {
    return str.substring(1)
  } else {
    return str
  }
}