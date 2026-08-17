/**
 * tsdown 客户端构建配置：把 src/client.ts 打包为 DSH web2 client bundle。
 *
 * 产物格式（与 DSH 内置客户端插件一致，见 @deepseek-ai/dsh-client-modules）：
 * 调用 window.__ModuleLoader__.load({ id, factory }) 注册惰性工厂；
 * 平台模块（react、cordis 等）走注入的 require（模块表），其余依赖全部内联。
 * 输出到 lib/client.js，由包清单 exports["./client"] 暴露，
 * dsh-client-modules 宿主侧据此构建 boot 图并经 /plugins 提供。
 */
import type { UserConfig } from 'tsdown'

/** 浏览器端共享平台模块表（shell 冻结模块表，须与 dsh-client-web 一致）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/**
 * bundle 注册 id：默认 = npm 包名；热部署别名场景（免重启加载新构建、
 * 绕开 Node 模块缓存与 client-modules 的包名元数据缓存）通过
 * DSH_CLIENT_BUNDLE_ID 覆盖，须与 loader 行名一致。
 */
const ID = process.env.DSH_CLIENT_BUNDLE_ID ?? 'dsh-cache-cost-monitor'

export default {
  name: `${ID}/client`,
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // 平台模块保持 external；其余（如有）一律内联——模块表之外不允许 require。
  noExternal: (id: string) => (PLATFORM_MODULES.includes(id as (typeof PLATFORM_MODULES)[number]) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig
