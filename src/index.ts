import { UpdateFunctionRequest, Code } from '@alicloud/fc-open20210406'
import { IFcConfig, ILayerConfig, IOssConfig } from './types'
import { compressCodeToBase64, getFcClient } from './utils'
import { setupLayers } from './helpers'


export async function deploy(params: {
  /** 项目名称 */
  name: string
  /** 需要压缩的代码目录。比如一般构建结果都是在dist目录，如果不传入这个参数，默认是cwd里的dist目录 */
  distPath?: string
  /** 支持传入log回调，可以将过程中的log显示出来 */
  cbLog?: (msg: string) => void
  /** 函数计算服务的配置。注意这里支持配置数组，意思是同一份代码支持部署到不同的函数计算中。可以做到同时部署。 */
  fcConfigs: IFcConfig[]
  /** 层文件存储的oss桶 */
  ossConfig: IOssConfig
  /** 层的设置。 */
  layerConfig: ILayerConfig
  /** 可选：自定义 node_modules 路径，默认使用 cwd/node_modules */
  nodeModulesPath?: string
}) {
  // 将源码压缩成base64
  const codeBase64 = await compressCodeToBase64({
    distPath: params.distPath
  })
  // 检测层是否需要更新
  const fcLayers = await setupLayers({
    fcConfigs: params.fcConfigs,
    ossConfig: params.ossConfig,
    layerConfig: params.layerConfig,
    nodeModulesPath: params.nodeModulesPath,
  })
  const updateFunctionReq = new UpdateFunctionRequest({
    code: new Code({
      zipFile: codeBase64
    }),
  })
  const deployResults: UpdateFunctionRequest[] = []
  // 顺序部署各个函数
  for (let i = 0; i < params.fcConfigs.length; i++) {
    const fcConfig = params.fcConfigs[i]
    if (process.env.DEBUG_FCD) {
      console.log(`\n[Deploy] 🚀 Deploying function: ${fcConfig.fcFunction} (${i + 1}/${params.fcConfigs.length})`)
    }
    // 获取当前函数的层
    const layers = fcLayers.layers?.[i]
    if (layers) {
      updateFunctionReq.layers = layers
    }
    // 部署函数
    const fcClient = getFcClient(fcConfig)
    if (!fcClient) {
      throw new Error('无法获取FC客户端，请检查阿里云配置是否正确')
    }
    const deployResult = await fcClient.updateFunction(
      fcConfig.fcService,
      fcConfig.fcFunction,
      updateFunctionReq
    )
    const msgs = [
      `### ${fcConfig.fcService}/${fcConfig.fcFunction} 部署成功!  `,
      `statusCode: ${deployResult.statusCode}  `,
      `codeSize: ${deployResult.body?.codeSize ? (deployResult.body.codeSize / 1000 + 'KB') : 'n/a'}  `,
      `cpu: ${deployResult.body?.cpu || 'n/a'}  `,
      `memory: ${deployResult.body?.memorySize || 'n/a'} MB  `
    ]
    if (process.env.DEBUG_FCD) {
      console.log('[Deploy] ✓ Deployment result:')
      console.log(msgs.join('\n'))
    }
    if (params.cbLog) {
      params.cbLog(msgs.join('\n'))
    }
    // 更新package hash
    if (layers) {
      await params.layerConfig.setHash({
        funcName: `${fcConfig.fcService}-${fcConfig.fcFunction}`,
        hash: fcLayers.hash
      })
      if (process.env.DEBUG_FCD) {
        console.log(`[Deploy] 💾 Saved new hash for ${fcConfig.fcFunction}: ${fcLayers.hash}`)
      }
    }
    deployResults.push(deployResult)
  }
  return deployResults
}