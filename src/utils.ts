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
 * 传入多个 package.json 的地址，提取每个文件中与运行时相关的依赖字段
 * （dependencies、peerDependencies、optionalDependencies）生成 hash，
 * 用于判断实际依赖内容是否发生变化。
 *
 * 刻意排除的字段：
 *   - version：宿主项目版本号与依赖内容无关，版本号变更不应触发 layer 重建
 *   - devDependencies：开发依赖不进入生产 layer
 *   - 其他非依赖字段（name、scripts 等）
 */
export async function getPackageDepsHash(paths: string[]) {
  const depFields = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

  const fileHashes = await Promise.all(
    paths
      .slice()
      .sort()
      .map(async p => {
        const content = await fs.promises.readFile(p, 'utf8')
        const pkg = JSON.parse(content) as Record<string, unknown>
        // 只取依赖相关字段，key 排序保证 JSON 序列化结果稳定
        const depsOnly: Record<string, unknown> = {}
        for (const field of depFields) {
          const val = pkg[field]
          if (val && typeof val === 'object') {
            depsOnly[field] = Object.fromEntries(
              Object.entries(val as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))
            )
          }
        }
        return JSON.stringify(depsOnly)
      })
  )

  return md5(fileHashes.join('\n'))
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
    console.log('[Code] 📦 Compressing code from:', distPath)
  }
  const targetPath = path.resolve(process.cwd(), 'code.zip')
  if (process.env.DEBUG_FCD) {
    console.log('[Code] 📝 Target zip file:', targetPath)
  }
  if (process.env.DEBUG_FCD) {
    console.log('[Code] 🔄 Compressing code files...')
  }
  await zip(distPath, targetPath)
  if (process.env.DEBUG_FCD) {
    console.log('[Code] ✓ Compression complete!')
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